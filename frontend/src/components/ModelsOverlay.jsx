import React, { useEffect, useState } from "react";
import { ErrorBox, Modal, Table } from "./ui";

export function ModelsOverlay({ api, record, resource, onClose }) {
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    api(`/${resource}/${record.id}/models`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setModels(result.data); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, record.id, resource, revision]);
  return (
    <Modal title={`Models for ${record.name}`} onClose={onClose}>
      <p>{resource === "roles" ? "Models available from active upstream assignments and allowed by this role’s model policy." : "Models advertised by the provider for this upstream key. Role model policies are not applied."}</p>
      <ErrorBox error={error} />
      {busy ? <p role="status">Loading models…</p> : !error && <>
        <p role="status">{models.length} available {models.length === 1 ? "model" : "models"}</p>
        <Table rows={models} columns={[["Model ID", model => model.id]]}
          empty={{ title: "No models available", detail: resource === "roles" ? "No models from the active upstream assignments match this role’s model policy." : "The provider returned no models for this upstream key." }} />
      </>}
      <div className="form-actions">
        <button onClick={onClose}>Close</button>
        <button disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh</button>
      </div>
    </Modal>
  );
}
