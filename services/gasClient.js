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

// ---------- Short-lived read cache ----------
// Google Sheets reads go through Apps Script and are the slowest part of
// every page load (roughly 1-3s per call, regardless of how simple the
// read is). Two things matter when many students hit the site together:
//
// 1. STALE-WHILE-REVALIDATE: once a value has been fetched once, we keep
//    serving it instantly even after it "expires" while a background
//    refresh quietly replaces it — nobody ever waits on Apps Script for
//    data that's only a few seconds out of date.
// 2. REQUEST COALESCING: if 100 students ask for the same thing (e.g. the
//    published course list) at the same moment and nothing is cached yet,
//    only ONE request actually goes to Apps Script — everyone else waits
//    on that same in-flight promise instead of firing 100 separate calls
//    and hammering the sheet (and Apps Script's execution quota) at once.
const READ_CACHE_FRESH_MS = 20000;   // serve instantly, no network call at all
const READ_CACHE_STALE_MS = 120000;  // serve instantly but refresh quietly in the background
const readCache = new Map();  // key -> { value, cachedAt }
const inFlight = new Map();   // key -> Promise (de-dupes concurrent identical requests)
const READ_ACTIONS = new Set([
  'getAll', 'getById', 'find', 'getAdminByUsername', 'countAdmins',
  'getStudentByCode', 'getSettings'
]);

function cacheKey(action, payload) {
  return action + ':' + JSON.stringify(payload || {});
}

function clearReadCache() {
  readCache.clear();
  // Deliberately leave `inFlight` alone — requests already in flight still
  // need to resolve to whoever is awaiting them.
}

async function fetchFromGas_(action, payload) {
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

/**
 * Every call to Google Sheets/Drive goes through this single function.
 * The Apps Script Web App is the only thing that ever touches the sheet.
 */
async function callGas(action, payload = {}) {
  if (!config.gas.endpointUrl) {
    throw new Error('GAS_ENDPOINT_URL is not configured in .env');
  }

  const isRead = READ_ACTIONS.has(action);
  if (!isRead) {
    // Writes always go straight through, then invalidate every cached
    // read so nobody sees stale data after a change.
    const data = await fetchFromGas_(action, payload);
    clearReadCache();
    return data;
  }

  const key = cacheKey(action, payload);
  const cached = readCache.get(key);
  const now = Date.now();

  if (cached) {
    const age = now - cached.cachedAt;
    if (age < READ_CACHE_FRESH_MS) {
      return cached.value; // fully fresh — instant, no network call
    }
    if (age < READ_CACHE_STALE_MS) {
      // Stale but usable: hand back the cached value immediately, and
      // kick off (at most one) background refresh for next time.
      if (!inFlight.has(key)) {
        const refresh = fetchFromGas_(action, payload)
          .then((data) => { readCache.set(key, { value: data, cachedAt: Date.now() }); return data; })
          .catch(() => {}) // a failed background refresh just keeps serving the old value
          .finally(() => inFlight.delete(key));
        inFlight.set(key, refresh);
      }
      return cached.value;
    }
    // Older than the stale window — fall through to a real, blocking fetch.
  }

  // Nothing usable cached: dedupe concurrent identical requests so a burst
  // of simultaneous students only triggers one real Apps Script call.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }
  const request = fetchFromGas_(action, payload)
    .then((data) => { readCache.set(key, { value: data, cachedAt: Date.now() }); return data; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
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
const updateAdminPassword = (id, passwordHash) => callGas('updateAdminPassword', { id, passwordHash });
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
  getAdminByUsername, countAdmins, insertAdmin, updateAdminPassword, getStudentByCode, uploadFile, deleteFile,
  generateCodes, getSettings, updateSetting
};
