import React, { useEffect, useState } from 'react';
import { listAll, date } from '../api/client';
import { ErrorBox, Field, Icon, Modal, Table } from '../components/ui';

const defaultTemplate = '{\n  "prompt": "${PROMPT}"\n}';
function templateText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function ClassificationHandlers({ api }) {
  const [rows, setRows] = useState([]), [error, setError] = useState(''),
    [loading, setLoading] = useState(true), [edit, setEdit] = useState(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    listAll(api, 'classification-handlers')
      .then(data => active && setRows(data))
      .catch(err => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, revision]);
  return <>
    <header className="page-heading">
      <div><span className="eyebrow">PROMPT CLASSIFICATION</span><h1>Classification handlers</h1>
        <p>Configure the services and request templates for prompt classification.</p></div>
      <button className="primary" onClick={() => setEdit({})}><Icon name="plus" />Create handler</button>
    </header>
    <ErrorBox error={error} />
    <section className="panel">
      <div className="panel-toolbar"><h2>All handlers <span className="count">{rows.length}</span></h2>
        <button className="icon-button" aria-label="Refresh" onClick={() => setRevision(value => value + 1)}><Icon name="refresh" /></button></div>
      {loading ? <div className="empty" role="status">Loading classification handlers…</div> :
        <Table rows={rows} columns={[
          ['Name', row => <div className="record-name"><div>{row.name}<small>{row.description}</small></div></div>],
          ['API URL', row => row.api_url],
          ['API key fingerprint', row => row.key_fingerprint],
          ['Created', row => date(row.created_at)],
          ['Actions', row => <button onClick={() => setEdit(row)}>Edit</button>],
        ]} empty={{ title: 'No classification handlers yet', detail: 'Create your first handler to get started.' }} />}
    </section>
    {edit && <HandlerEditor row={edit} api={api} onClose={() => setEdit(null)} onSaved={() => {
      setEdit(null); setRevision(value => value + 1);
    }} />}
  </>;
}
function HandlerEditor({ row, api, onClose, onSaved }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''),
    [template, setTemplate] = useState(row.id ? templateText(row.json_template) : defaultTemplate);
  let templateError = '';
  try { JSON.parse(template); } catch { templateError = 'Enter valid JSON. Quote property names and string values.'; }
  async function submit(event) {
    event.preventDefault();
    if (templateError) { setError(templateError); return; }
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.maxToken = data.maxToken === '' ? null : Number(data.maxToken);
    if (row.id && data.api_key === '') delete data.api_key;
    setBusy(true); setError('');
    try {
      await api(`/classification-handlers${row.id ? `/${row.id}` : ''}`, { method: row.id ? 'PATCH' : 'POST', body: data });
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <Modal title={`${row.id ? 'Edit' : 'Create'} classification handler`} onClose={() => !busy && onClose()}>
    <ErrorBox error={error} />
    <form onSubmit={submit}>
      <Field label="Name" name="name" defaultValue={row.name || ''} maxLength={255} required />
      <Field label="Description"><textarea name="description" defaultValue={row.description || ''} maxLength={10000} rows={3} /></Field>
      <Field label="API URL" name="api_url" type="url" defaultValue={row.api_url || ''} maxLength={2048} required />
      <Field label={row.id ? 'New API key (optional)' : 'API key'} name="api_key" type="password" autoComplete="off" maxLength={8192} required={!row.id} />
      <p className="muted">The API key is encrypted and will not be displayed again.{row.id ? ' Leave it blank to keep the current key.' : ''}</p>
      <Field label="Max token (optional)" name="maxToken" type="number" min={1} max={4294967295} step={1} defaultValue={row.maxToken ?? ''} placeholder="30000" />
      <p className="muted">Prompt text is capped at 90% of this character limit. Leave blank to use 30,000 (27,000 prompt characters).</p>
      <Field label="JSON template"><textarea name="json_template" value={template} onChange={event => setTemplate(event.target.value)} rows={8} maxLength={32768} required aria-invalid={Boolean(templateError)} aria-describedby="template-help" /></Field>
      <p id="template-help" className="muted">{templateError || 'Valid JSON.'} Use <code>{'${PROMPT}'}</code> as the prompt placeholder.</p>
      <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || Boolean(templateError)}>{busy ? 'Saving…' : 'Save handler'}</button></div>
    </form>
  </Modal>;
}
