const axios = require('axios');
const config = require('../config/config');

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
const getStudentByCode = (code) => callGas('getStudentByCode', { code });
const uploadFile = (payload) => callGas('uploadFile', payload);
const deleteFile = (fileId) => callGas('deleteFile', { fileId });
const generateCodes = (unitId, count, prefix) => callGas('generateCodes', { unitId, count, prefix });
const getSettings = () => callGas('getSettings');
const updateSetting = (key, value) => callGas('updateSetting', { key, value });

module.exports = {
  callGas, getAll, getById, find, insert, update, remove,
  getAdminByUsername, getStudentByCode, uploadFile, deleteFile,
  generateCodes, getSettings, updateSetting
};
