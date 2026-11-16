import React, { useEffect, useState } from 'react';
import { ErrorBox, Field } from '../components/ui';

export function DebugSettings({ api }) {
  const [enabled, setEnabled] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    api('/settings/debug-logging').then(data => active && setEnabled(data.enabled)).catch(e => active && setError(e.message));
    return () => { active = false; };
  }, [api]);
  const change = async value => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await api('/settings/debug-logging', { method: 'PUT', body: { enabled: value } });
      setEnabled(data.enabled); setNotice(`Debug logging ${data.enabled ? 'enabled' : 'disabled'}.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="panel settings">
    <h2>Debug logging</h2>
    <p>Save complete request bodies, response content, reported token usage, classification request bodies and results, and evaluation results (when a handler is assigned) for /v1/chat/completions, /v1/messages, and /v1/responses in backend/logs, including streaming responses.</p>
    <p>Logs can contain confidential content and secrets included in requests. Access is restricted to the backend filesystem owner. Logs older than 60 days are removed when new logs are created. Disabling applies to new calls; existing calls finish logging.</p>
    <ErrorBox error={error}/>
    <Field label="Debug logging"><select value={enabled === null ? '' : String(enabled)} disabled={busy || enabled === null} onChange={e => change(e.target.value === 'true')}>
      {enabled === null && <option value="">Loading…</option>}
      <option value="false">Disabled</option><option value="true">Enabled</option>
    </select></Field>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
