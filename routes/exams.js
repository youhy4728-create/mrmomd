const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const exams = await gas.find('Exams', { unitId: req.params.unitId });
  exams.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: exams.filter((e) => req.user.role === 'admin' || e.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.id);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });

  // Students never receive correctAnswer in the payload
  if (req.user.role === 'student') {
    let questions = await gas.find('Questions', { examId: exam.id });
    if (String(exam.shuffleQuestions) === 'true') questions = shuffle(questions);
    questions = questions.map(({ correctAnswer, ...rest }) => parseQuestionOptions_(rest));
    return res.json({ ok: true, data: { ...exam, questions } });
  }

  const questions = (await gas.find('Questions', { examId: exam.id })).map(parseQuestionOptions_);
  res.json({ ok: true, data: { ...exam, questions } });
}));

// Questions are stored with options/correctAnswer as JSON-stringified text
// (so the sheet cell stays a single string); parse them back into real
// arrays/values before handing them to any frontend.
function parseQuestionOptions_(q) {
  return {
    ...q,
    options: q.options ? safeParseJson_(q.options) : undefined
  };
}

function safeParseJson_(value) {
  try { return JSON.parse(value); } catch (e) { return value; }
}

// POST /api/exams/:id/submit  (student submits exam answers directly by examId)
router.post('/:id/submit', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const examId = req.params.id;
  const { answers, timeTaken } = req.body;

  const exam = await gas.getById('Exams', examId);
  if (!exam || exam.status !== 'published') {
    return res.status(404).json({ ok: false, error: 'Exam not found or not published' });
  }

  // Check max attempts
  const priorAttempts = await gas.find('Attempts', { examId, studentId: req.user.id });
  const maxAttempts = parseInt(exam.maxAttempts, 10) || 1;
  if (priorAttempts.length >= maxAttempts) {
    return res.status(403).json({ ok: false, error: 'Maximum attempts reached' });
  }

  // Grade first (this only reads, and reads are cached/fast), then insert
  // the attempt already-graded in a single write. The old version did an
  // insert followed by a separate update — two write-lock round trips per
  // submission. Cutting that to one write roughly doubles how many
  // students can submit at the same moment (e.g. right as a timer ends).
  const questions = await gas.find('Questions', { examId });
  const { gradeAttempt } = require('../utils/grading');
  const graded = gradeAttempt(questions, answers || {}, exam);

  const attempt = await gas.insert('Attempts', {
    examId,
    studentId: req.user.id,
    attemptNumber: priorAttempts.length + 1,
    answers: JSON.stringify(answers || {}),
    score: graded.score,
    maxScore: graded.maxScore,
    percentage: graded.percentage,
    passed: graded.passed,
    startTime: new Date(Date.now() - (timeTaken || 0) * 60000).toISOString(),
    finishTime: new Date().toISOString(),
    durationSeconds: (timeTaken || 0) * 60,
    status: 'completed',
    needsManualGrading: graded.needsManualGrading
  });

  const updated = attempt;

  // Calculate rank among all attempts for this exam
  const allAttempts = await gas.find('Attempts', { examId, status: 'completed' });
  const ranked = allAttempts
    .map((a) => ({ id: a.id, percentage: parseFloat(a.percentage) || 0 }))
    .sort((a, b) => b.percentage - a.percentage);
  const rank = ranked.findIndex((r) => r.id === attempt.id) + 1;

  // Return format expected by student frontend
  res.json({
    score: Math.round(graded.percentage),
    rank,
    timeTaken: timeTaken || 0,
    passed: graded.passed
  });
}));

// GET /api/exams?courseId=xxx  (student sees exams for a specific unit)
router.get('/', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { courseId } = req.query;
  if (!courseId) {
    return res.status(400).json({ ok: false, error: 'courseId is required' });
  }

  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  if (!unitIds.includes(courseId)) {
    return res.status(403).json({ ok: false, error: 'Access denied' });
  }

  const exams = await gas.find('Exams', { unitId: courseId });
  const attempts = await gas.find('Attempts', { studentId: req.user.id });

  const enriched = exams.map((e) => {
    const sAttempts = attempts.filter((a) => a.examId === e.id && a.status === 'completed');
    const lastAttempt = sAttempts.sort((a, b) => new Date(b.finishTime) - new Date(a.finishTime))[0];
    return {
      id: e.id,
      title: e.title,
      questionCount: (e.questionIds || '').split(',').filter(Boolean).length,
      duration: e.timerMinutes || 0,
      type: e.type || 'متعدد',
      available: true,
      completed: sAttempts.length > 0,
      score: lastAttempt ? Math.round(parseFloat(lastAttempt.percentage) || 0) : null,
      result: lastAttempt ? { score: Math.round(parseFloat(lastAttempt.percentage) || 0) } : null
    };
  });

  res.json({ exams: enriched });
}));

// GET /api/exams/admin/all  (admin: flat list of every exam, for filters/dropdowns)
router.get('/admin/all', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const exams = await gas.getAll('Exams');
  res.json({ ok: true, data: exams });
}));

router.use(requireAuth, requireRole('admin'));

router.post('/', asyncHandler(async (req, res) => {
  const {
    unitId, title, description, timerMinutes, maxAttempts, passingScore,
    shuffleQuestions, negativeMarking, negativeMarkValue, order
  } = req.body;
  if (!unitId || !title) return res.status(400).json({ ok: false, error: 'unitId and title are required' });

  const exam = await gas.insert('Exams', {
    unitId, title, description: description || '',
    timerMinutes: timerMinutes || 0, maxAttempts: maxAttempts || 1,
    passingScore: passingScore || 50, shuffleQuestions: !!shuffleQuestions,
    negativeMarking: !!negativeMarking, negativeMarkValue: negativeMarkValue || 0,
    status: 'draft', order: order || 0
  });
  res.status(201).json({ ok: true, data: exam });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await gas.update('Exams', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Exam not found' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await gas.update('Exams', req.params.id, { status: 'published' }) });
}));

router.post('/:id/hide', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await gas.update('Exams', req.params.id, { status: 'hidden' }) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const questions = await gas.find('Questions', { examId: req.params.id });
  await Promise.all(questions.map((q) => gas.remove('Questions', q.id)));
  const result = await gas.remove('Exams', req.params.id);
  res.json({ ok: true, data: result });
}));

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

module.exports = router;
