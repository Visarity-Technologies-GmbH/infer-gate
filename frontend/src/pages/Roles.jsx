import { ModelsOverlay } from "../components/ModelsOverlay";
import React, { useEffect, useState } from "react";
import { listAll } from "../api/client";
import { ErrorBox, Field, Modal, Table, Badge } from "../components/ui";
import { RoleRouting } from "./RoleRouting";
export function Roles({ api }) {
  const [rows, setRows] = useState([]),
    [policies, setPolicies] = useState([]),
    [handlers, setHandlers] = useState([]),
    [defaultScript, setDefaultScript] = useState(""),
    [error, setError] = useState(""),
    [edit, setEdit] = useState(null),
    [routing, setRouting] = useState(null),
    [modelsRole, setModelsRole] = useState(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([listAll(api, "roles"), listAll(api, "model-policies"), listAll(api, "classification-handlers"), api("/role-options")])
      .then(([r, p, h, options]) => {
        if (active) {
          setRows(r);
          setPolicies(p);
          setHandlers(h);
          setDefaultScript(options.default_evaluation_script);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Roles</h1>
          <p>Share model access and upstream routing across proxy keys.</p>
        </div>
        <button
          className="primary"
          disabled={!defaultScript}
          onClick={() =>
            setEdit({
              name: "",
              description: "",
              model_policy_ids: [],
              classification_handler_id: null,
              evaluation_script: defaultScript,
              status: "ACTIVE",
            })
          }
        >
          Create role
        </button>
      </header>
      <ErrorBox error={error} />
      <section className="panel">
        <Table
          rows={rows}
          columns={[
            ["Name", (r) => r.name],
            ["Description", (r) => r.description || "—"],
            [
              "Model policy",
              (r) =>
                (r.model_policy_ids || []).map(id => policies.find(p => String(p.id) === String(id))?.name).filter(Boolean).join(", ") || "—",
            ],
            [
              "Classification handler",
              (r) => r.classification_handler_id == null ? "None" :
                handlers.find((h) => String(h.id) === String(r.classification_handler_id))?.name || "—",
            ],
            ["Status", (r) => <Badge value={r.status} />],
            ["Assigned keys", (r) => r.assigned_keys],
            [
              "Actions",
              (r) => (
                <>
                  <button onClick={() => setEdit(r)}>Edit</button>{" "}
                  <button onClick={() => setRouting(r)}>
                    Upstream routing
                  </button>{" "}
                  <button onClick={() => setModelsRole(r)}>Show models</button>
                </>
              ),
            ],
          ]}
          empty={{
            title: "No roles yet",
            detail: "Create a model policy, then create a role.",
          }}
        />
      </section>
      {edit && (
        <RoleEditor
          api={api}
          record={edit}
          policies={policies}
          handlers={handlers}
          defaultScript={defaultScript}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
      {modelsRole && <ModelsOverlay api={api} record={modelsRole} resource="roles" onClose={() => setModelsRole(null)} />}
      {routing && (
        <RoleRouting
          api={api}
          record={routing}
          onClose={() => setRouting(null)}
        />
      )}
    </>
  );
}
function RoleEditor({ api, record, policies, handlers, defaultScript, onClose, onSaved }) {
  const [data, setData] = useState({
      name: record.name,
      description: record.description || "",
      model_policy_ids: record.model_policy_ids || [],
      classification_handler_id: record.classification_handler_id ?? null,
      evaluation_script: record.evaluation_script ?? defaultScript,
      system_prompt_compaction: record.system_prompt_compaction ?? {},
      prompt_script: record.prompt_script ?? "",
      input_script: record.input_script ?? "",
      output_script: record.output_script ?? "",
      status: record.status,
      debug_enabled: record.debug_enabled ?? false,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={record.id ? "Edit role" : "Create role"}
      onClose={() => !busy && onClose()}
    >
      <p>
        {record.id
          ? `Changes affect all ${record.assigned_keys} assigned proxy keys.`
          : "Choose one model policy, then configure upstream routing."}
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/roles${record.id ? `/${record.id}` : ""}`, {
              method: record.id ? "PUT" : "POST",
              body: data,
            });
            onSaved();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <Field label="Role name">
            <input
              required
              maxLength={255}
              value={data.name}
              onChange={(e) => setData({ ...data, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <input
              maxLength={10000}
              value={data.description}
              onChange={(e) =>
                setData({ ...data, description: e.target.value })
              }
            />
          </Field>
          <Field label="Model policies (any may allow access)">
            <select multiple required value={data.model_policy_ids.map(String)} onChange={e => setData({ ...data, model_policy_ids: [...e.target.selectedOptions].map(o => o.value) })}>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Classification handler (optional)">
            <select
              value={data.classification_handler_id ?? ""}
              onChange={(e) => setData({ ...data, classification_handler_id: e.target.value || null })}
            >
              <option value="">None</option>
              {handlers.map((handler) => (
                <option key={handler.id} value={handler.id}>{handler.name}</option>
              ))}
            </select>
          </Field>
          {!handlers.length && <p className="muted">Create a handler on the Classification handlers page to assign one here.</p>}
          {data.classification_handler_id != null && (
            <>
              <Field label="Prompt script (JavaScript, optional)">
                <textarea
                  className="code-editor"
                  rows={10}
                  maxLength={32768}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={data.prompt_script}
                  onChange={(e) => setData({ ...data, prompt_script: e.target.value })}
                />
              </Field>
              <Field label="Evaluation script (JavaScript)">
                <textarea
                  className="code-editor"
                  rows={20}
                  value={data.evaluation_script}
                  required
                  maxLength={32768}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-describedby="evaluation-script-help"
                  onChange={(e) => setData({ ...data, evaluation_script: e.target.value })}
                />
              </Field>
              <p id="evaluation-script-help" className="muted">Define evaluate(input, input_type, classification, models, context) and return category, sensitiveData, complexity (0: easy, 1: medium, 2: hard), and models. It runs after classification; category, sensitiveData, and complexity are recorded with reported usage. The first available model in the returned list replaces the requested model, subject to model policy. Return null or no matching models to keep the original.</p>
              <button type="button" onClick={() => setData({ ...data, evaluation_script: defaultScript })}>Reset to default</button>
            </>
          )}
          {[
            ["input_script", "Input script"],
            ["output_script", "Output script"],
          ].map(([field, label]) => (
            <Field key={field} label={`${label} (JavaScript, optional)`}>
              <textarea
                className="code-editor"
                rows={10}
                maxLength={32768}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={data[field]}
                onChange={(e) => setData({ ...data, [field]: e.target.value })}
              />
            </Field>
          ))}
          <fieldset className="compaction-options">
            <legend>System prompt compaction</legend>
            {Object.entries({
              removeComments: "Remove HTML comments in Markdown",
              minifyJson: "Minify fenced JSON",
              compactLists: "Compact list marker spacing",
              cleanWhitespace: "Collapse spaces and tabs in prose",
              collapseNewlines: "Collapse extra blank lines",
            }).map(([option, label]) => (
              <label key={option}>
                <input type="checkbox" checked={!!data.system_prompt_compaction[option]}
                  onChange={e => setData({ ...data, system_prompt_compaction: {
                    ...data.system_prompt_compaction, [option]: e.target.checked,
                  } })} /> {label}
              </label>
            ))}
          </fieldset>
          <Field label="Debug logging">
            <select value={String(data.debug_enabled)} onChange={e => setData({ ...data, debug_enabled: e.target.value === "true" })}>
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </Field>
          <p className="muted">Captures requests for this role only when global debug logging is also enabled. Changes apply to new calls.</p>
          <Field label="Status">
            <select
              value={data.status}
              onChange={(e) => setData({ ...data, status: e.target.value })}
            >
              <option>ACTIVE</option>
              <option>DISABLED</option>
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary">
              {busy ? "Saving…" : "Save role"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
export function RoleAssignment({ api, record, onClose }) {
  const [roles, setRoles] = useState([]),
    [selected, setSelected] = useState(""),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([listAll(api, "roles"), api(`/proxy-keys/${record.id}/role`)])
      .then(([r, k]) => {
        if (active) {
          setRoles(r);
          setSelected(String(k.role_id || ""));
          setReady(true);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [api, record.id]);
  return (
    <Modal
      title={`Configure ${record.name}`}
      onClose={() => !busy && onClose()}
    >
      <p>
        Choose the role that controls this key’s model access and upstream
        routing. Unassigned keys cannot make API requests.
      </p>
      <ErrorBox error={error} />
      {saved && <p role="status">{saved}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/proxy-keys/${record.id}/role`, {
              method: "PUT",
              body: { role_id: selected || null },
            });
            setSaved("Role assignment saved.");
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={!ready || busy}>
          <Field label="Role">
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setSaved("");
              }}
            >
              <option value="">No role — access disabled</option>
              {selected && !roles.some(r => String(r.id) === selected) && <option value={selected} disabled>Assigned role unavailable</option>}
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.status})
                </option>
              ))}
            </select>
          </Field>
          <button className="primary">
            {busy ? "Saving…" : "Save assignment"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
