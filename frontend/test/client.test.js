import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, listAll, number } from "../src/api/client.js";
test('maintenance requests preserve criteria and partial progress on failure', async () => {
  const original = globalThis.fetch;
  try {
    const progress = { error: { code: 'usage_maintenance_failed', message: 'Maintenance incomplete' },
      deleted_events: 100, deleted_costs: 100, deleted_requests: 0, completed: false };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/admin/usage/events');
      assert.equal(options.method, 'DELETE');
      assert.equal(options.headers.Authorization, 'Bearer adm_test');
      assert.deepEqual(JSON.parse(options.body), { before: '2026-01-01' });
      return Response.json(progress, { status: 500 });
    };
    await assert.rejects(createClient('adm_test')('/usage/events', { method: 'DELETE', body: { before: '2026-01-01' } }), error => {
      assert.equal(error.message, 'Maintenance incomplete');
      assert.equal(error.status, 500);
      assert.deepEqual(error.data, progress);
      return true;
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/admin/usage/recalculate-costs');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { start: '2026-01-01', end: '2026-02-01' });
      return Response.json({ recalculated_events: 2, skipped_unsupported: 1, skipped_missing_assessment: 0, completed: true });
    };
    assert.equal((await createClient('adm_test')('/usage/recalculate-costs', { method: 'POST', body: { start: '2026-01-01', end: '2026-02-01' } })).recalculated_events, 2);
  } finally { globalThis.fetch = original; }
});
test("admin credential goes only to same-origin admin API and request body is JSON", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/admin/users");
      assert.equal(options.headers.Authorization, "Bearer adm_test");
      assert.equal(options.body, '{"name":"Alice"}');
      return new Response('{"id":1}', { status: 201 });
    };
    assert.deepEqual(
      await createClient("adm_test")("/users", {
        method: "POST",
        body: { name: "Alice" },
      }),
      { id: 1 },
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("expired sessions clear authentication, bad current password does not", async () => {
  const original = globalThis.fetch;
  let expired = 0;
  try {
    for (const code of ["invalid_session", "invalid_credentials"]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { code, message: "Denied" } }), {
          status: 401,
        });
      await assert.rejects(
        createClient("adm_test", () => expired++)("/password"),
        /Denied/,
      );
    }
    assert.equal(expired, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("204 responses and unavailable usage are preserved", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(
      await createClient("adm_test")("/logout", { method: "POST" }),
      null,
    );
    assert.equal(number(null), "—");
    assert.equal(number(0), "0");
  } finally {
    globalThis.fetch = original;
  }
});
test("resource lists follow the backend pagination cursor", async () => {
  const paths = [];
  const rows = await listAll(async (path) => {
    paths.push(path);
    return paths.length === 1
      ? { data: [{ id: "500" }], next_after: "500" }
      : { data: [{ id: "501" }], next_after: null };
  }, "users");
  assert.deepEqual(paths, ["/users", "/users?after=500"]);
  assert.equal(rows.length, 2);
});

test("filtered user lists retain every selected group across pagination", async () => {
  const paths = [];
  const rows = await listAll(async path => {
    paths.push(path);
    return paths.length === 1
      ? { data: [{ id: "500" }], next_after: "500" }
      : { data: [{ id: "501" }], next_after: null };
  }, "users", { group_id: ["7", "9"] });
  assert.deepEqual(paths, ["/users?group_id=7&group_id=9", "/users?group_id=7&group_id=9&after=500"]);
  assert.equal(rows.length, 2);
  let emptyPath;
  await listAll(async path => { emptyPath = path; return { data: [] }; }, "users", { group_id: [] });
  assert.equal(emptyPath, "/users");
});

test("user viewing credentials go to the dedicated read-only API and invalid links are reported", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/user/usage");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer uvk_test");
      assert.equal(options.body, undefined);
      return Response.json({ today: { total_tokens: null }, cap: { enabled: false } });
    };
    const api = createClient("uvk_test", () => {}, "/user");
    assert.equal((await api("/usage")).today.total_tokens, null);
    globalThis.fetch = async () => Response.json({ error: { code: "invalid_viewing_key", message: "Link expired" } }, { status: 401 });
    await assert.rejects(api("/usage"), /Link expired/);
  } finally {
    globalThis.fetch = original;
  }
});


test("manager sessions use the manager API and expire independently of invalid password attempts", async () => {
  const original = globalThis.fetch;
  let expired = 0;
  try {
    const api = createClient("mgr_test", () => expired++, "/manager");
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/manager/users");
      assert.equal(options.headers.Authorization, "Bearer mgr_test");
      return Response.json({ data: [{ id: 1, is_manager: 1 }] });
    };
    assert.equal((await api("/users")).data[0].is_manager, 1);
    for (const code of ["invalid_credentials", "invalid_session"]) {
      globalThis.fetch = async () => Response.json({ error: { code, message: "Denied" } }, { status: 401 });
      await assert.rejects(api("/password", { method: "PUT", body: {} }), /Denied/);
    }
    assert.equal(expired, 1);
  } finally { globalThis.fetch = original; }
});
