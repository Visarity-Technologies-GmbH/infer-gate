import React, { useEffect, useState } from 'react';
import { date } from '../api/client';
import { ErrorBox, Field, Table } from '../components/ui';
import { applyClaudePricing, overridePriceFields, overrideValues, samePrice } from './pricing-overrides.js';
export function PricingSettings({ api }) {
  const [drafts, setDrafts] = useState({});
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [preview, setPreview] = useState(null), [notice, setNotice] = useState('');
  const reload = () => api('/pricing').then(setData);
  useEffect(() => { let active = true; api('/pricing').then(value => active && setData(value)).catch(e => active && setError(e.message)); return () => { active = false; }; }, [api]);
  const run = async action => { setBusy(true); setError(''); try { await action(); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(false); } };
  return <section className="panel pricing-settings">
    <h2>Estimated costs</h2>
    <p>Import TokenWatch prices in USD per million tokens. Estimates use reported usage and current prices. Stored costs change only when explicitly recalculated.</p>
    <ErrorBox error={error}/>
    {notice && <p role="status">{notice}</p>}
    <p>{data?.latest ? `Last import: ${date(data.latest.imported_at)} · Source snapshot: ${date(data.latest.generated_at)} · ${data.latest.model_count} models` : 'No pricing imported yet.'}</p>
    {data?.latest && Date.now() - new Date(data.latest.generated_at).getTime() > 7 * 86400000 && <p>Prices are more than seven days old. Import a fresh snapshot.</p>}
    <a href={data?.source_url || 'https://raw.githubusercontent.com/WyrdWerk/tokenwatch/refs/heads/main/public/pricing.json'} target="_blank" rel="noreferrer">View pricing source</a>
    <div className="form-actions">
      <button className="primary" disabled={busy || !data} onClick={() => run(async () => { setNotice(''); setPreview(await api('/pricing/import', { method: 'POST', body: { preview: true } })); })}>{busy ? 'Working…' : 'Import pricing.json'}</button>
    </div>
    {preview && <div className="pricing-preview">
      <p>Snapshot {date(preview.generated_at)}: {preview.model_count} models from {preview.provider_count} providers. {preview.added} new, {preview.changed} changed, {preview.missing} missing. Missing prices are retained.</p>
      <button disabled={busy} className="primary" onClick={() => run(async () => { const result = await api('/pricing/import', { method: 'POST', body: { checksum: preview.checksum } }); setPreview(null); setNotice(result.unchanged ? 'This snapshot is already imported.' : `Imported ${result.model_count} models. ${result.added} provider prices added, ${result.changed} updated.`); await reload(); })}>Apply import</button>
      <button disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {data && <>
      <h3>Provider pricing mappings</h3>
      <p>Select the pricing provider used by each connection. Model IDs match exactly; add aliases where your API uses a different ID. Mapping changes apply to future requests.</p>
      {data.providers.map(provider => <ProviderMapping key={`${provider.id}:${data.latest?.id}:${provider.pricing_provider_key}`} provider={provider} catalog={data.catalog} aliases={data.aliases.filter(row => String(row.provider_id) === String(provider.id))} disabled={busy} onSave={body => run(async () => { await api(`/pricing/providers/${provider.id}`, { method: 'PUT', body }); await reload(); setNotice('Provider pricing mapping saved.'); })}/>)}
      {!!data.unmatched?.length && <><h3>Models without a current price</h3><p>Observed in the last 30 days. Add a model alias or manual price; up to 100 combinations.</p><Table rows={data.unmatched} columns={[
        ['Provider', r => data.providers.find(p => String(p.id) === String(r.provider_id))?.name || `#${r.provider_id}`], ['Model', r => r.model]
      ]}/></>}
      <h3>Manual price overrides</h3>
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          setNotice('');
          const pricing = await api('/pricing/anthropic');
          const result = applyClaudePricing(data.overrides, drafts, pricing);
          setDrafts(result.drafts);
          setNotice(result.updatedCount ? `Updated ${result.updatedCount} override ${result.updatedCount === 1 ? 'row' : 'rows'}. Review highlighted prices and save each row to apply changes.` : 'No override prices changed. Matching uses literal model IDs with hyphen-separated versions.');
        })}>Update Claude Pricing</button>
      </div>
      <p>Manual rates take precedence over imported rates for the exact provider and model. Edit rates below and save the row to apply them to future requests. Leave unavailable rates blank. Claude cache hits and refreshes use the cache-read rate. Five-minute writes use their specific rate, or the generic write rate when blank; one-hour writes require their own rate. Removing an override restores imported pricing for future requests.</p>
      <form className="pricing-override" onSubmit={e => { e.preventDefault(); const form = e.currentTarget, values = Object.fromEntries(new FormData(form)); for (const key of ['input','output','cache_read','cache_write','cache_write_5m_rate','cache_write_1h_rate']) if (values[key] === '') values[key] = null; run(async () => { await api('/pricing/overrides', { method: 'POST', body: values }); form.reset(); await reload(); setNotice('Manual pricing saved.'); }); }}>
        <Field label="Provider"><select name="provider_id" required disabled={busy}><option value="">Select provider</option>{data.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Exact model ID"><input name="model_id" required maxLength={255}/></Field>
        {[['input','Input'],['output','Output'],['cache_read','Cache read'],['cache_write','Cache write (generic)'],['cache_write_5m_rate','Cache write (5 min)'],['cache_write_1h_rate','Cache write (1 hour)']].map(([key,label]) => <Field key={key} label={`${label} · USD / million`}><input name={key} inputMode="decimal" placeholder="Unknown" pattern="[0-9]+(\.[0-9]+)?"/></Field>)}
        <button disabled={busy} className="primary">Save override</button>
      </form>
      <ManualOverrides rows={data.overrides} providers={data.providers} disabled={busy} drafts={drafts} setDrafts={setDrafts}
        onSave={(row, values) => run(async () => {
          await api('/pricing/overrides', { method: 'POST', body: { provider_id: row.provider_id, model_id: row.model_pattern, ...values } });
          await reload(); setNotice('Manual pricing updated. New rates apply to future requests.');
        })}
        onRemove={row => run(async () => { await api(`/pricing/overrides/${row.id}`, { method: 'DELETE' }); await reload(); })}/>
      <p className="muted">Unmatched models remain unpriced. Missing token details produce partial estimates. Regional Bedrock, special service tiers, subscriptions, and non-token charges are not included. Existing usage is not backfilled.</p>
    </>}
  </section>;
}
function ProviderMapping({ provider, catalog, aliases, disabled, onSave }) {
  const [key, setKey] = useState(provider.pricing_provider_key || ''), [rows, setRows] = useState(aliases);
  const keys = [...new Set(catalog.map(row => row.provider_key))].sort();
  const models = catalog.filter(row => row.provider_key === key);
  return <form className="pricing-mapping" onSubmit={e => { e.preventDefault(); onSave({ provider_key: key || null, aliases: key ? rows.map(({model_id,source_model_id}) => ({ model_id,source_model_id })) : [] }); }}>
    <strong>{provider.name}</strong>
    <Field label="Pricing provider"><select value={key} disabled={disabled} onChange={e => { setKey(e.target.value); setRows([]); }}><option value="">Unmapped</option>{keys.map(k => <option key={k}>{k}</option>)}</select></Field>
    {rows.map((row, index) => {
      const selectedModel = models.find(model => model.model_id === row.source_model_id);
      return <div className="pricing-alias" key={index}>
      <Field label="API model ID"><input required maxLength={255} value={row.model_id} onChange={e => setRows(current => current.map((r,i) => i === index ? { ...r, model_id: e.target.value } : r))}/></Field>
      <Field label="Pricing model"><select required value={row.source_model_id} onChange={e => setRows(current => current.map((r,i) => i === index ? { ...r, source_model_id: e.target.value } : r))}><option value="">Select model</option>{models.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id}{m.subscription ? ' (subscription)' : ''}</option>)}</select></Field>
      {row.source_model_id && <div className="pricing-model-rates" aria-live="polite">
        <p>Catalog prices · USD per million tokens</p>
        <dl>
          {[['input_rate','Input'],['output_rate','Output'],['cache_read_rate','Cache read'],['cache_write_rate','Cache write (generic)'],['cache_write_5m_rate','Cache write (5 min)'],['cache_write_1h_rate','Cache write (1 hour)']].map(([field,label]) => {
            const rate = selectedModel?.[field];
            return <div key={field}><dt>{label}</dt><dd>{rate == null ? 'Unavailable' : `$${String(rate).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`}</dd></div>;
          })}
        </dl>
      </div>}
      <button type="button" disabled={disabled} onClick={() => setRows(current => current.filter((_,i) => i !== index))}>Remove alias</button>
    </div>; })}
    <div className="form-actions"><button type="button" disabled={disabled || !key || rows.length >= 500} onClick={() => setRows(current => [...current,{model_id:'',source_model_id:''}])}>Add model alias</button><button disabled={disabled} className="primary">Save mapping</button></div>
  </form>;
}

