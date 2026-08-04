const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const VALID_TYPES = ['mcq', 'truefalse', 'multi', 'fillblank', 'essay', 'image'];

router.use(requireAuth, requireRole('admin'));

router.get('/exam/:examId', asyncHandler(async (req, res) => {
  const questions = await gas.find('Questions', { examId: req.params.examId });
  questions.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: questions });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { examId, type, text, imageUrl, options, correctAnswer, points, order } = req.body;
  if (!examId || !type || !text) {
    return res.status(400).json({ ok: false, error: 'examId, type and text are required' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid question type: ' + type });
  }

  const question = await gas.insert('Questions', {
    examId, type, text, imageUrl: imageUrl || '',
    options: options ? JSON.stringify(options) : '',
    correctAnswer: correctAnswer !== undefined ? JSON.stringify(correctAnswer) : '',
    points: points || 1, order: order || 0
  });
  res.status(201).json({ ok: true, data: question });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.options !== undefined) patch.options = JSON.stringify(patch.options);
  if (patch.correctAnswer !== undefined) patch.correctAnswer = JSON.stringify(patch.correctAnswer);
  const updated = await gas.update('Questions', req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'Question not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await gas.remove('Questions', req.params.id);
  res.json({ ok: true, data: result });
}));

// Manually grade an essay/image answer within an attempt
router.post('/:id/manual-grade', asyncHandler(async (req, res) => {
  const { attemptId, pointsAwarded } = req.body;
  const attempt = await gas.getById('Attempts', attemptId);
  if (!attempt) return res.status(404).json({ ok: false, error: 'Attempt not found' });

  const answers = JSON.parse(attempt.answers || '{}');
  const manualGrades = JSON.parse(attempt.manualGrades || '{}');
  manualGrades[req.params.id] = parseFloat(pointsAwarded) || 0;

  const newScore = (parseFloat(attempt.score) || 0) + (parseFloat(pointsAwarded) || 0);
  const stillNeedsGrading = await checkRemainingManualQuestions(attempt.examId, manualGrades);

  const updated = await gas.update('Attempts', attemptId, {
    score: newScore,
    manualGrades: JSON.stringify(manualGrades),
    needsManualGrading: stillNeedsGrading,
    status: stillNeedsGrading ? 'submitted' : 'graded',
    percentage: attempt.maxScore > 0 ? Math.round((newScore / attempt.maxScore) * 10000) / 100 : 0
  });

  res.json({ ok: true, data: updated });
}));

async function checkRemainingManualQuestions(examId, manualGrades) {
  const questions = await gas.find('Questions', { examId });
  const essayOrImage = questions.filter((q) => q.type === 'essay' || q.type === 'image');
  return essayOrImage.some((q) => manualGrades[q.id] === undefined);
}

module.exports = router;
