const axios = require('axios');
const config = require('../config/config');

// Fallback in-memory storage when GAS is unavailable
const fallbackStore = {
  Admins: [],
  Students: [],
  Codes: [],
  Units: [],
  Exams: [],
  Attempts: [],
  Questions: [],
  Videos: [],
  VideoProgress: [],
  Settings: [],
  Books: [],
  Notifications: []
};

let gasAvailable = true;
let lastGasError = null;

/**
 * Every call to Google Sheets/Drive goes through this single function.
 * The Apps Script Web App is the only thing that ever touches the sheet.
 */
async function callGas(action, payload = {}) {
  if (!config.gas.endpointUrl) {
    throw new Error('GAS_ENDPOINT_URL is not configured in .env');
  }

  const response = await axios.post(
    config.gas.endpointUrl,
    { apiKey: config.gas.apiKey, action, payload },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const body = response.data;
  if (!body.ok) {
    throw new Error(body.error || 'Unknown Google Apps Script error');
  }
  return body.data;
}

// ---------- Generic table helpers ----------
const getAll = (table) => callGas('getAll', { table });
const getById = (table, id) => callGas('getById', { table, id });
const find = (table, match) => callGas('find', { table, match });
const insert = (table, record) => callGas('insert', { table, record });
const update = (table, id, patch) => callGas('update', { table, id, patch });
const remove = (table, id) => callGas('delete', { table, id });

// ---------- Specialized actions ----------
const getAdminByUsername = (username) => callGas('getAdminByUsername', { username });
const countAdmins = () => callGas('countAdmins');
const insertAdmin = (record) => callGas('insertAdmin', { record });
const getStudentByCode = (code) => callGas('getStudentByCode', { code });
const uploadFile = (payload) => callGas('uploadFile', payload);
const deleteFile = (fileId) => callGas('deleteFile', { fileId });
const generateCodes = (unitId, count, prefix) => callGas('generateCodes', { unitId, count, prefix });
const getSettings = () => callGas('getSettings');
const updateSetting = (key, value) => callGas('updateSetting', { key, value });

// Fallback handler when GAS is unavailable
function handleFallback(action, table, payload) {
  const store = fallbackStore[table] || [];
  if (action === 'getAll') return { ok: true, data: store };
  if (action === 'getById') {
    const item = store.find(x => x.id === payload.id);
    return item ? { ok: true, data: item } : { ok: false, error: 'Not found' };
  }
  if (action === 'find') {
    const keys = Object.keys(payload);
    const results = store.filter(x => keys.every(k => x[k] == payload[k]));
    return { ok: true, data: results };
  }
  if (action === 'insert') {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const item = { id, ...payload, createdAt: new Date().toISOString() };
    store.push(item);
    return { ok: true, data: item };
  }
  if (action === 'update') {
    const idx = store.findIndex(x => x.id === payload.id);
    if (idx === -1) return { ok: false, error: 'Not found' };
    store[idx] = { ...store[idx], ...payload, updatedAt: new Date().toISOString() };
    return { ok: true, data: store[idx] };
  }
  if (action === 'delete') {
    const idx = store.findIndex(x => x.id === payload.id);
    if (idx === -1) return { ok: false, error: 'Not found' };
    store.splice(idx, 1);
    return { ok: true };
  }
  return { ok: false, error: 'Unsupported fallback action' };
}

// Helper to check if GAS is working
function isGasAvailable() { return gasAvailable; }
function getLastGasError() { return lastGasError; }

module.exports = {
  callGas, getAll, getById, find, insert, update, remove,
  getAdminByUsername, countAdmins, insertAdmin, getStudentByCode, uploadFile, deleteFile,
  generateCodes, getSettings, updateSetting
};
