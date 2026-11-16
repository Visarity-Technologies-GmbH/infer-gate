import React, { useEffect, useState } from 'react';
import { date, listAll } from '../api/client';
import { ErrorBox, Modal, Table } from '../components/ui';

export function McpTokens({ api, manager }) {
  const [rows, setRows] = useState([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [secret, setSecret] = useState('');
  const [rename, setRename] = useState(null), [renameError, setRenameError] = useState('');
  const [revoke, setRevoke] = useState(null);
  const load = async () => setRows(await listAll(api, 'mcp-tokens'));
  useEffect(() => { load().catch(err => setError(err.message)); }, [api]);

  async function create(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError('');
    try {
      const result = await api('/mcp-tokens', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      setSecret(result.token);
      form.reset();
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function saveName(event) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    setBusy(true); setRenameError('');
    try {
      await api('/mcp-tokens/' + rename.id, { method: 'PATCH', body: { name } });
      setRows(current => current.map(row => row.id === rename.id ? { ...row, name: name.trim() } : row));
      setRename(null);
    } catch (err) { setRenameError(err.message); }
    finally { setBusy(false); }
  }
  async function confirmRevoke() {
    setBusy(true); setError('');
    try {
      await api('/mcp-tokens/' + revoke.id + '/revoke', { method: 'POST' });
      setRevoke(null);
      await load();
    } catch (err) { setRevoke(null); setError(err.message); }
    finally { setBusy(false); }
  }
  const today = new Date();
  const defaultExpiry = new Date(today);
  defaultExpiry.setUTCDate(today.getUTCDate() + 30);
  return <section className="panel">
    <h2>MCP tokens</h2>
    <p>Create a separate bearer token for each MCP client. Tokens stay active after dashboard logout.</p>
    <ErrorBox error={error} />
    <form onSubmit={create}>
      <label>Token name<input name="name" required maxLength={255} placeholder="" /></label>
      <label>Access<select name="scope" defaultValue="REPORT">
        <option value="REPORT">Reporting · /report/mcp</option>
        {manager && <option value="MANAGER">Management · /manager/mcp</option>}
        {!manager && <option value="ADMIN">Administration · /admin/mcp</option>}
      </select></label>
      <label>Valid through (UTC)<input name="valid_through" type="date" required min={today.toISOString().slice(0,10)} defaultValue={defaultExpiry.toISOString().slice(0,10)} /></label>
      <button className="primary" disabled={busy}>Create token</button>
    </form>
    <Table rows={rows} empty={{ title: 'No MCP tokens' }} columns={[
      ['Name', row => row.name], ['Owner', row => row.manager_name ?? 'Administrator'],
      ['Prefix', row => row.token_prefix], ['Scope', row => row.scope], ['Status', row => row.status],
      ['Valid through (UTC)', row => new Date(new Date(row.expires_at).getTime() - 1).toISOString().slice(0,10)],
      ['Last used', row => date(row.last_used_at)],
      ['Actions', row => <>
        <button disabled={busy} onClick={() => { setRenameError(''); setRename(row); }}>Rename</button>
        {row.status === 'ACTIVE' && <button disabled={busy} onClick={() => setRevoke(row)}>Revoke</button>}
      </>]
    ]} />
    {secret && <Modal title="Copy your MCP token" onClose={() => setSecret('')}>
      <p>Copy this token now. It is shown only once.</p>
      <textarea className="secret" aria-label="New MCP bearer token" readOnly value={secret} onFocus={e => e.target.select()} />
      <button onClick={() => setSecret('')}>Done</button>
    </Modal>}
    {rename && <Modal title="Rename MCP token" onClose={() => setRename(null)}>
      <form onSubmit={saveName}>
        <label>Token name<input name="name" defaultValue={rename.name} required maxLength={255} autoFocus /></label>
        <ErrorBox error={renameError} />
        <button className="primary" disabled={busy}>Save name</button>
      </form>
    </Modal>}
    {revoke && <Modal title="Revoke MCP token" onClose={() => setRevoke(null)}>
      <p>Revoke “{revoke.name}”? Clients using it will lose access immediately.</p>
      <button disabled={busy} onClick={confirmRevoke}>Revoke token</button>
    </Modal>}
  </section>;
}
