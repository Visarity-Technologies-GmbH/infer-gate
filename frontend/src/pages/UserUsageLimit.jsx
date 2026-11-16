import React, { useEffect, useState } from 'react';
import { ErrorBox, Field, Modal } from '../components/ui';

export function UserUsageLimit({ api, user, onClose }) {
  const [form, setForm] = useState({ enabled: false, period: 'DAILY', basis: 'TOKENS', amount: '5' });
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const path = `/users/${user.id}/usage-limit`;
  useEffect(() => {
    let active = true;
    api(path).then(value => {
      if (!active) return;
      setStatus(value);
      if (value.period) setForm({ enabled: value.enabled, period: value.period, basis: value.basis, amount: value.amount });
    }).catch(e => active && setError(e.message)).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api, path]);
  const update = (name, value) => setForm(current => ({ ...current, [name]: value }));
  return <Modal title={`Usage cap · ${user.name}`} onClose={() => !busy && onClose()}>
    <ErrorBox error={error} />
    {loading ? <p role="status">Loading usage cap…</p> : !status ? <p>Unable to load this user’s settings. Close and try again.</p> : <>
      <p>One cap covers all of this user’s API keys. Requests are blocked at 95% of the configured amount.</p>
      <form onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try {
          await api(path, { method: 'PUT', body: form });
          setStatus(await api(path));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }}>
        <Field label="Usage cap">
          <select value={String(form.enabled)} onChange={e => update('enabled', e.target.value === 'true')} disabled={busy}>
            <option value="false">Disabled — unlimited usage</option>
            <option value="true">Enabled</option>
          </select>
        </Field>
        <Field label="Period">
          <select value={form.period} onChange={e => update('period', e.target.value)} disabled={busy}>
            <option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option>
          </select>
        </Field>
        <Field label="Based on">
          <select value={form.basis} onChange={e => setForm(current => ({ ...current, basis: e.target.value, amount: '5' }))} disabled={busy}>
            <option value="TOKENS">Token consumption (millions)</option><option value="COST">Estimated cost (USD)</option>
          </select>
        </Field>
        <Field label={form.basis === 'TOKENS' ? 'Limit in millions of tokens' : 'Limit in USD'}>
          <input value={form.amount} onChange={e => update('amount', e.target.value)} inputMode="decimal" required disabled={busy} />
        </Field>
        <p className="muted">{form.basis === 'TOKENS' ? '5 means 5,000,000 tokens; requests stop at 4,750,000.' : 'A USD 20 cap stops requests at USD 19. Missing prices count as USD 0.'} Days reset at 00:00 UTC; weeks reset on Monday at 00:00 UTC.</p>
        <p className="muted">Incomplete or failed requests and missing consumption information count as zero toward the cap. Requests already in progress finish normally and may exceed the cutoff. Changes include usage already recorded in the current period.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save usage cap'}</button>
        </div>
      </form>
      <section aria-live="polite">
        <h3>Current saved cap</h3>
        {!status.enabled ? <p>Unlimited usage</p> : <>
          <p><strong>{status.blocked ? 'Blocked' : 'Access allowed'}</strong> · {status.period === 'DAILY' ? 'Daily' : 'Weekly'} {status.basis === 'TOKENS' ? 'token' : 'estimated cost'} cap</p>
          <p>Consumed: {status.consumed} / {status.amount} {status.basis === 'TOKENS' ? 'million tokens' : 'USD'}<br />95% cutoff: {status.cutoff} {status.basis === 'TOKENS' ? 'million tokens' : 'USD'}</p>
          <p>Resets: {status.resets_at.replace('T', ' ').replace('.000Z', ' UTC')}</p>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { setStatus(await api(path)); } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}>Refresh consumption</button>
        </>}
      </section>
    </>}
  </Modal>;
}
