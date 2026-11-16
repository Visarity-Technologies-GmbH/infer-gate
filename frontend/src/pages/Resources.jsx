import { ModelsOverlay } from "../components/ModelsOverlay";
import { ManagerAccess } from './ManagerAccess';
import { UserViewingKey } from "./UserViewingKey";
import { RoleAssignment } from "./Roles";
import { UserUsageLimit } from "./UserUsageLimit";
import React, { useEffect, useState } from "react";
import { listAll, date } from "../api/client";
import { Icon, Badge, ErrorBox, Field, Modal, Table } from "../components/ui";
const specs = {
  users: {
    title: "Users",
    singular: "user",
    description: "The people and identities behind your AI usage.",
    fields: [
      ["name", "Full name"],
      ["email", "Email address", "email"],
    ],
  },
  groups: {
    title: "Groups",
    singular: "group",
    description: "Organize people into teams and departments.",
    fields: [
      ["name", "Group name"],
      ["description", "Description"],
    ],
  },
  providers: {
    title: "Inference providers",
    singular: "provider",
    description: "Connect your gateway to AI inference providers.",
    fields: [
      ["name", "Provider name"],
      ["api_url", "API base URL", "url"],
      ["api_type", "API type", "api_type"],
    ],
  },
  "upstream-keys": {
    title: "Upstream API keys",
    singular: "upstream key",
    description: "Secure credentials connecting your gateway to providers.",
    fields: [
      ["name", "Key name"],
      ["provider_id", "Inference provider", "providers"],
      ["api_key", "API key", "password"],
      ["request_compression_c", "Chat Completions request compression", "compression"],
      ["request_compression_r", "Responses request compression", "compression"],
      ["request_compression_m", "Messages request compression", "compression"],
    ],
  },
  "proxy-keys": {
    title: "Proxy API keys",
    singular: "proxy key",
    description: "Control how your people and applications access AI.",
    fields: [
      ["name", "Key name"],
      ["user_id", "Owner", "users"],
      ["role_id", "Role", "roles"],
    ],
  },
};
export function Resources({ resource, api, isAdmin = true }) {
  const spec = specs[resource];
  const [rows, setRows] = useState([]),
    [related, setRelated] = useState({}),
    [checks, setChecks] = useState({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(""),
    [edit, setEdit] = useState(null),
    [detail, setDetail] = useState(null),
    [modelsKey, setModelsKey] = useState(null),
    [secret, setSecret] = useState(null),
    [viewingUser, setViewingUser] = useState(null),
    [managerUser, setManagerUser] = useState(null),
    [revision, setRevision] = useState(0),
    [confirm, setConfirm] = useState(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setChecks({});
    setLoading(true);
    setError("");
    Promise.all([
      listAll(api, resource),
      ...(["proxy-keys", "upstream-keys"].includes(resource)
        ? [listAll(api, resource === "proxy-keys" ? "users" : "providers")]
        : []),
      ...(resource === "upstream-keys" ? [api("/provider-options")] : []),
      ...(resource === "proxy-keys" ? [listAll(api, "roles")] : []),
    ])
      .then(([data, others, options]) => {
        if (active) {
          setRows(data);
          if (resource === "upstream-keys") {
            let cursor = 0;
            const worker = async () => {
              while (active && cursor < data.length) {
                const key = data[cursor++];
                let result;
                try {
                  result = await api(`/upstream-keys/${key.id}/check`, {
                    method: "POST",
                    signal: controller.signal,
                  });
                } catch {
                  result = {
                    status: "FAILED",
                    message: "Unable to run check. Refresh to retry.",
                  };
                }
                if (active)
                  setChecks((current) => ({ ...current, [key.id]: result }));
              }
            };
            for (let i = 0; i < Math.min(4, data.length); i++) void worker();
          }
          setRelated(
            others
              ? {
                  [resource === "proxy-keys" ? "users" : "providers"]: others,
                  bedrock_regions: options?.bedrock_regions || [],
                  roles: resource === "proxy-keys" ? options : [],
                }
              : {},
          );
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      controller.abort();
    };
  }, [resource, revision, api]);
  const refresh = () => setRevision((x) => x + 1);
  const lookup = (type, id) =>
    related[type]?.find((r) => String(r.id) === String(id))?.name || `#${id}`;
  const columns = [
    [
      "Name",
      (r) => (
        <div className="record-name">
          <span className="record-icon">
            <Icon
              name={
                resource === "users" || resource === "groups"
                  ? "users"
                  : resource === "providers"
                    ? "server"
                    : "key"
              }
              size={17}
            />
          </span>
          <div>
            <strong>{r.name}</strong>
            <small>
              {resource === "users"
                ? `${r.email}${r.is_manager ? " · Manager" : ""}`
                : resource === "providers"
                  ? r.api_url
                  : resource === "groups"
                    ? r.description
                    : r.key_prefix
                      ? `${r.key_prefix}…`
                      : r.key_fingerprint}
            </small>
          </div>
        </div>
      ),
    ],
    ...(["proxy-keys", "upstream-keys"].includes(resource)
      ? [
          [
            resource === "proxy-keys" ? "Owner" : "Provider",
            (r) =>
              lookup(
                resource === "proxy-keys" ? "users" : "providers",
                r.user_id || r.provider_id,
              ),
          ],
        ]
      : []),
    ...(resource === "proxy-keys"
      ? [["Expires at (UTC)", (r) => r.expires_at ? new Date(r.expires_at).toISOString().replace("T", " ").replace("Z", "") : "Never"], ["Role", (r) => r.role_id == null ? "No role" : lookup("roles", r.role_id)]]
      : []),
    ...(resource === "upstream-keys"
      ? [["AWS region", (r) => r.aws_region || "—"]]
      : []),
    ...(resource === "upstream-keys"
      ? [
          [
            "Models API check",
            (r) => {
              const check = checks[r.id];
              return (
                <div className="record-name" aria-live="polite">
                  <div>
                    <Badge value={check?.status || "CHECKING"} />
                    <small>
                      {check
                        ? `${check.message}${check.http_status ? ` (HTTP ${check.http_status})` : ""}${check.status === "SUCCESS" ? ` · ${check.model_count} models` : ""}`
                        : "Waiting for models API check…"}
                    </small>
                    {check?.checked_at && (
                      <small>{date(check.checked_at)}</small>
                    )}
                  </div>
                </div>
              );
            },
          ],
        ]
      : []),
    ...(resource !== "groups"
      ? [["Status", (r) => <Badge value={r.status} />]]
      : []),
    ["Created", (r) => <span className="muted">{date(r.created_at)}</span>],
    [
      "Actions",
      (r) => (
        <div className="row-actions">
          {["users", "groups", "providers", "upstream-keys"].includes(
            resource,
          ) && <button onClick={() => setEdit(r)}>Edit</button>}
          {resource === "upstream-keys" && isAdmin && <button onClick={() => setModelsKey(r)}>Show models</button>}
          {resource === "users" && <>
            {isAdmin && <button onClick={() => setManagerUser(r)}>{r.is_manager ? "Manager access" : "Promote to manager"}</button>}
            <button onClick={() => setDetail(r)}>Usage cap</button>
            <button onClick={() => setViewingUser(r)}>Usage link</button>
          </>}
          {resource === "groups" && (
            <button onClick={() => setDetail(r)}>Members</button>
          )}
          {resource === "proxy-keys" && (
            <><button onClick={() => setEdit(r)}>Edit expiry</button><button onClick={() => setDetail(r)}>Configure</button></>
          )}
          {resource !== "groups" &&
            !(resource === "proxy-keys" && r.status === "REVOKED") && (
              <button
                className={r.status === "ACTIVE" ? "danger-text" : ""}
                onClick={() => setConfirm(r)}
              >
                {resource === "proxy-keys"
                  ? "Revoke"
                  : r.status === "ACTIVE"
                    ? resource === "users"
                      ? "Suspend"
                      : "Disable"
                    : "Reactivate"}
              </button>
            )}
        </div>
      ),
    ],
  ];
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">ACCESS & INFRASTRUCTURE</span>
          <h1>{spec.title}</h1>
          <p>{spec.description}</p>
        </div>
        <button className="primary" onClick={() => setEdit(resource === "proxy-keys"
          ? { expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }
          : {})}>
          <Icon name="plus" />
          Create {spec.singular}
        </button>
      </header>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="panel-toolbar">
          <h2>
            All {spec.title.toLowerCase()}{" "}
            <span className="count">{rows.length}</span>
          </h2>
          <div className="search">
            <Icon name="search" size={17} />
            <input
              aria-label={`Search ${spec.title}`}
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="icon-button"
            aria-label="Refresh"
            onClick={refresh}
          >
            <Icon name="refresh" size={18} />
          </button>
        </div>
        {loading ? (
          <div className="empty" role="status">
            Loading {spec.title.toLowerCase()}…
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows.filter((r) =>
              `${r.name} ${r.email || ""}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )}
            empty={{
              title: query
                ? "No matching results"
                : `No ${spec.title.toLowerCase()} yet`,
              detail: query
                ? "Try a different search."
                : `Create your first ${spec.singular} to get started.`,
            }}
          />
        )}
      </section>
      {modelsKey && resource === "upstream-keys" && <ModelsOverlay api={api} record={modelsKey} resource="upstream-keys" onClose={() => setModelsKey(null)} />}
      {edit && (
        <Editor
          spec={spec}
          resource={resource}
          row={edit}
          related={related}
          api={api}
          onCompressionChecked={refresh}
          onClose={() => setEdit(null)}
          onSaved={(result) => {
            setEdit(null);
            refresh();
            if (result?.api_key) setSecret(result);
          }}
        />
      )}
      {managerUser && <ManagerAccess api={api} user={managerUser} onClose={() => setManagerUser(null)} onSaved={refresh} />}
      {viewingUser && <UserViewingKey api={api} user={viewingUser} onClose={() => setViewingUser(null)} />}
      {secret && (
        <Modal title="Your proxy API key" onClose={() => setSecret(null)}>
          <p>Copy this key now. You will not be able to view it again.</p>
          <textarea
            className="secret"
            readOnly
            value={secret.api_key}
            aria-label="New proxy API key"
            onFocus={(e) => e.target.select()}
          />
          {!secret.role_id && <p className="muted">Next, assign a role before using it.</p>}
          <div className="form-actions">
            <button className="primary" onClick={() => setSecret(null)}>
              I’ve saved the key
            </button>
          </div>
        </Modal>
      )}
      {detail &&
        (resource === "groups" ? (
          <Members api={api} group={detail} onClose={() => setDetail(null)} />
        ) : resource === "users" ? (
          <UserUsageLimit api={api} user={detail} onClose={() => setDetail(null)} />
        ) : (
          <RoleAssignment
            api={api}
            record={detail}
            onClose={() => { setDetail(null); refresh(); }}
          />
        ))}
      {confirm && (
        <Modal
          title={`${resource === "proxy-keys" ? "Revoke key" : confirm.status === "ACTIVE" ? "Deactivate access" : "Reactivate access"}?`}
          onClose={() => !busy && setConfirm(null)}
        >
          <p>
            {confirm.name}:{" "}
            {resource === "proxy-keys"
              ? "This key will permanently stop working."
              : confirm.status === "ACTIVE"
                ? "API access through this record will stop immediately."
                : "API access can resume when all other permissions allow it."}
          </p>
          <ErrorBox error={error} />
          <div className="form-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(
                    `/${resource}/${confirm.id}${resource === "proxy-keys" ? "/revoke" : ""}`,
                    {
                      method: resource === "proxy-keys" ? "POST" : "PATCH",
                      ...(resource === "proxy-keys"
                        ? {}
                        : {
                            body: {
                              status:
                                confirm.status === "ACTIVE"
                                  ? resource === "users"
                                    ? "SUSPENDED"
                                    : "DISABLED"
                                  : "ACTIVE",
                            },
                          }),
                    },
                  );
                  setConfirm(null);
                  refresh();
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving…" : "Confirm"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Editor({ spec, resource, row, related, api, onClose, onSaved, onCompressionChecked }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [checkingCompression, setCheckingCompression] = useState(false),
    [compressionNotice, setCompressionNotice] = useState(""),
    [compression, setCompression] = useState({
      request_compression_c: row.request_compression_c || "NONE",
      request_compression_r: row.request_compression_r || "NONE",
      request_compression_m: row.request_compression_m || "NONE",
    }),
    [apiType, setApiType] = useState(row.api_type || "OPENAI_COMPATIBLE"),
    [providerId, setProviderId] = useState(String(row.provider_id || ""));
  const isBedrock =
    resource === "upstream-keys" &&
    related.providers?.some(
      (provider) =>
        String(provider.id) === providerId &&
        provider.api_type === "AWS_BEDROCK",
    );
  const fields =
    row.id && resource === "upstream-keys"
      ? [
          ["name", "Key name"],
          ["api_key", "New API key (optional)", "password"],
          ["request_compression_c", "Chat Completions request compression", "compression"],
          ["request_compression_r", "Responses request compression", "compression"],
          ["request_compression_m", "Messages request compression", "compression"],
        ]
      : resource === "proxy-keys" && row.id ? [] : spec.fields;
  return (
    <Modal
      title={`${row.id ? "Edit" : "Create"} ${spec.singular}`}
      onClose={() => !busy && onClose()}
    >
      <ErrorBox error={error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const data = Object.fromEntries(new FormData(e.currentTarget));
          if (data.role_id === "") data.role_id = null;
          if (resource === "upstream-keys" && row.id && data.api_key === "")
            delete data.api_key;
          if (resource === "groups" && !data.description)
            data.description = null;
          if (resource === "providers" && data.anthropic_api_url === "")
            data.anthropic_api_url = null;
          try {
            const editingExpiry = resource === "proxy-keys" && row.id;
            if (resource === "proxy-keys")
              data.expires_at = data.expires_at ? new Date(data.expires_at + "Z").toISOString() : null;
            onSaved(
              await api(`/${resource}${row.id ? `/${row.id}` : ""}${editingExpiry ? "/expiry" : ""}`, {
                method: editingExpiry ? "PUT" : row.id ? "PATCH" : "POST",
                body: data,
              }),
            );
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {resource === "proxy-keys" && <Field label="Expires at (UTC, optional)">
          <input name="expires_at" type="datetime-local" step="0.001"
            defaultValue={row.expires_at ? new Date(row.expires_at).toISOString().slice(0, -1) : ""} />
        </Field>}
        {fields.map(([name, label, type]) => (
          <Field key={name} label={label}>
            {type === "api_type" ? (
              <select
                name={name}
                value={apiType}
                required
                onChange={(e) => setApiType(e.target.value)}
              >
                {["OPENAI_COMPATIBLE", "ANTHROPIC", "GEMINI", "AWS_BEDROCK", "OPENAI_ANTHROPIC"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            ) : related[type] || type === "roles" ? (
              <select
                name={name}
                defaultValue={row[name] || ""}
                required={name !== "role_id"}
                onChange={
                  name === "provider_id"
                    ? (e) => setProviderId(e.target.value)
                    : undefined
                }
              >
                <option value="">{name === "role_id" ? "No role" : `Select ${label.toLowerCase()}`}</option>
                {(related[type] || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.status !== "ACTIVE" ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
            ) : type === "compression" ? (
              <select name={name} value={compression[name]} onChange={(e) => setCompression((current) => ({ ...current, [name]: e.target.value }))}>
                <option value="NONE">None</option><option value="GZIP">Gzip</option><option value="ZSTD">Zstandard (zstd)</option>
              </select>
            ) : (
              <input
                name={name}
                type={
                  name === "api_url" && apiType === "AWS_BEDROCK"
                    ? "text"
                    : type || "text"
                }
                readOnly={name === "api_url" && row.api_type === "AWS_BEDROCK" && apiType === "AWS_BEDROCK"}
                defaultValue={name === "api_key" ? "" : row[name] || ""}
                required={
                  name !== "description" && !(name === "api_key" && row.id)
                }
                maxLength={
                  name === "api_key"
                    ? 8192
                    : name === "api_url"
                      ? 2048
                      : name === "description"
                        ? 10000
                        : 255
                }
                autoComplete={type === "password" ? "off" : undefined}
              />
            )}
          </Field>
        ))}
        {resource === "upstream-keys" && row.id && (
          <div className="form-actions">
            <button type="button" disabled={busy || checkingCompression} onClick={async () => {
              setCheckingCompression(true); setError(""); setCompressionNotice("");
              try {
                const detected = await api(`/upstream-keys/${row.id}/check-compression`, { method: "POST" });
                setCompression({
                  request_compression_c: detected.request_compression_c,
                  request_compression_r: detected.request_compression_r,
                  request_compression_m: detected.request_compression_m,
                });
                setCompressionNotice("Compression settings detected and saved.");
                onCompressionChecked?.();
              } catch (err) { setError(err.message); }
              finally { setCheckingCompression(false); }
            }}>{checkingCompression ? "Checking…" : "Check Compression"}</button>
            {compressionNotice && <span className="muted">{compressionNotice}</span>}
          </div>
        )}
        {resource === "providers" && apiType === "OPENAI_ANTHROPIC" && (
          <>
            <Field label="Anthropic API base URL (optional)">
              <input
                name="anthropic_api_url"
                type="url"
                defaultValue={row.anthropic_api_url || ""}
                maxLength={2048}
              />
            </Field>
            <p className="muted">
              Leave blank to use the API base URL for both protocols. Model discovery
              uses the OpenAI-compatible API; some models may not support Messages.
            </p>
          </>
        )}
        {resource === "upstream-keys" && row.id && (
          <p className="muted">
            Leave the new API key blank to keep the current credential. A
            replacement applies to all proxy keys assigned to this upstream key.
          </p>
        )}
        {resource === "upstream-keys" && (
          <p className="muted">
            Enter an API key or an environment variable reference such as
            $OPENAIKEY. The variable must be set on the backend server.
          </p>
        )}
        {isBedrock && (
          <>
            <Field label="AWS region">
              <select
                name="aws_region"
                defaultValue={row.aws_region || ""}
                required
              >
                <option value="">Select an AWS region</option>
                {(related.bedrock_regions || []).map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.name} · {region.id}
                  </option>
                ))}
              </select>
            </Field>
            <p className="muted">
              Use an Amazon Bedrock API key for the selected region, not an AWS
              access key ID or secret access key.
            </p>
          </>
        )}
        {resource === "upstream-keys" && (
          <p className="muted">
            The credential is encrypted by the server and will not be displayed
            again.
          </p>
        )}
        <div className="form-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save " + spec.singular}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Members({ api, group, onClose }) {
  const [users, setUsers] = useState([]),
    [members, setMembers] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  useEffect(() => {
    Promise.all([listAll(api, "users"), api(`/groups/${group.id}/users`)])
      .then(([u, m]) => {
        setUsers(u);
        setMembers(m.data.map((r) => String(r.id)));
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [api, group.id]);
  return (
    <Modal title={`${group.name} · Members`} onClose={onClose}>
      <p>
        Changes to membership are saved immediately. The API returns up to 500
        current members.
      </p>
      <ErrorBox error={error} />
      <div className="member-list">
        {users.map((u) => (
          <label key={u.id} className="member">
            <input
              type="checkbox"
              disabled={busy}
              checked={members.includes(String(u.id))}
              onChange={async (e) => {
                const checked = e.target.checked;
                setBusy(true);
                setError("");
                try {
                  await api(`/groups/${group.id}/users/${u.id}`, {
                    method: checked ? "PUT" : "DELETE",
                  });
                  setMembers((m) =>
                    checked
                      ? [...m, String(u.id)]
                      : m.filter((id) => id !== String(u.id)),
                  );
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
            />
            <span>
              {u.name}
              <small>{u.email}</small>
            </span>
          </label>
        ))}
      </div>
      {!users.length && (
        <p>{busy ? "Loading…" : "Create users first to add group members."}</p>
      )}
    </Modal>
  );
}
