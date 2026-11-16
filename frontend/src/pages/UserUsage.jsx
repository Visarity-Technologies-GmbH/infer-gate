import { Activity } from "../components/Activity";
import React, { useEffect, useMemo, useState } from 'react';
import { createClient } from '../api/client';
import { ErrorBox } from '../components/ui';

const utc = value => value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
const count = value => value == null ? '—' : new Intl.NumberFormat('en').format(BigInt(value));
const decimal = value => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function UserUsage({ viewingKey }) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const previous = document.title;
    document.title = 'InferGate · Your usage';
    return () => { document.title = previous; };
  }, []);
  const api = useMemo(() => createClient(viewingKey, () => {}, '/user'), [viewingKey]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    api('/usage', { signal: controller.signal }).then(value => {
      if (active) { setData(value); setError(''); }
    }).catch(e => {
      if (active) { setData(null); setError(e.message); }
    }).finally(() => active && setBusy(false));
    const timer = setTimeout(() => setRevision(value => value + 1), 60000);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, revision]);
  const cap = data?.cap;
  const completePricing = data && Number(data.today.usage_events) > 0 && String(data.today.priced_events) === String(data.today.usage_events);
  const unit = cap?.basis === 'TOKENS' ? 'million tokens' : 'USD (estimated)';
  return <main className="user-usage">
    <header className="page-heading">
      <div><span className="eyebrow">INFERGATE · YOUR USAGE{data?.user && <>: {data.user.name} ({data.user.email})</>}</span><h1>Today’s token consumption</h1>
        <p>Today is measured from 00:00 to 24:00 UTC across all your proxy API keys.</p></div>
      <button disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Refreshing…' : 'Refresh'}</button>
    </header>
    <ErrorBox error={error} />
    {!data && busy && <p role="status">Loading your usage…</p>}
    {data && <>
      <section className="panel user-usage-panel" aria-label="Today’s tokens">
        <h2>{data.today.start.slice(0, 10)} · UTC</h2>
        <dl className="user-usage-tokens">{[['total_tokens', 'Total tokens'], ['input_tokens', 'Input tokens'], ['output_tokens', 'Output tokens']].map(([key, label]) =>
          <div key={key}><dt>{label}</dt><dd>{count(Number(data.today.usage_events) === 0 ? '0' : data.today[key])}</dd></div>
        )}</dl>
        <p className="muted">Reported usage includes failed or cancelled requests when tokens were reported. Missing counts appear as —; totals can be incomplete when some requests lack usage.</p>
      </section>
      <section className="panel user-usage-panel" aria-label="Today’s estimated cost">
        <h2>Today’s estimated cost · UTC</h2>
        <dl className="user-usage-cap">
          {(data.today.costs || []).filter(cost => cost.currency).length ? data.today.costs.filter(cost => cost.currency).map(cost =>
            <div key={cost.currency}><dt>{completePricing ? 'Estimated cost' : 'Known portion of estimated cost'} · {cost.currency}</dt>
              <dd>{(completePricing ? cost.estimated_cost : cost.known_cost) == null ? '—' : `${decimal(completePricing ? cost.estimated_cost : cost.known_cost)} ${cost.currency}`}</dd></div>
          ) : <div><dt>Estimated cost</dt><dd>—</dd></div>}
        </dl>
        {Number(data.today.usage_events) === 0 ? <p className="muted">No usage recorded today.</p> : <>
          <p>{count(data.today.priced_events)} of {count(data.today.usage_events)} usage events fully priced.
            {!completePricing && ' Pricing coverage is incomplete; only known costs are shown.'}</p>
          {!completePricing && <p className="muted">Partial estimates: {count(data.today.partial_events)} · Unpriced: {count(data.today.unpriced_events)} · Unsupported: {count(data.today.unsupported_events)}</p>}
        </>}
        <p className="muted">Estimates cover today’s reported usage, including failed or cancelled requests with recorded costs. They exclude taxes and invoice adjustments. Currencies are shown separately.</p>
      </section>
      <section className="panel user-usage-panel" aria-label="Your usage cap">
        <h2>Your usage cap</h2>
        {!cap.enabled ? <p>No usage cap configured.</p> : <>
          <p><strong>{cap.blocked ? 'Usage cutoff reached' : 'Below usage cutoff'}</strong> · {cap.period === 'WEEKLY' ? 'Weekly' : 'Daily'} cap</p>
          <dl className="user-usage-cap">
            <div><dt>Configured cap</dt><dd>{decimal(cap.amount)} {unit}</dd></div>
            <div><dt>Consumed this {cap.period === 'WEEKLY' ? 'week' : 'day'}</dt><dd>{decimal(cap.consumed)} {unit}</dd></div>
            <div><dt>95% cutoff</dt><dd>{decimal(cap.cutoff)} {unit}</dd></div>
            <div><dt>Remaining until cutoff</dt><dd>{decimal(cap.remaining)} {unit}</dd></div>
          </dl>
          <p>Period starts: {utc(cap.period_start)}<br />Next reset: {utc(cap.resets_at)}</p>
          <p className="muted">New requests stop at 95% of the configured cap. Only successful requests with usable consumption count toward the cap; missing prices count as zero for estimated cost caps. Requests already in progress may exceed the cutoff.</p>
        </>}
      </section>
      {data.activity && <section className="panel user-activity" aria-label="Your token activity">
        <div className="panel-toolbar">
          <div><h2>Token activity</h2><p>Daily reported consumption · Last 14 days (UTC), including today</p></div>
          <span className="legend"><i /> Total tokens</span>
        </div>
        <Activity days={data.activity.days} label={`Your daily reported total tokens (UTC). ${data.activity.days.map(day => `${day.bucket}: ${count(day.total_tokens)} tokens`).join('; ')}`} />
        <p className="muted user-activity-note">Only your usage is shown. Today is still in progress. Days without usage show zero; missing counts appear as — in bar details. Totals may be incomplete when usage is not reported.</p>
      </section>}
      <p className="muted" role="status">Updated {utc(data.updated_at)} · Refreshes every minute.</p>
    </>}
  </main>;
}
