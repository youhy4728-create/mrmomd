const express = require('express');
const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { signAccessToken, signRefreshToken, verifyRefreshToken, requireAuth, requireRole } = require('../middleware/auth');
const config = require('../config/config');

const router = express.Router();

/**
 * Bootstraps the very first admin account if the Admins sheet is empty.
 * This lets the teacher log in the first time without anyone manually
 * editing the spreadsheet.
 */
async function ensureBootstrapAdmin() {
  const adminCount = await gas.countAdmins();
  if (adminCount > 0) return;
  const passwordHash = await bcrypt.hash(config.bootstrapAdmin.password, 10);
  await gas.insertAdmin({
    username: config.bootstrapAdmin.username,
    passwordHash,
    name: config.bootstrapAdmin.name,
    role: 'admin'
  });
}

/**
 * A Codes row with no unitId is a general-access code: it should unlock
 * every currently published course, not just one. This is re-resolved on
 * every login (not just the first) so a general code also unlocks any
 * course published after the student first signed in.
 */
async function resolveGrantedUnitIds(codeRecord) {
  if (codeRecord.unitId) return [codeRecord.unitId];
  const units = await gas.find('Units', { status: 'published' });
  return units.map((u) => u.id);
}

async function loginOrCreateStudent(codeRecord, name, phone) {
  const grantedUnitIds = await resolveGrantedUnitIds(codeRecord);
  const existingByCode = (await gas.find('Students', { code: codeRecord.code }))[0];

  let student;
  if (existingByCode) {
    const currentUnitIds = new Set((existingByCode.unitIds || '').split(',').filter(Boolean));
    grantedUnitIds.forEach((id) => currentUnitIds.add(id));
    student = await gas.update('Students', existingByCode.id, {
      unitIds: [...currentUnitIds].join(','),
      lastLoginAt: new Date().toISOString()
    });
  } else {
    student = await gas.insert('Students', {
      name,
      phone: phone || '',
      code: codeRecord.code,
      unitIds: grantedUnitIds.join(','),
      lastLoginAt: new Date().toISOString()
    });
  }

  if (codeRecord.status !== 'active') {
    await gas.update('Codes', codeRecord.id, {
      status: 'active',
      studentId: student.id,
      studentName: student.name,
      activationDate: new Date().toISOString()
    });
  }

  return student;
}

// POST /api/auth/admin/login
router.post('/admin/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  await ensureBootstrapAdmin();

  const admin = await gas.getAdminByUsername(username);
  if (!admin) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const userPayload = { id: admin.id, username: admin.username, name: admin.name, role: 'admin' };
  const accessToken = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  res.json({ ok: true, data: { accessToken, refreshToken, user: userPayload } });
}));

// POST /api/auth/change-password  { currentPassword, newPassword }  (admin only)
router.post('/change-password', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'كلمة المرور الجديدة لازم تكون 8 حروف على الأقل' });
  }

  const admin = await gas.getAdminByUsername(req.user.username);
  if (!admin) return res.status(404).json({ ok: false, error: 'Admin not found' });

  const valid = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'كلمة المرور الحالية غلط' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await gas.updateAdminPassword(admin.id, passwordHash);

  res.json({ ok: true, data: { changed: true } });
}));

// POST /api/auth/student/login  { code, name, phone }
router.post('/student/login', asyncHandler(async (req, res) => {
  const { code, name, phone } = req.body;
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'code and name are required' });
  }

  const codeRecord = (await gas.find('Codes', { code: code.trim().toUpperCase() }))[0];
  if (!codeRecord) return res.status(401).json({ ok: false, error: 'Invalid code' });

  const student = await loginOrCreateStudent(codeRecord, name, phone);

  const userPayload = { id: student.id, name: student.name, code: student.code, role: 'student' };
  const accessToken = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  res.json({ ok: true, data: { accessToken, refreshToken, user: userPayload } });
}));

// POST /api/auth/refresh { refreshToken }
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ ok: false, error: 'refreshToken required' });
  try {
    const payload = verifyRefreshToken(refreshToken);
    const { iat, exp, ...userPayload } = payload;
    const accessToken = signAccessToken(userPayload);
    res.json({ ok: true, data: { accessToken } });
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid refresh token' });
  }
}));

// ========== FRONTEND COMPATIBILITY ALIASES ==========
// The Vercel frontends call these exact paths.

// POST /api/auth/login  (admin login alias)
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  await ensureBootstrapAdmin();

  const admin = await gas.getAdminByUsername(username);
  if (!admin) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const userPayload = { id: admin.id, username: admin.username, name: admin.name, role: 'admin' };
  const token = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  // Return format expected by the Vercel admin frontend
  res.json({ token, user: userPayload, refreshToken });
}));

// POST /api/auth/student-login  (student login alias)
router.post('/student-login', asyncHandler(async (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'code and name are required' });
  }

  const codeRecord = (await gas.find('Codes', { code: code.trim().toUpperCase() }))[0];
  if (!codeRecord) return res.status(401).json({ ok: false, error: 'Invalid code' });

  const student = await loginOrCreateStudent(codeRecord, name, '');

  const userPayload = { id: student.id, name: student.name, code: student.code, role: 'student' };
  const token = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  // Return format expected by the Vercel student frontend
  res.json({ token, user: userPayload, refreshToken });
}));

module.exports = router;
