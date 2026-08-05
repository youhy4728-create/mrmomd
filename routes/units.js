const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/units?courseId=xxx  (student course detail + lessons)
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { courseId } = req.query;

  // If courseId is provided, return that specific unit with its content
  if (courseId) {
    const unit = await gas.getById('Units', courseId);
    if (!unit || unit.status !== 'published') {
      return res.status(404).json({ ok: false, error: 'Unit not found' });
    }

    // Students must have access
    if (req.user.role === 'student') {
      const student = await gas.getById('Students', req.user.id);
      const unitIds = (student.unitIds || '').split(',').filter(Boolean);
      if (!unitIds.includes(courseId)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }
    }

    let [videos, exams, presentations] = await Promise.all([
      gas.find('Videos', { unitId: courseId }),
      gas.find('Exams', { unitId: courseId }),
      gas.find('Presentations', { unitId: courseId })
    ]);

    if (req.user.role !== 'admin') {
      videos = videos.filter((v) => v.status === 'published');
      exams = exams.filter((e) => e.status === 'published');
      presentations = presentations.filter((p) => p.status === 'published');
    }
    videos.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
    exams.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
    presentations.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));

    // Mark which videos this student has already finished
    let watchedVideoIds = new Set();
    if (req.user.role === 'student') {
      const progress = await gas.find('VideoProgress', { studentId: req.user.id });
      watchedVideoIds = new Set(progress.filter((p) => p.status === 'finished').map((p) => p.videoId));
    }

    // Build the "units" (lessons) array the accordion actually renders:
    // real video/exam/presentation objects, not counts.
    return res.json({
      id: unit.id,
      title: unit.title,
      description: unit.description || '',
      units: [
        {
          title: unit.title,
          videos: videos.map((v) => ({
            id: v.id,
            title: v.title,
            duration: v.durationSeconds ? Math.round(v.durationSeconds / 60) + ' د' : '',
            watched: watchedVideoIds.has(v.id)
          })),
          presentations: presentations.map((p) => ({
            id: p.id,
            title: p.title,
            slideCount: p.slideCount || 0
          })),
          exams: exams.map((e) => ({ id: e.id, title: e.title }))
        }
      ],
      videos: videos.length,
      exams: exams.length,
      duration: 0,
      students: 0,
      popular: false,
      rating: 0
    });
  }

  // No courseId = admin list all units
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const units = await gas.getAll('Units');
  units.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: units });
}));

// Public list (no auth needed)
router.get('/public', asyncHandler(async (req, res) => {
  const units = await gas.getAll('Units');
  res.json({ ok: true, data: units.filter((u) => u.status === 'published') });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/:id', asyncHandler(async (req, res) => {
  const unit = await gas.getById('Units', req.params.id);
  if (!unit) return res.status(404).json({ ok: false, error: 'Unit not found' });
  res.json({ ok: true, data: unit });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { title, description, order, coverImageUrl } = req.body;
  if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
  const unit = await gas.insert('Units', {
    title, description: description || '', order: order || 0,
    coverImageUrl: coverImageUrl || '', status: 'draft'
  });
  res.status(201).json({ ok: true, data: unit });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await gas.update('Units', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Unit not found' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  const updated = await gas.update('Units', req.params.id, { status: 'published' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/hide', asyncHandler(async (req, res) => {
  const updated = await gas.update('Units', req.params.id, { status: 'hidden' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const original = await gas.getById('Units', req.params.id);
  if (!original) return res.status(404).json({ ok: false, error: 'Unit not found' });

  const copy = await gas.insert('Units', {
    title: original.title + ' (Copy)', description: original.description,
    order: original.order, coverImageUrl: original.coverImageUrl, status: 'draft'
  });

  // Duplicate lessons/videos/books/exams (shallow: videos & books reference the SAME Drive file, no re-upload)
  const [lessons, videos, books, exams] = await Promise.all([
    gas.find('Lessons', { unitId: original.id }),
    gas.find('Videos', { unitId: original.id }),
    gas.find('Books', { unitId: original.id }),
    gas.find('Exams', { unitId: original.id })
  ]);

  await Promise.all(lessons.map((l) => gas.insert('Lessons', { ...stripId(l), unitId: copy.id })));
  await Promise.all(videos.map((v) => gas.insert('Videos', { ...stripId(v), unitId: copy.id })));
  await Promise.all(books.map((b) => gas.insert('Books', { ...stripId(b), unitId: copy.id })));

  for (const exam of exams) {
    const newExam = await gas.insert('Exams', { ...stripId(exam), unitId: copy.id });
    const questions = await gas.find('Questions', { examId: exam.id });
    await Promise.all(questions.map((q) => gas.insert('Questions', { ...stripId(q), examId: newExam.id })));
  }

  res.status(201).json({ ok: true, data: copy });
}));

router.post('/reorder', asyncHandler(async (req, res) => {
  const { orderedIds } = req.body; // array of unit ids in the new order
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ ok: false, error: 'orderedIds must be an array' });
  }
  await Promise.all(orderedIds.map((id, index) => gas.update('Units', id, { order: index })));
  res.json({ ok: true, data: { reordered: orderedIds.length } });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Cascade delete lessons/videos/books/exams/questions belonging to this unit
  const [lessons, videos, books, exams] = await Promise.all([
    gas.find('Lessons', { unitId: req.params.id }),
    gas.find('Videos', { unitId: req.params.id }),
    gas.find('Books', { unitId: req.params.id }),
    gas.find('Exams', { unitId: req.params.id })
  ]);

  await Promise.all(lessons.map((l) => gas.remove('Lessons', l.id)));
  await Promise.all(videos.map((v) => gas.remove('Videos', v.id).then(() => v.driveFileId && gas.deleteFile(v.driveFileId))));
  await Promise.all(books.map((b) => gas.remove('Books', b.id).then(() => b.driveFileId && gas.deleteFile(b.driveFileId))));

  for (const exam of exams) {
    const questions = await gas.find('Questions', { examId: exam.id });
    await Promise.all(questions.map((q) => gas.remove('Questions', q.id)));
    await gas.remove('Exams', exam.id);
  }

  const result = await gas.remove('Units', req.params.id);
  res.json({ ok: true, data: result });
}));

function stripId(obj) {
  const { id, ...rest } = obj;
  return rest;
}

module.exports = router;
