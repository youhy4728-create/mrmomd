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
    questions = questions.map(({ correctAnswer, ...rest }) => rest);
    return res.json({ ok: true, data: { ...exam, questions } });
  }

  const questions = await gas.find('Questions', { examId: exam.id });
  res.json({ ok: true, data: { ...exam, questions } });
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
