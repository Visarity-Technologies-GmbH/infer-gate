import { Router } from 'express';
import { fail } from '../errors.js';

const validId = value => {
  if (!/^[1-9]\d{0,18}$/.test(String(value))) fail(400, 'invalid_id', 'Invalid identifier');
  return String(value);
};
function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'description', 'entries'].includes(key))) fail(400, 'invalid_input', 'Invalid model alias');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255) fail(400, 'invalid_input', 'A name is required');
  if (body.description != null && (typeof body.description !== 'string' || body.description.length > 10000)) fail(400, 'invalid_input', 'Invalid description');
  if (!Array.isArray(body.entries) || body.entries.length > 500) fail(400, 'invalid_input', 'Use at most 500 model mappings');
  const seen = new Set();
  const entries = body.entries.map(entry => {
    if (!entry || typeof entry.model_alias !== 'string' || !entry.model_alias.trim() || entry.model_alias.length > 255 || typeof entry.model_upstream !== 'string' || !entry.model_upstream.trim() || entry.model_upstream.length > 255) fail(400, 'invalid_input', 'Each mapping needs an alias and upstream model');
    const model_alias = entry.model_alias.trim(), model_upstream = entry.model_upstream.trim();
    const signature = JSON.stringify([model_alias, model_upstream]);
    if (seen.has(signature)) fail(400, 'invalid_input', 'Duplicate model mapping');
    seen.add(signature);
    return { model_alias, model_upstream };
  });
  return { name: body.name.trim(), description: body.description || null, entries };
}
export function modelAliasesRouter(db) {
  const router = Router();
  router.get('/model-aliases', async (req, res) => {
    const after = req.query.after === undefined ? '0' : validId(req.query.after);
    const rows = await db.query('SELECT id,name,description,created_at,updated_at FROM model_aliases WHERE id>? ORDER BY id LIMIT 501', [after]);
    res.json({ data: rows.slice(0, 500), next_after: rows.length > 500 ? rows[499].id : null });
  });
  router.get('/model-aliases/:id', async (req, res) => {
    const id = validId(req.params.id);
    const [alias] = await db.query('SELECT id,name,description,created_at,updated_at FROM model_aliases WHERE id=?', [id]);
    if (!alias) fail(404, 'not_found', 'Record not found');
    alias.entries = await db.query('SELECT id,model_alias_id,model_alias,model_upstream,created_at,updated_at FROM model_alias_entries WHERE model_alias_id=? ORDER BY id', [id]);
    res.json(alias);
  });
  router.post('/model-aliases', async (req, res) => {
    const data = parse(req.body);
    const result = await db.transaction(async tx => {
      const inserted = await tx.query('INSERT INTO model_aliases(name,description) VALUES (?,?)', [data.name, data.description]);
      for (const entry of data.entries) await tx.query('INSERT INTO model_alias_entries(model_alias_id,model_alias,model_upstream) VALUES (?,?,?)', [inserted.insertId, entry.model_alias, entry.model_upstream]);
      return inserted.insertId;
    });
    res.status(201).json({ id: result });
  });
  router.put('/model-aliases/:id', async (req, res) => {
    const id = validId(req.params.id), data = parse(req.body);
    await db.transaction(async tx => {
      const result = await tx.query('UPDATE model_aliases SET name=?,description=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [data.name, data.description, id]);
      if (!result.affectedRows) fail(404, 'not_found', 'Record not found');
      await tx.query('DELETE FROM model_alias_entries WHERE model_alias_id=?', [id]);
      for (const entry of data.entries) await tx.query('INSERT INTO model_alias_entries(model_alias_id,model_alias,model_upstream) VALUES (?,?,?)', [id, entry.model_alias, entry.model_upstream]);
    });
    res.sendStatus(204);
  });
  return router;
}
