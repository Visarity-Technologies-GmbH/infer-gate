import { createDiscoveryCooldown, discoveryTimeout } from "../services/discovery-cooldown.js";
import { Script } from "node:vm";
import { Router } from "express";
import { fail } from "../errors.js";
import { policyId } from "./model-policies.js";
import { DEFAULT_EVALUATION_SCRIPT, validateEvaluationScript, roleWithEvaluationScript } from "../services/evaluation-script.js";
import { modelListRoutes } from "../services/routing.js";
import { filterModelList } from "../services/model-list.js";
import { prepareProviderRequest, executeProviderRequest } from "../providers/index.js";
import { validateCompaction } from "../services/system-prompt-compaction.js";
const optionalScriptFields = ["prompt_script", "input_script", "output_script"];
function optionalScript(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 32768)
    fail(400, "invalid_role_script", `${field} must be JavaScript text (at most 32768 characters)`);
  if (!value.trim()) return null;
  // Compile only; saving must never execute administrator code.
  try { new Script(value); }
  catch { fail(400, "invalid_role_script", `${field} contains invalid JavaScript syntax`); }
  return value;
}
export function roleData(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) => !["name", "description", "model_policy_ids", "status", "classification_handler_id", "evaluation_script", "system_prompt_compaction", "debug_enabled", ...optionalScriptFields].includes(k),
    ) ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 255 ||
    (body.description != null &&
      (typeof body.description !== "string" ||
        body.description.length > 10000)) ||
    !["ACTIVE", "DISABLED"].includes(body.status ?? "ACTIVE")
  )
    fail(
      400,
      "invalid_input",
      "Supply a role name, model policy and valid status",
    );
  if (Object.hasOwn(body, "debug_enabled") && typeof body.debug_enabled !== "boolean")
    fail(400, "invalid_input", "debug_enabled must be a boolean");
  const handlerId = body.classification_handler_id;
  if (handlerId != null && !["string", "number"].includes(typeof handlerId))
    fail(400, "invalid_id", "Invalid classification handler identifier");
  const policyIds = Array.isArray(body.model_policy_ids) ? [...new Set(body.model_policy_ids.map(policyId))] : [];
  if (!policyIds.length || policyIds.length > 100) fail(400, "invalid_input", "Choose between 1 and 100 model policies");
  return [
    body.name.trim(),
    body.description || null,
    policyIds,
    body.status ?? "ACTIVE",
    handlerId == null ? null : policyId(handlerId),
    validateEvaluationScript(body.evaluation_script),
    ...optionalScriptFields.map(field => optionalScript(body[field], field)),
    Object.hasOwn(body, "system_prompt_compaction") ? validateCompaction(body.system_prompt_compaction) : null,
  ];
}
export async function checkManagerRole(tx, manager, roleId) {
  if (!manager || roleId === null) return;
  const [role] = await tx.query("SELECT id FROM roles WHERE id=? AND status='ACTIVE' FOR UPDATE", [roleId]);
  if (!role) fail(409, "role_unavailable", "Choose an active role");
}

