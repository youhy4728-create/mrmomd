const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { gradeAttempt } = require('../utils/grading');
const { rankAttempts } = require('../utils/ranking');

const router = express.Router();

// POST /api/attempts/start  { examId }
router.post('/start', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { examId } = req.body;
  const exam = await gas.getById('Exams', examId);
  if (!exam || exam.status !== 'published') {
    return res.status(404).json({ ok: false, error: 'Exam not found or not published' });
  }

  const priorAttempts = await gas.find('Attempts', { examId, studentId: req.user.id });
  const maxAttempts = parseInt(exam.maxAttempts, 10) || 1;
  if (priorAttempts.length >= maxAttempts) {
    return res.status(403).json({ ok: false, error: 'Maximum attempts reached for this exam' });
  }

  const attempt = await gas.insert('Attempts', {
    examId, studentId: req.user.id, attemptNumber: priorAttempts.length + 1,
    answers: '{}', score: 0, maxScore: 0, percentage: 0, passed: false,
    startTime: new Date().toISOString(), finishTime: '', durationSeconds: 0,
    status: 'in_progress', needsManualGrading: false
  });

  res.status(201).json({ ok: true, data: attempt });
}));

// POST /api/attempts/:id/submit  { answers: { [questionId]: answer } }
router.post('/:id/submit', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const attempt = await gas.getById('Attempts', req.params.id);
  if (!attempt || attempt.studentId !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Attempt not found' });
  }
  if (attempt.status !== 'in_progress') {
    return res.status(400).json({ ok: false, error: 'Attempt already submitted' });
  }

  const exam = await gas.getById('Exams', attempt.examId);
  const questions = await gas.find('Questions', { examId: attempt.examId });
  const answers = req.body.answers || {};

  const { score, maxScore, percentage, needsManualGrading } = gradeAttempt(questions, answers, exam);

  const finishTime = new Date();
  const startTime = new Date(attempt.startTime);
  const durationSeconds = Math.max(0, Math.round((finishTime - startTime) / 1000));
  const passed = percentage >= (parseFloat(exam.passingScore) || 0);

  const updated = await gas.update('Attempts', attempt.id, {
    answers: JSON.stringify(answers), score, maxScore, percentage, passed,
    finishTime: finishTime.toISOString(), durationSeconds,
    status: needsManualGrading ? 'submitted' : 'graded', needsManualGrading
  });

  // Update ranking snapshot for this exam (only meaningful once fully graded)
  if (!needsManualGrading) {
    await refreshRankings(attempt.examId);
  }

  // Notify the student
  await gas.insert('Notifications', {
    audience: 'student', studentId: req.user.id,
    title: 'Exam submitted', message: `Your result for "${exam.title}" is ready.`,
    type: 'exam_result', isRead: false
  });
  await gas.insert('Notifications', {
    audience: 'admin', studentId: req.user.id,
    title: 'New exam attempt', message: `${req.user.name} submitted "${exam.title}" — ${percentage}%`,
    type: 'exam_attempt', isRead: false
  });

  res.json({ ok: true, data: updated });
}));

router.get('/my/:examId', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const attempts = await gas.find('Attempts', { examId: req.params.examId, studentId: req.user.id });
  res.json({ ok: true, data: attempts });
}));

router.get('/:id/result', requireAuth, asyncHandler(async (req, res) => {
  const attempt = await gas.getById('Attempts', req.params.id);
  if (!attempt) return res.status(404).json({ ok: false, error: 'Attempt not found' });
  if (req.user.role === 'student' && attempt.studentId !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  res.json({ ok: true, data: attempt });
}));

// Admin: all attempts for an exam
router.get('/exam/:examId', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const attempts = await gas.find('Attempts', { examId: req.params.examId });
  res.json({ ok: true, data: attempts });
}));

// Rankings (leaderboard) — public to logged-in students for their unit's exams
router.get('/exam/:examId/rankings', requireAuth, asyncHandler(async (req, res) => {
  const rankings = await gas.find('Rankings', { examId: req.params.examId });
  rankings.sort((a, b) => (parseFloat(a.rank) || 0) - (parseFloat(b.rank) || 0));

  const students = await gas.getAll('Students');
  const withNames = rankings.map((r) => ({
    ...r,
    studentName: (students.find((s) => s.id === r.studentId) || {}).name || 'Unknown'
  }));

  res.json({ ok: true, data: withNames });
}));

async function refreshRankings(examId) {
  const attempts = await gas.find('Attempts', { examId });
  const ranked = rankAttempts(attempts);

  const existingRankings = await gas.find('Rankings', { examId });
  await Promise.all(existingRankings.map((r) => gas.remove('Rankings', r.id)));

  await Promise.all(ranked.map((r) => gas.insert('Rankings', {
    examId, studentId: r.studentId, attemptId: r.id, score: r.score,
    percentage: r.percentage, durationSeconds: r.duration === Infinity ? 0 : r.duration,
    rank: r.rank, updatedAt: new Date().toISOString()
  })));
}

module.exports = router;
