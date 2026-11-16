import React, { useEffect, useState } from 'react';
import { listAll } from '../api/client';
import { ErrorBox, Field, Icon, Modal, Table } from '../components/ui';

export function ModelAliases({ api }) {
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [edit, setEdit] = useState(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    listAll(api, 'model-aliases').then(data => active && setRows(data)).catch(e => active && setError(e.message)).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, revision]);
  return <>
    <header className="page-heading"><div><span className="eyebrow">ACCESS & INFRASTRUCTURE</span><h1>Model Aliases</h1><p>Map a stable model name to the model name used by an upstream provider.</p></div><button className="primary" onClick={() => setEdit({})}><Icon name="plus" />Create alias set</button></header>
    <ErrorBox error={error} />
    <section className="panel"><div className="panel-toolbar"><h2>Alias sets</h2><button onClick={() => setRevision(x => x + 1)}>Refresh</button></div>
      {loading ? <div className="empty" role="status">Loading model aliases…</div> : <Table rows={rows} columns={[["Name", row => <strong>{row.name}</strong>], ["Description", row => row.description || '—'], ["Updated", row => row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'], ["Actions", row => <button onClick={() => setEdit(row)}>Edit</button>]]} empty={{ title: 'No model aliases yet', detail: 'Create an alias set and add its upstream model mappings.' }} />}
    </section>
    {edit && <AliasEditor api={api} record={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setRevision(x => x + 1); }} />}
  </>;
}

function AliasEditor({ api, record, onClose, onSaved }) {
  const [data, setData] = useState({ name: '', description: '', entries: [{ model_alias: '', model_upstream: '' }] }), [ready, setReady] = useState(!record.id), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!record.id) return;
    let active = true;
    api(`/model-aliases/${record.id}`).then(result => active && setData({ name: result.name, description: result.description || '', entries: result.entries.length ? result.entries.map(({ model_alias, model_upstream }) => ({ model_alias, model_upstream })) : [{ model_alias: '', model_upstream: '' }] })).catch(e => active && setError(e.message)).finally(() => active && setReady(true));
    return () => { active = false; };
  }, [api, record.id]);
  const changeEntry = (index, key, value) => setData(current => ({ ...current, entries: current.entries.map((entry, i) => i === index ? { ...entry, [key]: value } : entry) }));
  const save = async event => {
    event.preventDefault(); setBusy(true); setError('');
    const entries = data.entries.filter(entry => entry.model_alias.trim() || entry.model_upstream.trim());
    try {
      await api(record.id ? `/model-aliases/${record.id}` : '/model-aliases', { method: record.id ? 'PUT' : 'POST', body: { name: data.name, description: data.description || null, entries } });
      onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <Modal title={record.id ? 'Edit model aliases' : 'Create model aliases'} onClose={() => !busy && onClose()}>
    {!ready ? <p role="status">Loading alias set…</p> : <form onSubmit={save}>
      <Field label="Name" name="name" value={data.name} onChange={e => setData(current => ({ ...current, name: e.target.value }))} required maxLength={255} />
      <label className="field"><span>Description</span><textarea value={data.description} onChange={e => setData(current => ({ ...current, description: e.target.value }))} maxLength={10000} rows={3} /></label>
      <div className="panel-toolbar"><h3>Model mappings</h3><button type="button" onClick={() => setData(current => ({ ...current, entries: [...current.entries, { model_alias: '', model_upstream: '' }] }))}>Add mapping</button></div>
      {data.entries.map((entry, index) => <div className="form-grid" key={index}>
        <Field label="Model alias" value={entry.model_alias} onChange={e => changeEntry(index, 'model_alias', e.target.value)} placeholder="e.g. fast-chat" maxLength={255} />
        <Field label="Upstream model" value={entry.model_upstream} onChange={e => changeEntry(index, 'model_upstream', e.target.value)} placeholder="e.g. vendor/model-v2" maxLength={255} />
        <button type="button" aria-label="Remove mapping" onClick={() => setData(current => ({ ...current, entries: current.entries.filter((_, i) => i !== index) }))}>Remove</button>
      </div>)}
      <ErrorBox error={error} /><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !ready}>{busy ? 'Saving…' : 'Save aliases'}</button></div>
    </form>}
  </Modal>;
}
