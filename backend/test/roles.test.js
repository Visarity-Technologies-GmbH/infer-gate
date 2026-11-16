import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { roleData } from "../src/routes/roles.js";
import { createApp } from "../src/app.js";
import { database } from "../src/db/pool.js";
import { digest, encrypt } from "../src/security/credentials.js";
const enabled = process.env.TEST_DB_NAME?.startsWith("infergate_test_");
const options = {
  socketPath: process.env.DB_SOCKET || undefined,
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || "infergate",
  password: process.env.DB_PASSWORD,
};
test("roles require a policy, a name and valid status", () => {
  assert.deepEqual(roleData({ name: " Team ", model_policy_id: 1 }), [
    "Team",
    null,
    "1",
    "ACTIVE",
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  for (const body of [
    null,
    {},
    { name: "x" },
    { name: "x", model_policy_id: null },
    { name: "x", model_policy_id: 1, status: "BAD" },
    { name: "x", model_policy_id: 1, extra: true },
  ])
    assert.throws(() => roleData(body), { status: 400 });
});
test("optional role scripts validate syntax without execution and normalize blank values", () => {
  const base = { name: "Scripts", model_policy_id: 1 };
  for (const [index, field] of ["prompt_script", "input_script", "output_script"].entries()) {
    for (const value of [null, "", "  "])
      assert.equal(roleData({ ...base, [field]: value })[6 + index], null);
    const script = 'throw new Error("must not execute");';
    assert.equal(roleData({ ...base, [field]: script })[6 + index], script);
    for (const value of [true, 1, {}, [], "function {", "x".repeat(32769)])
      assert.throws(() => roleData({ ...base, [field]: value }), { status: 400, code: "invalid_role_script" });
  }
});
test("role administration requires administrator authentication", async (t) => {
  const server = createApp(
    {
      query: async () => {
        throw Error("unexpected database access");
      },
    },
    {},
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  for (const [path, method] of [
    ["roles", "GET"],
    ["roles", "POST"],
    ["roles/1", "PUT"],
    ["roles/1/assignments", "PUT"],
    ["proxy-keys/1/role", "PUT"],
  ])
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${server.address().port}/admin/${path}`, {
          method,
        })
      ).status,
      401,
    );
});
test("role classification assignments are optional, validated and administrator-only", async (t) => {
  const input = { name: "Classification role", model_policy_id: 1 };
  assert.equal(roleData(input)[4], null);
  assert.equal(roleData({ ...input, classification_handler_id: null })[4], null);
  assert.equal(roleData({ ...input, classification_handler_id: 7 })[4], "7");
  for (const value of ["", 0, -1, 1.5, "bad", true, [], [7], {}, "1 OR 1=1"])
    assert.throws(() => roleData({ ...input, classification_handler_id: value }), { status: 400 });

  const roles = [];
  let writes = 0;
  const db = {
    async query(sql, params) {
      if (sql.startsWith("SELECT token_hash"))
        return params[0] === digest("adm_role_classification") ? [{ token_hash: params[0] }] : [];
      if (sql.startsWith("INSERT INTO roles") || sql.startsWith("UPDATE roles SET")) {
        const hasHandler = sql.includes("classification_handler_id");
        const handlerId = hasHandler ? params[4] : undefined;
        if (handlerId != null && !["7", "8"].includes(handlerId))
          throw Object.assign(new Error("Missing related record"), { code: "ER_NO_REFERENCED_ROW_2" });
        const inserting = sql.startsWith("INSERT");
        const row = inserting ? { id: String(roles.length + 1) } : roles.find(r => r.id === params.at(-1));
        if (!row) return { affectedRows: 0 };
        const [name, description, model_policy_id, status] = params;
        Object.assign(row, { name, description, model_policy_id, status });
        if (hasHandler) row.classification_handler_id = handlerId;
        let scriptIndex = 4 + Number(hasHandler) + Number(sql.includes("evaluation_script"));
        for (const field of ["prompt_script", "input_script", "output_script"]) {
          if (sql.includes(field)) row[field] = params[scriptIndex++];
        }
        if (inserting) roles.push(row);
        writes++;
        return inserting ? { insertId: row.id } : { affectedRows: 1 };
      }
      if (sql.startsWith("SELECT r.*")) return roles.filter(r => Number(r.id) > Number(params[0])).map(r => ({ ...r, assigned_keys: 0 }));
      if (sql === "SELECT * FROM roles WHERE id=?") return roles.filter(r => r.id === params[0]);
      throw new Error("Unexpected database operation");
    },
  };
  const server = createApp(db, {}).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (method, body, suffix = "", credential = "adm_role_classification") =>
    fetch(`http://127.0.0.1:${server.address().port}/admin/roles${suffix}`, {
      method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  for (const credential of ["", "pak_test", "adm_invalid"]) {
    assert.equal((await call("POST", { ...input, classification_handler_id: 7 }, "", credential)).status, 401);
    assert.equal((await call("PUT", { ...input, classification_handler_id: 7 }, "/1", credential)).status, 401);
    assert.equal((await call("GET", undefined, "/1", credential)).status, 401);
  }
  assert.equal(writes, 0);
  assert.equal((await call("POST", input)).status, 201);
  assert.equal(roles[0].classification_handler_id, null);
  assert.equal((await call("POST", { ...input, name: "Assigned", classification_handler_id: 7 })).status, 201);
  assert.equal(roles[1].classification_handler_id, "7");
  assert.equal((await call("PUT", { ...input, classification_handler_id: "7" }, "/1")).status, 204);
  assert.equal((await (await call("GET", undefined, "/1")).json()).classification_handler_id, "7");
  // An unrelated update from an older client must not remove the handler.
  assert.equal((await call("PUT", { ...input, name: "Renamed" }, "/1")).status, 204);
  assert.equal(roles[0].classification_handler_id, "7");
  assert.equal((await call("PUT", { ...input, classification_handler_id: 8 }, "/1")).status, 204);
  const before = writes;
  for (const method of ["POST", "PUT"]) {
    const suffix = method === "PUT" ? "/1" : "";
    assert.equal((await call(method, { ...input, classification_handler_id: "invalid" }, suffix)).status, 400);
    assert.equal((await call(method, { ...input, classification_handler_id: 999 }, suffix)).status, 409);
  }
  assert.equal(writes, before);
  assert.equal(roles[0].classification_handler_id, "8");
  assert.equal((await call("PUT", { ...input, classification_handler_id: null }, "/1")).status, 204);
  assert.equal((await (await call("GET", undefined, "/1")).json()).classification_handler_id, null);
  const listed = await (await call("GET")).json();
  assert.equal(listed.data[0].classification_handler_id, null);
  assert.equal(listed.data[1].classification_handler_id, "7");
  assert.equal((await call("PUT", { ...input, classification_handler_id: 7 }, "/999")).status, 404);
  const scripts = { prompt_script: "const prompt = 1;", input_script: "throw new Error('not executed');", output_script: "const output = 3;" };
  assert.equal((await call("POST", { ...input, ...scripts })).status, 201);
  for (const field of Object.keys(scripts)) assert.equal(roles[2][field], scripts[field]);
  assert.equal((await call("PUT", { ...input, ...scripts }, "/1")).status, 204);
  assert.equal((await call("PUT", input, "/1")).status, 204);
  const saved = await (await call("GET", undefined, "/1")).json();
  const list = await (await call("GET")).json();
  for (const field of Object.keys(scripts)) {
    assert.equal(saved[field], scripts[field]);
    assert.equal(list.data[0][field], scripts[field]);
  }
  assert.equal((await call("PUT", { ...input, input_script: null, output_script: "" }, "/1")).status, 204);
  assert.equal(roles[0].prompt_script, scripts.prompt_script);
  assert.equal(roles[0].input_script, null);
  assert.equal(roles[0].output_script, null);
});
test(
  "shared roles revoke access, reject bad assignments atomically and preserve request role history",
  { skip: !enabled },
  async (t) => {
    const db = database({ ...options, database: process.env.TEST_DB_NAME });
    const encryptionKey = randomBytes(32);
    let calls = 0;
    let forwarded;
    const admin = "adm_roles_test";
    await db.query(
      "INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",
      [digest(admin)],
    );
    const server = createApp(
      db,
      { encryptionKey, modelDefault: "ALLOW", bodyLimit: 10000, timeout: 1000 },
      {
        log() {},
        fetchImpl: async (_url, init) => {
          if (init.body) forwarded = JSON.parse(init.body);
          calls++;
          return Response.json({ object: "list", data: [{ id: "model-a" }] });
        },
      },
    ).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await db.close();
    });
    const call = (path, method = "GET", body, auth = admin) =>
      fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const u = await db.query(
      "INSERT INTO users(name,email) VALUES('Role user','roles@test.local')",
    );
    const keys = [];
    for (const name of ["A", "B"])
      keys.push(
        await (
          await call("/admin/proxy-keys", "POST", { name, user_id: u.insertId })
        ).json(),
      );
    assert.equal(
      (await call("/v1/models", "GET", undefined, keys[0].api_key)).status,
      403,
    );
    assert.equal(calls, 0);
    const p = await db.query(
      "INSERT INTO model_policies(name) VALUES('Role behavior policy')",
    );
    const role = await (
      await call("/admin/roles", "POST", {
        name: "Role behavior",
        system_prompt_compaction: { cleanWhitespace: true },
        model_policy_id: p.insertId,
      })
    ).json();
    const scripts = {
      prompt_script: 'function prompt(messages) { return messages; }',
      input_script: 'throw new Error("stored only");',
      output_script: 'const output = "✅";',
    };
    const rolePath = `/admin/roles/${role.id}`;
    const roleBody = { name: "Role behavior", model_policy_id: p.insertId };
    const readScripts = async () => {
      const response = await call(rolePath);
      assert.equal(response.status, 200);
      const row = await response.json();
      return Object.fromEntries(Object.keys(scripts).map(field => [field, row[field]]));
    };
    assert.deepEqual(await readScripts(), { prompt_script: null, input_script: null, output_script: null });
    const created = await call("/admin/roles", "POST", { ...roleBody, name: "Script role", ...scripts });
    assert.equal(created.status, 201);
    const createdId = (await created.json()).id;
    const listing = await (await call("/admin/roles")).json();
    const listed = listing.data.find(row => String(row.id) === String(createdId));
    for (const field of Object.keys(scripts)) assert.equal(listed[field], scripts[field]);
    assert.equal((await call(rolePath, "PUT", { ...roleBody, ...scripts })).status, 204);
    assert.deepEqual(await readScripts(), scripts);
    assert.equal((await call(rolePath, "PUT", roleBody)).status, 204);
    assert.deepEqual(await readScripts(), scripts);
    assert.equal((await call(rolePath, "PUT", { ...roleBody, input_script: "function {" })).status, 400);
    assert.deepEqual(await readScripts(), scripts);
    assert.equal((await call(rolePath, "PUT", { ...roleBody, prompt_script: null, output_script: "" })).status, 204);
    assert.deepEqual(await readScripts(), { prompt_script: null, input_script: scripts.input_script, output_script: null });
    for (const key of keys)
      assert.equal(
        (
          await call(`/admin/proxy-keys/${key.id}/role`, "PUT", {
            role_id: role.id,
          })
        ).status,
        204,
      );
    const [provider] = await db.query(
      "SELECT id FROM llm_inference_providers WHERE name='OpenAI'",
    );
    const up = await db.query(
      "INSERT INTO upstream_api_keys(provider_id,name,encrypted_api_key,key_fingerprint) VALUES (?,?,?,?)",
      [
        provider.id,
        "Role test",
        encrypt("test-secret", encryptionKey),
        "test-role",
      ],
    );
    const assignment = [
      { upstream_api_key_id: up.insertId, priority: 0, status: "ACTIVE" },
    ];
    assert.equal(
      (await call(`/admin/roles/${role.id}/assignments`, "PUT", assignment))
        .status,
      204,
    );
    assert.equal(
      (
        await call(`/admin/roles/${role.id}/assignments`, "PUT", [
          ...assignment,
          { upstream_api_key_id: 9999999, priority: 1, status: "ACTIVE" },
        ])
      ).status,
      409,
    );
    assert.equal(
      (await (await call(`/admin/roles/${role.id}/assignments`)).json()).data
        .length,
      1,
    );
    assert.equal(
      (
        await call(`/admin/roles/${role.id}/assignments`, "PUT", [
          ...assignment,
          ...assignment,
        ])
      ).status,
      400,
    );
    let history;
    for (const key of keys) {
      const response = await call("/v1/models", "GET", undefined, key.api_key);
      assert.equal(response.status, 200);
      await response.text();
      history = response.headers.get("x-infergate-request-id");
    }
    assert.equal(calls, 2);
    assert.deepEqual((await (await call(rolePath)).json()).system_prompt_compaction, { cleanWhitespace: true });
    assert.equal((await call(rolePath, "PUT", { ...roleBody, input_script: null })).status, 204);
    const messages = [{ role: "system", content: "A  B" }, { role: "developer", content: "C  D" }];
    const inference = await call("/v1/chat/completions", "POST", { model: "model-a", messages }, keys[0].api_key);
    assert.equal(inference.status, 200);
    await inference.text();
    assert.deepEqual(forwarded.messages, [{ role: "system", content: "A B" }, messages[1]]);
    assert.equal(
      (
        await call(`/admin/roles/${role.id}`, "PUT", {
          name: "Role behavior",
          model_policy_id: p.insertId,
          status: "DISABLED",
        })
      ).status,
      204,
    );
    for (const key of keys)
      assert.equal(
        (await call("/v1/models", "GET", undefined, key.api_key)).status,
        403,
      );
    assert.equal(calls, 3);
    assert.equal(
      (
        await call(`/admin/proxy-keys/${keys[1].id}/role`, "PUT", {
          role_id: null,
        })
      ).status,
      204,
    );
    const [record] = await db.query(
      "SELECT role_id FROM api_requests WHERE request_id=?",
      [history],
    );
    assert.equal(record.role_id, role.id);
    assert.equal(
      (await call("/v1/models", "GET", undefined, keys[1].api_key)).status,
      403,
    );
  },
);

test("role models discover fresh permitted IDs and reject unavailable roles or failed discovery", async t => {
  const encryptionKey = randomBytes(32);
  let status = "ACTIVE", failed = false, calls = 0;
  const db = { async query(sql, params) {
    if (sql.startsWith("SELECT token_hash")) return [{ token_hash: params[0] }];
    if (sql === "SELECT * FROM roles WHERE id=?") return params[0] === "1" ? [{ id: "1", status, model_policy_id: "2" }] : [];
    if (sql.includes("FROM role_upstream_assignments")) return ["ACTIVE", "ACTIVE", "DISABLED"].map((key_status, index) => ({
      upstream_api_key_id: index + 1, provider_id: 1, key_status, provider_status: "ACTIVE",
      encrypted_api_key: encrypt("test-secret", encryptionKey), api_url: "https://provider.example/v1", api_type: "OPENAI_COMPATIBLE",
    }));
    if (sql.includes("FROM model_policy_rules")) return [{ model_pattern: "allowed-*", policy: "ALLOW" }];
    throw new Error("Unexpected query");
  } };
  const server = createApp(db, { encryptionKey, modelDefault: "DENY" }, { fetchImpl: async () => {
    calls++;
    if (calls === 7 || calls === 10) return new Response(null, { status: 429 });
    return failed || calls === 2 ? new Response("private provider error", { status: 401 }) : Response.json({ data: [{ id: "allowed-z" }, { id: "denied" }, { id: "allowed-a" }] });
  } }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (id = "1", authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/admin/roles/${id}/models`, {
    headers: authenticated ? { authorization: "Bearer adm_models" } : {},
  });
  assert.equal((await call("1", false)).status, 401);
  const response = await call();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { data: [{ id: "allowed-a" }, { id: "allowed-z" }] });
  assert.equal(calls, 2);
  await call();
  assert.equal(calls, 4);
  assert.equal((await call("999")).status, 404);
  status = "DISABLED";
  assert.equal((await call()).status, 409);
  assert.equal(calls, 4);
  status = "ACTIVE";
  failed = true;
  const failure = await call();
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /private provider error|test-secret/);
  failed = false;
  assert.deepEqual(await (await call()).json(), { data: [{ id: "allowed-a" }, { id: "allowed-z" }] });
  assert.equal(calls, 8);
  assert.equal((await call()).status, 200);
  assert.equal(calls, 9);
  assert.equal((await call()).status, 503);
  assert.equal((await call()).status, 503);
  assert.equal(calls, 10);
});
