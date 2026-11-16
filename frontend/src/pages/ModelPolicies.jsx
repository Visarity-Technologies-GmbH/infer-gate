import React, { useEffect, useState } from "react";
import { listAll } from "../api/client";
import { ErrorBox, Field, Modal, Table, Icon } from "../components/ui";
export function ModelPolicies({ api }) {
  const [rows, setRows] = useState([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [edit, setEdit] = useState(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listAll(api, "model-policies")
      .then((data) => active && setRows(data))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">ACCESS & INFRASTRUCTURE</span>
          <h1>Model Policies</h1>
          <p>
            Create reusable model restrictions and assign them to roles.
          </p>
        </div>
        <button className="primary" onClick={() => setEdit({})}>
          <Icon name="plus" />
          Create policy
        </button>
      </header>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="panel-toolbar">
          <h2>All model policies</h2>
          <button onClick={() => setRevision((x) => x + 1)}>Refresh</button>
        </div>
        {loading ? (
          <div className="empty" role="status">
            Loading policies…
          </div>
        ) : (
          <Table
            rows={rows}
            columns={[
              ["Name", (row) => <strong>{row.name}</strong>],
              ["Description", (row) => row.description || "—"],
              ["Assigned roles", (row) => row.assigned_roles],
              [
                "Actions",
                (row) => <button onClick={() => setEdit(row)}>Edit</button>,
              ],
            ]}
            empty={{
              title: "No model policies yet",
              detail:
                "Create a policy, then assign it from Roles.",
            }}
          />
        )}
      </section>
      {edit && (
        <PolicyEditor
          api={api}
          record={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            setRevision((x) => x + 1);
          }}
        />
      )}
    </>
  );
}
function PolicyEditor({ api, record, onClose, onSaved }) {
  const [data, setData] = useState({ name: "", description: "", rules: [] }),
    [ready, setReady] = useState(!record.id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!record.id) return;
    let active = true;
    api(`/model-policies/${record.id}`)
      .then((result) => {
        if (active) {
          setData({
            name: result.name,
            description: result.description || "",
            rules: result.rules,
          });
          setReady(true);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [api, record.id]);
  const ruleChange = (index, key, value) =>
    setData((current) => ({
      ...current,
      rules: current.rules.map((rule, i) =>
        i === index ? { ...rule, [key]: value } : rule,
      ),
    }));
  return (
    <Modal
      title={record.id ? "Edit model policy" : "Create model policy"}
      onClose={() => !busy && onClose()}
    >
      <p>
        {record.id
          ? `Saving changes affects all ${record.assigned_roles} assigned roles.`
          : "This policy can be assigned to multiple roles."}
      </p>
      <p>
        Exact rules take precedence over matching patterns (such as qwen*), then
        the catch-all rule (*), then the server default. DENY wins within each level.
        An asterisk matches any number of characters, including none. An empty policy uses the server default.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/model-policies${record.id ? `/${record.id}` : ""}`, {
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
        <fieldset disabled={busy || !ready}>
          <Field label="Policy name">
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
          {data.rules.map((rule, index) => (
            <div className="rule" key={index}>
              <Field label="Model">
                <input
                  required
                  maxLength={255}
                  placeholder="Model name, qwen*, or *"
                  value={rule.model_pattern}
                  onChange={(e) =>
                    ruleChange(index, "model_pattern", e.target.value)
                  }
                />
              </Field>
              <Field label="Policy">
                <select
                  value={rule.policy}
                  onChange={(e) => ruleChange(index, "policy", e.target.value)}
                >
                  <option>ALLOW</option>
                  <option>DENY</option>
                </select>
              </Field>
              <button
                type="button"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() =>
                  setData({
                    ...data,
                    rules: data.rules.filter((_, i) => i !== index),
                  })
                }
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={data.rules.length >= 100}
            onClick={() =>
              setData({
                ...data,
                rules: [...data.rules, { model_pattern: "", policy: "ALLOW" }],
              })
            }
          >
            <Icon name="plus" />
            Add rule
          </button>
          <div className="form-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary">
              {busy ? "Saving…" : "Save policy"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