export function rolesRouter(db, config = {}, { fetchImpl = fetch, discoveryCooldown = createDiscoveryCooldown() } = {}) {
  const router = Router();
  router.get("/role-options", (req, res) => res.json({ default_evaluation_script: DEFAULT_EVALUATION_SCRIPT }));
  router.get("/roles", async (req, res) => {
    if (req.manager) {
      const statusFilter = req.managerMcp ? "" : "status='ACTIVE' AND ";
      const rows = await db.query(`SELECT id,name,status FROM roles WHERE ${statusFilter}id>? ORDER BY id LIMIT 500`,
        [req.query.after === undefined ? "0" : policyId(req.query.after)]);
      return res.json({ data: rows, next_after: rows.length === 500 ? rows.at(-1).id : null });
    }
    const rows = await db.query(
      "SELECT r.*,(SELECT JSON_ARRAYAGG(rp.model_policy_id) FROM role_model_policies rp WHERE rp.role_id=r.id) AS model_policy_ids,(SELECT COUNT(*) FROM proxy_api_keys k WHERE k.role_id=r.id) AS assigned_keys FROM roles r WHERE r.id>? ORDER BY r.id LIMIT 500",
      [req.query.after === undefined ? "0" : policyId(req.query.after)],
    );
    res.json({
      data: rows.map(roleWithEvaluationScript),
      next_after: rows.length === 500 ? rows.at(-1).id : null,
    });
  });
  router.get("/roles/:id", async (req, res) => {
    const [role] = await db.query("SELECT r.*,(SELECT JSON_ARRAYAGG(rp.model_policy_id) FROM role_model_policies rp WHERE rp.role_id=r.id) AS model_policy_ids FROM roles r WHERE r.id=?", [
      policyId(req.params.id),
    ]);
    if (!role) fail(404, "not_found", "Role not found");
    res.json(roleWithEvaluationScript(role));
  });
  router.get("/roles/:id/models", async (req, res) => {
    const [role] = await db.query("SELECT * FROM roles WHERE id=?", [policyId(req.params.id)]);
    if (!role) fail(404, "not_found", "Role not found");
    if (role.status !== "ACTIVE") fail(409, "role_disabled", "This role is disabled. Enable it to make models available.");
    const assignments = await modelListRoutes(db, role.id);
    const policies = await db.query("SELECT rp.model_policy_id,r.model_pattern,r.policy FROM role_model_policies rp LEFT JOIN model_policy_rules r ON r.model_policy_id=rp.model_policy_id WHERE rp.role_id=?", [role.id]);
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(config.timeout || 15000, 15000))]);
    try {
      const models = new Map();
      let bytes = 0, successful = 0, credentialRejected = false;
      for (const assignment of assignments) {
        const catalogue = await discoveryCooldown(assignment, { signal }, () => {
          const attempt = AbortSignal.any([signal, AbortSignal.timeout(discoveryTimeout(config))]);
          const plan = prepareProviderRequest(assignment, { method: "GET", url: "/models", get: () => undefined }, undefined, config, attempt);
          return executeProviderRequest(plan, fetchImpl);
        }, async upstream => {
          if (!upstream.ok) {
            await upstream.body?.cancel();
            if ([401, 403].includes(upstream.status)) {
              credentialRejected = true;
              return null;
            }
            fail(502, "model_discovery_failed", "Unable to load models from an upstream provider. Check the role’s upstream routing and credentials.");
          }
          return filterModelList(upstream, policies, config.modelDefault);
        });
        if (!catalogue) continue;
        successful++;
        for (const model of catalogue.data) if (!models.has(model.id)) {
          bytes += Buffer.byteLength(model.id);
          if (bytes > 10 * 1024 * 1024) fail(502, "invalid_model_list", "Combined provider model list exceeds the supported size");
          models.set(model.id, { id: model.id });
        }
        const aliases = await db.query(`SELECT DISTINCT entry.model_alias,entry.model_upstream
          FROM role_upstream_model_aliases assigned
          JOIN model_alias_entries entry ON entry.model_alias_id=assigned.model_alias_id
          WHERE assigned.role_upstream_assignment_id=? ORDER BY entry.model_alias`, [assignment.role_upstream_assignment_id]);
        const availableUpstreamModels = new Set(catalogue.data.map(model => model.id));
        for (const alias of aliases) if (availableUpstreamModels.has(alias.model_upstream) && !models.has(alias.model_alias)) {
          bytes += Buffer.byteLength(alias.model_alias);
          if (bytes > 10 * 1024 * 1024) fail(502, "invalid_model_list", "Combined provider model list exceeds the supported size");
          models.set(alias.model_alias, { id: alias.model_alias });
        }
      }
      if (!successful && credentialRejected) fail(502, "model_discovery_failed", "No upstream returned a model list. Check the role’s upstream credentials.");
      if (!successful) fail(503, "model_discovery_unavailable", "Upstream model discovery temporarily unavailable");
      res.json({ data: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) });
    } catch (error) {
      if (["model_discovery_failed", "model_discovery_unavailable", "invalid_model_list"].includes(error.code)) throw error;
      fail(502, "model_discovery_failed", signal.aborted ? "Model discovery timed out or was cancelled." : "Unable to load models. Check the role’s upstream routing and credentials.");
    } finally {
      res.off("close", onClose);
    }
  });
  router.post("/roles", async (req, res) => {
    const data = roleData(req.body);
    if (data[4] !== null && data[5] === null) data[5] = DEFAULT_EVALUATION_SCRIPT;
    const result = await db.query(
      "INSERT INTO roles(name,description,status,classification_handler_id,evaluation_script,prompt_script,input_script,output_script,system_prompt_compaction,debug_enabled) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [data[0], data[1], ...data.slice(3), req.body.debug_enabled ?? false],
    );
    for (const id of data[2]) await db.query("INSERT INTO role_model_policies(role_id,model_policy_id) VALUES (?,?)", [result.insertId, id]);
    res.status(201).json({ id: result.insertId });
  });
  router.put("/roles/:id", async (req, res) => {
    const data = roleData(req.body);
    // Older clients omit this optional field; preserve their existing assignment.
    const hasDebug = Object.hasOwn(req.body, "debug_enabled");
    const hasHandler = Object.hasOwn(req.body, "classification_handler_id");
    const hasScript = Object.hasOwn(req.body, "evaluation_script");
    const suppliedScripts = optionalScriptFields.filter(field => Object.hasOwn(req.body, field));
    const result = await db.transaction(async tx => {
      const result = await tx.query(
      `UPDATE roles SET name=?,description=?,status=?${hasDebug ? ",debug_enabled=?" : ""}${hasHandler ? ",classification_handler_id=?" : ""}${hasScript ? ",evaluation_script=?" : ""}${suppliedScripts.map(field => `,${field}=?`).join("")}${data.at(-1) !== null ? ",system_prompt_compaction=?" : ""},updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
      [data[0], data[1], data[3], ...(hasDebug ? [req.body.debug_enabled] : []), ...(hasHandler ? [data[4]] : []), ...(hasScript ? [data[5]] : []), ...suppliedScripts.map(field => data[6 + optionalScriptFields.indexOf(field)]), ...(data.at(-1) !== null ? [data.at(-1)] : []), policyId(req.params.id)],
      );
      if (result.affectedRows) {
        await tx.query("DELETE FROM role_model_policies WHERE role_id=?", [policyId(req.params.id)]);
        for (const id of data[2]) await tx.query("INSERT INTO role_model_policies(role_id,model_policy_id) VALUES (?,?)", [policyId(req.params.id), id]);
      }
      return result;
    });
    if (!result.affectedRows) fail(404, "not_found", "Role not found");
    res.sendStatus(204);
  });
  router.get("/roles/:id/assignments", async (req, res) =>
    {
      const data = await db.query("SELECT * FROM role_upstream_assignments WHERE role_id=? ORDER BY priority DESC,id", [policyId(req.params.id)]);
      for (const assignment of data) assignment.model_alias_ids = (await db.query("SELECT model_alias_id FROM role_upstream_model_aliases WHERE role_upstream_assignment_id=? ORDER BY model_alias_id", [assignment.id])).map(row => row.model_alias_id);
      res.json({ data });
    },
  );
  router.put("/roles/:id/assignments", async (req, res) => {
    const roleId = policyId(req.params.id),
      seen = new Set();
    if (!Array.isArray(req.body) || req.body.length > 100)
      fail(400, "invalid_input", "Use at most 100 upstream assignments");
    const rows = req.body.map((row) => {
      if (
        !row ||
        Object.keys(row).some(
          (k) => !["upstream_api_key_id", "priority", "status", "model_alias_ids"].includes(k),
        ) ||
        !Number.isInteger(row.priority) ||
        Math.abs(row.priority) > 2147483647 ||
        !["ACTIVE", "DISABLED"].includes(row.status)
      )
        fail(400, "invalid_input", "Invalid upstream assignment");
      const id = policyId(row.upstream_api_key_id);
      if (seen.has(id))
        fail(400, "invalid_input", "Duplicate upstream assignment");
      seen.add(id);
      if (row.model_alias_ids !== undefined && (!Array.isArray(row.model_alias_ids) || row.model_alias_ids.length > 100)) fail(400, "invalid_input", "Choose at most 100 model aliases per assignment");
      const aliasIds = [...new Set((row.model_alias_ids || []).map(policyId))];
      if (aliasIds.length !== (row.model_alias_ids || []).length) fail(400, "invalid_input", "Duplicate model alias selection");
      return { upstreamId: id, priority: row.priority, status: row.status, aliasIds };
    });
    await db.transaction(async (tx) => {
      const [role] = await tx.query(
        "SELECT id FROM roles WHERE id=? FOR UPDATE",
        [roleId],
      );
      if (!role) fail(404, "not_found", "Role not found");
      await tx.query("DELETE FROM role_upstream_model_aliases WHERE role_upstream_assignment_id IN (SELECT id FROM role_upstream_assignments WHERE role_id=?)", [roleId]);
      await tx.query("DELETE FROM role_upstream_assignments WHERE role_id=?", [
        roleId,
      ]);
      for (const row of rows) {
        for (const aliasId of row.aliasIds) {
          const [alias] = await tx.query("SELECT id FROM model_aliases WHERE id=?", [aliasId]);
          if (!alias) fail(400, "invalid_input", "A selected model alias does not exist");
        }
        const inserted = await tx.query(
          "INSERT INTO role_upstream_assignments(role_id,upstream_api_key_id,priority,status) VALUES (?,?,?,?)",
          [roleId, row.upstreamId, row.priority, row.status],
        );
        for (const aliasId of row.aliasIds) await tx.query("INSERT INTO role_upstream_model_aliases(role_upstream_assignment_id,model_alias_id) VALUES (?,?)", [inserted.insertId, aliasId]);
      }
      await tx.query("UPDATE roles SET updated_at=UTC_TIMESTAMP(3) WHERE id=?", [roleId]);
    });
    res.sendStatus(204);
  });
  router.get("/proxy-keys/:id/role", async (req, res) => {
    const [key] = await db.query(
      "SELECT role_id FROM proxy_api_keys WHERE id=?",
      [policyId(req.params.id)],
    );
    if (!key) fail(404, "not_found", "Proxy key not found");
    res.json(key);
  });
  router.put("/proxy-keys/:id/role", async (req, res) => {
    if (
      !req.body ||
      Object.keys(req.body).length !== 1 ||
      !Object.hasOwn(req.body, "role_id")
    )
      fail(400, "invalid_input", "Supply role_id or null");
    const roleId =
      req.body.role_id === null ? null : policyId(req.body.role_id);
    const result = await db.transaction(async tx => {
      await checkManagerRole(tx, req.manager, roleId);
      return tx.query("UPDATE proxy_api_keys SET role_id=? WHERE id=?", [roleId, policyId(req.params.id)]);
    });
    if (!result.affectedRows) fail(404, "not_found", "Proxy key not found");
    res.sendStatus(204);
  });
  for (const path of ["assignments", "policies", "model-policy"])
    router.all(`/proxy-keys/:id/${path}`, () =>
      fail(
        410,
        "role_configuration_required",
        "Configure model policies and upstream assignments on a role, then assign the role to this proxy key",
      ),
    );
  return router;
}
