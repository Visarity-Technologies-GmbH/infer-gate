import React, { useState } from 'react';
import { number } from '../api/client';
import { ErrorBox, Field, Modal } from '../components/ui';

export function UsageMaintenanceSettings({ api }) {
  const [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(null), [results, setResults] = useState({});
  const review = (event, operation) => {
    event.preventDefault();
    if (busy) return;
    const dates = Object.fromEntries(new FormData(event.currentTarget));
    if (operation === 'recalculate' && dates.start >= dates.end) {
      setResults(current => ({ ...current, recalculate: { error: 'Choose an end date after the start date.' } }));
      return;
    }
    setAcknowledged(false);
    setConfirmation({ operation, dates });
  };
  const run = async () => {
    if (busy || !confirmation || (confirmation.operation === 'delete' && !acknowledged)) return;
    const { operation, dates } = confirmation;
    setBusy(operation); setConfirmation(null);
    setResults(current => ({ ...current, [operation]: null }));
    try {
      const data = await api(operation === 'delete' ? '/usage/events' : '/usage/recalculate-costs', {
        method: operation === 'delete' ? 'DELETE' : 'POST', body: dates,
      });
      setResults(current => ({ ...current, [operation]: { data, dates } }));
    } catch (error) {
      setResults(current => ({ ...current, [operation]: { error: error.message, data: error.data, dates } }));
    } finally { setBusy(null); }
  };
  return <section className="panel maintenance-settings">
    <h2>Usage maintenance</h2>
    <p>Manage stored usage and cost history across all users and providers. Changes affect reports and usage limits.</p>
    <div className="maintenance-grid">
      <section className="maintenance-card" aria-busy={busy === 'delete'}>
        <h3>Delete old history</h3>
        <p>Permanently delete usage events, their cost assessments, and eligible completed requests before a date. Running requests and requests with retained usage remain.</p>
        <form onSubmit={event => review(event, 'delete')}>
          <fieldset disabled={!!busy}>
            <Field label="Delete before (UTC)"><input type="date" required name="before"/></Field>
            <p className="muted">The selected date is excluded. Deletion cannot be undone.</p>
            <div className="form-actions"><button className="maintenance-danger" disabled={!!busy}>{busy === 'delete' ? 'Deleting history…' : 'Review deletion'}</button></div>
          </fieldset>
        </form>
        <MaintenanceResult operation="delete" result={results.delete}/>
      </section>
      <section className="maintenance-card" aria-busy={busy === 'recalculate'}>
        <h3>Recalculate costs</h3>
        <p>Recalculate stored costs using reported usage and current prices. Existing cost estimates are replaced.</p>
        <form onSubmit={event => review(event, 'recalculate')}>
          <fieldset disabled={!!busy}>
            <div className="maintenance-dates">
              <Field label="Start date (UTC, inclusive)"><input type="date" required name="start"/></Field>
              <Field label="End date (UTC, exclusive)"><input type="date" required name="end"/></Field>
            </div>
            <p className="muted">Select by usage completion date. Unsupported assessments and events without a cost assessment are skipped.</p>
            <div className="form-actions"><button className="primary" disabled={!!busy}>{busy === 'recalculate' ? 'Recalculating costs…' : 'Review recalculation'}</button></div>
          </fieldset>
        </form>
        <MaintenanceResult operation="recalculate" result={results.recalculate}/>
      </section>
    </div>
    {busy && <p role="status">{busy === 'delete' ? 'Deleting old history.' : 'Recalculating costs.'} This may take a while. Keep this page open until the result appears.</p>}
    {confirmation && <Modal title={confirmation.operation === 'delete' ? 'Delete old history?' : 'Recalculate costs?'} onClose={() => setConfirmation(null)}>
      {confirmation.operation === 'delete' ? <>
        <p>Delete usage events, linked costs, and eligible completed requests strictly before <strong>{confirmation.dates.before} at 00:00 UTC</strong>, across all users and providers.</p>
        <p>This permanently removes history from reports and can reduce recorded consumption toward usage limits.</p>
        <label className="maintenance-acknowledgment"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} autoFocus/>I understand that this deletion cannot be undone.</label>
      </> : <>
        <p>Replace existing supported cost estimates for usage completed from <strong>{confirmation.dates.start} at 00:00 UTC</strong> up to, but excluding, <strong>{confirmation.dates.end} at 00:00 UTC</strong>.</p>
        <p>Current prices will be used. Missing comparison costs are calculated when the requested model or provider differs and suitable prices are available. Reported tokens remain unchanged. Reports and cost-based usage limits may change.</p>
      </>}
      <div className="form-actions">
        <button onClick={() => setConfirmation(null)}>Cancel</button>
        <button className={confirmation.operation === 'delete' ? 'maintenance-danger' : 'primary'} disabled={confirmation.operation === 'delete' && !acknowledged} onClick={run}> {confirmation.operation === 'delete' ? 'Delete history permanently' : 'Recalculate costs'}</button>
      </div>
    </Modal>}
  </section>;
}

function MaintenanceResult({ operation, result }) {
  if (!result) return null;
  const { data, dates, error } = result;
  const failed = !!error || data?.completed === false;
  const counts = operation === 'delete' ? [
    ['deleted_events', 'Usage events deleted'], ['deleted_costs', 'Cost assessments deleted'], ['deleted_requests', 'Requests deleted'],
  ] : [
    ['recalculated_events', 'Assessments recalculated'], ['skipped_unsupported', 'Unsupported assessments skipped'], ['skipped_missing_assessment', 'Events without assessments skipped'],
  ];
  return <div className="maintenance-result" role="status">
    <ErrorBox error={error}/>
    {dates && <>
      <strong>{failed ? 'Operation incomplete' : operation === 'delete' ? 'Deletion complete' : 'Recalculation complete'}</strong>
      <p>{operation === 'delete' ? `Before ${dates.before}, 00:00 UTC` : `${dates.start} to ${dates.end} (end excluded), UTC`}</p>
      {data && <dl>{counts.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{number(data[key])}</dd></div>)}</dl>}
      {failed && <p>Some records may already have changed. Retry the same dates to finish.</p>}
    </>}
  </div>;
}
