import React, { useEffect, useState } from "react";
import { listAll } from "../api/client";
import { Modal, Field, ErrorBox, Icon } from "../components/ui";
export function RoleRouting({ api, record, onClose }) {
  const [rows, setRows] = useState([]),
    [keys, setKeys] = useState([]),
    [aliases, setAliases] = useState([]),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      api(`/roles/${record.id}/assignments`),
      listAll(api, "upstream-keys"),
      listAll(api, "model-aliases"),
    ])
      .then(([a, k, aliasSets]) => {
        if (active) {
          setRows(
            a.data.map(({ upstream_api_key_id, priority, status, model_alias_ids = [] }) => ({
              upstream_api_key_id,
              priority,
              status,
              model_alias_ids: model_alias_ids.map(String),
            })),
          );
          setKeys(k);
          setAliases(aliasSets);
          setReady(true);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [api, record.id]);
  const update = (i, field, value) => {
    setSaved("");
    setRows(rows.map((row, j) => (i === j ? { ...row, [field]: value } : row)));
  };
  return (
    <Modal
      title={`Configure ${record.name}`}
      onClose={() => !busy && onClose()}
    >
      <>
        <p>
          Active assignments are considered in priority order for provider
          routing.
        </p>
        <ErrorBox error={error} />
        {saved && (
          <p role="status" className="success-text">
            {saved}
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setSaved("");
            try {
              await api(`/roles/${record.id}/assignments`, {
                method: "PUT",
              body: rows.map(row => ({ ...row, model_alias_ids: (row.model_alias_ids || []).map(Number) })),
              });
              setSaved("Routing saved.");
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy || !ready}>
            {rows.map((row, i) => (
              <div className="rule" key={i}>
                <Field label="Upstream key">
                  <select
                    required
                    value={row.upstream_api_key_id}
                    onChange={(e) =>
                      update(i, "upstream_api_key_id", e.target.value)
                    }
                  >
                    <option value="">Select key</option>
                    {keys.map((key) => (
                      <option key={key.id} value={key.id}>
                        {key.name} ({key.status})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Priority">
                  <input
                    required
                    type="number"
                    min={-2147483647}
                    max={2147483647}
                    value={row.priority}
                    onChange={(e) =>
                      update(
                        i,
                        "priority",
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  />
                </Field>
                <Field label="Status">
                  <select
                    value={row.status}
                    onChange={(e) => update(i, "status", e.target.value)}
                  >
                    <option>ACTIVE</option>
                    <option>DISABLED</option>
                  </select>
                </Field>
                <Field label="Model aliases">
                  <select multiple value={row.model_alias_ids || []} onChange={e => update(i, "model_alias_ids", [...e.target.selectedOptions].map(option => option.value))}>
                    {aliases.map(alias => <option key={alias.id} value={alias.id}>{alias.name}</option>)}
                  </select>
                </Field>
                <button
                  type="button"
                  aria-label={`Remove assignment ${i + 1}`}
                  onClick={() => {
                    setRows(rows.filter((_, j) => i !== j));
                    setSaved("");
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={rows.length >= 100}
              onClick={() => {
                setRows([
                  ...rows,
                  { upstream_api_key_id: "", priority: 0, status: "ACTIVE", model_alias_ids: [] },
                ]);
                setSaved("");
              }}
            >
              <Icon name="plus" />
              Add assignment
            </button>
            <div className="form-actions">
              <button className="primary">
                {busy ? "Saving…" : "Save routing"}
              </button>
            </div>
          </fieldset>
        </form>
      </>
    </Modal>
  );
}
