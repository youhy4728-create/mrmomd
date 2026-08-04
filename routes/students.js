const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/me', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  res.json({ ok: true, data: student });
}));

router.get('/me/units', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  const allUnits = await gas.getAll('Units');
  const unlocked = allUnits.filter((u) => unitIds.includes(u.id) && u.status === 'published');
  res.json({ ok: true, data: unlocked });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const students = await gas.getAll('Students');
  res.json({ ok: true, data: students });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  res.json({ ok: true, data: student });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await gas.update('Students', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Student not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await gas.remove('Students', req.params.id);
  res.json({ ok: true, data: result });
}));

// Grant/revoke access to a unit without needing a fresh code
router.post('/:id/units/:unitId/grant', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  const ids = new Set((student.unitIds || '').split(',').filter(Boolean));
  ids.add(req.params.unitId);
  const updated = await gas.update('Students', student.id, { unitIds: [...ids].join(',') });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/units/:unitId/revoke', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  const ids = new Set((student.unitIds || '').split(',').filter(Boolean));
  ids.delete(req.params.unitId);
  const updated = await gas.update('Students', student.id, { unitIds: [...ids].join(',') });
  res.json({ ok: true, data: updated });
}));

module.exports = router;