function ManualOverrides({ rows, providers, disabled, drafts, setDrafts, onSave, onRemove }) {
  const discard = id => setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
  const providerName = row => providers.find(provider => String(provider.id) === String(row.provider_id))?.name || `#${row.provider_id}`;
  const changed = row => {
    const original = overrideValues(row), draft = drafts[row.id];
    return draft && overridePriceFields.some(([key]) => !samePrice(draft[key], original[key]));
  };
  return <div className="override-prices-table"><Table rows={rows} columns={[
    ['Provider', providerName], ['Model', row => <>{row.model_pattern}{changed(row) && <span className="override-price-status">Unsaved changes</span>}</>],
    ...overridePriceFields.map(([key, label]) => [`${label} / M`, row => <input
      className={`override-price-input${drafts[row.id] && !samePrice(drafts[row.id][key], overrideValues(row)[key]) ? ' is-changed' : ''}`} aria-label={`${label} price for ${providerName(row)} / ${row.model_pattern}`}
      title={drafts[row.id] && !samePrice(drafts[row.id][key], overrideValues(row)[key]) ? 'Unsaved price change' : undefined}
      form={`override-prices-${row.id}`} name={key} inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" placeholder="Unknown"
      disabled={disabled} value={(drafts[row.id] || overrideValues(row))[key]}
      onChange={event => { const value = event.target.value; setDrafts(current => ({ ...current, [row.id]: { ...(current[row.id] || overrideValues(row)), [key]: value } })); }}/>]),
    ['Actions', row => <div className="override-price-actions">
      <form id={`override-prices-${row.id}`} onSubmit={async event => {
        event.preventDefault();
        const values = Object.fromEntries(Object.entries(drafts[row.id] || overrideValues(row)).map(([key,value]) => [key, value === '' ? null : value]));
        if (await onSave(row, values)) discard(row.id);
      }}>
        <button type="submit" className="primary" disabled={disabled || !changed(row)}>Save</button>
        <button type="button" disabled={disabled || !changed(row)} onClick={() => discard(row.id)}>Cancel</button>
      </form>
      <button type="button" disabled={disabled} onClick={() => onRemove(row)}>Remove override</button>
    </div>]
  ]} empty={{ title: 'No manual overrides', detail: 'Imported prices apply to mapped providers.' }}/></div>;
}
