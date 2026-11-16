import { Router } from 'express';
import { fail } from '../errors.js';
import { digest, encrypt } from '../security/credentials.js';

export const DEFAULT_CLASSIFICATION_TEMPLATE = '{\n  "prompt": "${PROMPT}"\n}';
const columns = 'id,name,description,api_url,key_fingerprint,CAST(json_template AS CHAR) AS json_template,maxToken,created_at,updated_at';
const identifier = value => {
  if (!/^[1-9]\d{0,18}$/.test(String(value))) fail(400, 'invalid_id', 'Invalid identifier');
  return String(value);
};
function requiredText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_input', `Invalid or missing ${field}`);
  return value;
}
function handlerData(body, partial = false) {
  const schema = {
    name: value => requiredText(value, 'name', 255).trim(),
    description: value => {
      if (value == null || value === '') return null;
      if (typeof value !== 'string' || value.length > 10000) fail(400, 'invalid_input', 'Invalid description');
      return value;
    },
    api_url: value => {
      requiredText(value, 'API URL', 2048);
      let url;
      try { url = new URL(value); } catch { fail(400, 'invalid_url', 'Invalid API URL'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail(400, 'invalid_url', 'Use an HTTP(S) API URL without credentials or a fragment');
      return value;
    },
    api_key: value => {
      requiredText(value, 'API key', 8192);
      if (/[\x00-\x1f\x7f]/.test(value)) fail(400, 'invalid_key', 'Invalid API key');
      return value;
    },
    maxToken: value => {
      if (value == null) return null;
      if (!Number.isInteger(value) || value < 1 || value > 4294967295) fail(400, 'invalid_max_token', 'Max token must be a positive integer or null');
      return value;
    },
    json_template: value => {
      if (value === undefined) return DEFAULT_CLASSIFICATION_TEMPLATE;
      if (typeof value !== 'string' || value.length > 32768) fail(400, 'invalid_json_template', 'JSON template must be valid JSON text (at most 32768 characters)');
      try { JSON.parse(value); } catch { fail(400, 'invalid_json_template', 'JSON template must be valid JSON; quote property names and string values'); }
      return value;
    },
  };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !Object.hasOwn(schema, key))) fail(400, 'invalid_input', 'Expected classification handler fields');
  const data = {};
  for (const [key, validate] of Object.entries(schema)) if (!partial || Object.hasOwn(body, key)) data[key] = validate(body[key]);
  if (!Object.keys(data).length) fail(400, 'invalid_input', 'No fields supplied');
  return data;
}
function sealCredential(data, config) {
  if (data.api_key === undefined) return;
  data.encrypted_api_key = encrypt(data.api_key, config.encryptionKey);
  data.key_fingerprint = digest(data.api_key).slice(0, 16);
  delete data.api_key;
}
export function classificationHandlersRouter(db, config) {
  const router = Router();
  router.get('/classification-handlers', async (req, res) => {
    const after = req.query.after === undefined ? '0' : identifier(req.query.after);
    const data = await db.query(`SELECT ${columns} FROM classification_handlers WHERE id>? ORDER BY id LIMIT 500`, [after]);
    res.json({ data, next_after: data.length === 500 ? data.at(-1).id : null });
  });
  router.post('/classification-handlers', async (req, res) => {
    const data = handlerData(req.body);
    sealCredential(data, config);
    const result = await db.query('INSERT INTO classification_handlers(name,description,api_url,encrypted_api_key,key_fingerprint,json_template,maxToken) VALUES (?,?,?,?,?,?,?)',
      [data.name, data.description, data.api_url, data.encrypted_api_key, data.key_fingerprint, data.json_template, data.maxToken]);
    const { encrypted_api_key, ...safe } = data;
    res.status(201).json({ id: result.insertId, ...safe });
  });
  router.patch('/classification-handlers/:id', async (req, res) => {
    const id = identifier(req.params.id), data = handlerData(req.body, true);
    sealCredential(data, config);
    const result = await db.query(`UPDATE classification_handlers SET ${Object.keys(data).map(key => `${key}=?`).join(',')},updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [...Object.values(data), id]);
    if (!result.affectedRows) fail(404, 'not_found', 'Classification handler not found');
    res.sendStatus(204);
  });
  return router;
}
