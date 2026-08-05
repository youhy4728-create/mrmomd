const express = require('express');
const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../middleware/auth');
const config = require('../config/config');

const router = express.Router();

/**
 * Bootstraps the very first admin account if the Admins sheet is empty.
 * This lets the teacher log in the first time without anyone manually
 * editing the spreadsheet.
 */
async function ensureBootstrapAdmin() {
  const admins = await gas.getAll('Admins');
  if (admins.length > 0) return;
  const passwordHash = await bcrypt.hash(config.bootstrapAdmin.password, 10);
  await gas.insert('Admins', {
    username: config.bootstrapAdmin.username,
    passwordHash,
    name: config.bootstrapAdmin.name,
    role: 'admin'
  });
}

// POST /api/auth/admin/login
router.post('/admin/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  await ensureBootstrapAdmin();

  const admin = await getAdminByUsername(username);
  if (!admin) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const userPayload = { id: admin.id, username: admin.username, name: admin.name, role: 'admin' };
  const accessToken = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  res.json({ ok: true, data: { accessToken, refreshToken, user: userPayload } });
}));

// POST /api/auth/student/login  { code, name, phone }
router.post('/student/login', asyncHandler(async (req, res) => {
  const { code, name, phone } = req.body;
  if (!code || !name) {
    return res.status(400).json({ ok: false, error: 'code and name are required' });
  }

  const codeRecord = (await gas.find('Codes', { code: code.trim().toUpperCase() }))[0];
  if (!codeRecord) return res.status(401).json({ ok: false, error: 'Invalid code' });

  let student;
  const existingByCode = (await gas.find('Students', { code: codeRecord.code }))[0];

  if (existingByCode) {
    student = existingByCode;
    const currentUnitIds = (student.unitIds || '').split(',').filter(Boolean);
    if (!currentUnitIds.includes(codeRecord.unitId)) {
      currentUnitIds.push(codeRecord.unitId);
      student = await gas.update('Students', student.id, {
        unitIds: currentUnitIds.join(','),
        lastLoginAt: new Date().toISOString()
      });
    } else {
      student = await gas.update('Students', student.id, { lastLoginAt: new Date().toISOString() });
    }
  } else {
    student = await gas.insert('Students', {
      name,
      phone: phone || '',
      code: codeRecord.code,
      unitIds: codeRecord.unitId,
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

  const admin = await getAdminByUsername(username);
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

  let student;
  const existingByCode = (await gas.find('Students', { code: codeRecord.code }))[0];

  if (existingByCode) {
    student = existingByCode;
    const currentUnitIds = (student.unitIds || '').split(',').filter(Boolean);
    if (!currentUnitIds.includes(codeRecord.unitId)) {
      currentUnitIds.push(codeRecord.unitId);
      student = await gas.update('Students', student.id, {
        unitIds: currentUnitIds.join(','),
        lastLoginAt: new Date().toISOString()
      });
    } else {
      student = await gas.update('Students', student.id, { lastLoginAt: new Date().toISOString() });
    }
  } else {
    student = await gas.insert('Students', {
      name,
      phone: '',
      code: codeRecord.code,
      unitIds: codeRecord.unitId,
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

  const userPayload = { id: student.id, name: student.name, code: student.code, role: 'student' };
  const token = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  // Return format expected by the Vercel student frontend
  res.json({ token, user: userPayload, refreshToken });
}));

module.exports = router;
