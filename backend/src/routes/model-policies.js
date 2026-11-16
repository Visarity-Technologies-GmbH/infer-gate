import { Router } from 'express';
import { fail } from '../errors.js';
export const policyId = value => {
  if (!/^[1-9]\d{0,18}$/.test(String(value))) fail(400, 'invalid_id', 'Invalid identifier');
  return String(value);
};
export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 100) fail(400, 'invalid_input', 'Use at most 100 model rules');
  const seen = new Set();
  return rules.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['model_pattern', 'policy'].includes(k)) || typeof row.model_pattern !== 'string' || !row.model_pattern.trim() || row.model_pattern.length > 255 || !['ALLOW', 'DENY'].includes(row.policy)) fail(400, 'invalid_input', 'Use a model name or wildcard pattern and ALLOW or DENY');
    const signature = JSON.stringify([row.model_pattern, row.policy]);
    if (seen.has(signature)) fail(400, 'invalid_input', 'Duplicate model rule');
    seen.add(signature);
    return { model_pattern: row.model_pattern, policy: row.policy };
  });
}
function policyData(body) {
  if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['name', 'description', 'rules'].includes(k)) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255) fail(400, 'invalid_input', 'A policy name is required');
  if (body.description != null && (typeof body.description !== 'string' || body.description.length > 10000)) fail(400, 'invalid_input', 'Invalid description');
  return { name: body.name.trim(), description: body.description || null, rules: validateRules(body.rules) };
}
export async function insertRules(tx, id, rules) {
  for (const rule of rules) await tx.query('INSERT INTO model_policy_rules(model_policy_id,model_pattern,policy) VALUES (?,?,?)', [id, rule.model_pattern, rule.policy]);
}
export const effectivePolicySql = 'SELECT rules.model_policy_id,rules.model_pattern,rules.policy FROM role_model_policies assigned LEFT JOIN model_policy_rules rules ON rules.model_policy_id=assigned.model_policy_id WHERE assigned.role_id=(SELECT role_id FROM proxy_api_keys WHERE id=?)';
export function modelPoliciesRouter(db) {
  const router = Router();
  router.get('/model-policies', async (req, res) => {
    const after = req.query.after === undefined ? '0' : policyId(req.query.after);
    const data = await db.query('SELECT p.*,(SELECT COUNT(*) FROM role_model_policies rp WHERE rp.model_policy_id=p.id) AS assigned_roles FROM model_policies p WHERE p.id>? ORDER BY p.id LIMIT 500', [after]);
    res.json({ data, next_after: data.length === 500 ? data.at(-1).id : null });
  });
  router.get('/model-policies/:id', async (req, res) => {
    const id = policyId(req.params.id);
    const [policy] = await db.query('SELECT * FROM model_policies WHERE id=?', [id]);
    if (!policy) fail(404, 'not_found', 'Model policy not found');
    const rules = await db.query('SELECT model_pattern,policy FROM model_policy_rules WHERE model_policy_id=? ORDER BY id', [id]);
    res.json({ ...policy, rules });
  });
  router.post('/model-policies', async (req, res) => {
    const data = policyData(req.body);
    const id = await db.transaction(async tx => {
      const result = await tx.query('INSERT INTO model_policies(name,description) VALUES (?,?)', [data.name, data.description]);
      await insertRules(tx, result.insertId, data.rules);
      return result.insertId;
    });
    res.status(201).json({ id });
  });
  router.put('/model-policies/:id', async (req, res) => {
    const id = policyId(req.params.id), data = policyData(req.body);
    await db.transaction(async tx => {
      const [existing] = await tx.query('SELECT id FROM model_policies WHERE id=? FOR UPDATE', [id]);
      if (!existing) fail(404, 'not_found', 'Model policy not found');
      await tx.query('UPDATE model_policies SET name=?,description=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [data.name, data.description, id]);
      await tx.query('DELETE FROM model_policy_rules WHERE model_policy_id=?', [id]);
      await insertRules(tx, id, data.rules);
    });
    res.sendStatus(204);
  });
  return router;
}
