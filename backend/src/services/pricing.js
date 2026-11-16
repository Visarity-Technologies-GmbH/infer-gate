import { createHash } from 'node:crypto';
import { normalizeRate } from './accounting.js';
import { fail } from '../errors.js';
export const PRICING_URL = 'https://raw.githubusercontent.com/WyrdWerk/tokenwatch/refs/heads/main/public/pricing.json';
export function parseCatalog(text) {
  let source;
  try { source = JSON.parse(text); } catch { fail(502, 'invalid_pricing_feed', 'Pricing feed is not valid JSON'); }
  const generated = new Date(source?.generated_at);
  if (!source?.generated_at || !Number.isFinite(generated.getTime()) || generated.getTime() > Date.now() + 86400000 || !Array.isArray(source.models) || !source.models.length || source.models.length > 20000) fail(502, 'invalid_pricing_feed', 'Pricing feed has an invalid timestamp or model catalog');
  const seen = new Set();
  const models = source.models.map(row => {
    if (!row || typeof row.provider !== 'string' || !row.provider || row.provider.length > 255 || typeof row.id !== 'string' || !row.id || row.id.length > 255 || !row.pricing || (row.subscription !== undefined && typeof row.subscription !== 'boolean')) fail(502, 'invalid_pricing_feed', 'Pricing feed contains invalid model metadata');
    const key = JSON.stringify([row.provider, row.id]);
    if (seen.has(key)) fail(502, 'invalid_pricing_feed', 'Pricing feed contains duplicate models');
    seen.add(key);
    let rates;
    try { rates = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'].map(key => normalizeRate(key.endsWith('5m') || key.endsWith('1h') ? row.pricing[key] ?? null : row.pricing[key])); }
    catch { fail(502, 'invalid_pricing_feed', 'Pricing feed contains invalid prices'); }
    return { provider: row.provider, model: row.id, rates, subscription: !!row.subscription };
  });
  return { generated, models, checksum: createHash('sha256').update(text).digest('hex') };
}
export async function fetchCatalog(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(PRICING_URL, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || !response.body) fail(502, 'pricing_fetch_failed', 'Unable to download TokenWatch pricing');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 10 * 1024 * 1024) fail(502, 'invalid_pricing_feed', 'Pricing feed exceeds 10 MB');
      chunks.push(Buffer.from(chunk));
    }
    return parseCatalog(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.code === 'invalid_pricing_feed' || error.code === 'pricing_fetch_failed') throw error;
    fail(502, 'pricing_fetch_failed', 'Unable to download TokenWatch pricing; existing prices were retained');
  }
}
export async function lockPricing(tx) { await tx.query('SELECT id FROM pricing_state WHERE id=1 FOR UPDATE'); }
// Detach assessments before deleting prices; stored monetary estimates remain unchanged.
export async function removePrices(tx, ids) {
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200), placeholders = batch.map(() => '?').join(',');
    await tx.query(`UPDATE usage_costs SET pricing_id=NULL WHERE pricing_id IN (${placeholders})`, batch);
    deleted += (await tx.query(`DELETE FROM model_pricing WHERE id IN (${placeholders})`, batch)).affectedRows;
  }
  return deleted;
}
export async function syncProvider(tx, provider, importId, reset = false) {
  const rows = provider.pricing_provider_key && importId ? await tx.query('SELECT * FROM pricing_catalog WHERE import_id=? AND provider_key=?', [importId, provider.pricing_provider_key]) : [];
  const aliases = await tx.query('SELECT model_id,source_model_id FROM pricing_model_aliases WHERE provider_id=?', [provider.id]);
  const current = await tx.query("SELECT * FROM model_pricing WHERE provider_id=? AND source_kind='FEED'", [provider.id]);
  const previous = new Map(current.map(row => [row.model_pattern, row]));
  const catalog = new Map(rows.map(row => [row.model_id, row]));
  const matches = new Map(catalog);
  for (const alias of aliases) { const row = catalog.get(alias.source_model_id); if (row) matches.set(alias.model_id, row); }
  if (reset) await removePrices(tx, current.filter(row => !matches.has(row.model_pattern)).map(row => row.id));
  let added = 0, changed = 0;
  const rateKeys = ['input_price_per_million','output_price_per_million','cached_input_price_per_million','cache_write_price_per_million','cache_write_5m_rate','cache_write_1h_rate'];
  for (const [model, row] of matches) {
    const rates = [row.input_rate, row.output_rate, row.cache_read_rate, row.cache_write_rate, row.cache_write_5m_rate, row.cache_write_1h_rate];
    const old = previous.get(model);
    if (old && old.source_model_id === row.model_id && !!old.subscription === !!row.subscription && rateKeys.every((key, i) => old[key] === rates[i])) continue;
    if (old) {
      await tx.query(`UPDATE model_pricing SET ${rateKeys.map(key => `${key}=?`).join(',')},currency='USD',import_id=?,source_model_id=?,subscription=? WHERE id=?`, [...rates, importId, row.model_id, !!row.subscription, old.id]);
      changed++;
    } else {
      await tx.query(`INSERT INTO model_pricing(provider_id,model_pattern,${rateKeys.join(',')},currency,import_id,source_model_id,source_kind,subscription) VALUES (?,?,?,?,?,?,?,?,'USD',?,?,'FEED',?)`, [provider.id, model, ...rates, importId, row.model_id, !!row.subscription]);
      added++;
    }
  }
  return { added, changed };
}
export async function importCatalog(db, catalog) {
  return db.transaction(async tx => {
    await lockPricing(tx);
    const [existing] = await tx.query('SELECT * FROM pricing_imports WHERE checksum=?', [catalog.checksum]);
    if (existing) return { unchanged: true, import_id: existing.id, model_count: existing.model_count, added: 0, changed: 0 };
    const [latest] = await tx.query('SELECT * FROM pricing_imports ORDER BY id DESC LIMIT 1');
    if (latest && new Date(latest.generated_at) > catalog.generated) fail(409, 'stale_pricing_feed', 'An older pricing snapshot cannot replace newer prices');
    const importedAt = new Date();
    const result = await tx.query('INSERT INTO pricing_imports(checksum,source_url,generated_at,imported_at,model_count) VALUES (?,?,?,?,?)', [catalog.checksum, PRICING_URL, catalog.generated, importedAt, catalog.models.length]);
    // Bounded batches keep SQL and parameter sizes small without a transaction per model.
    for (let offset = 0; offset < catalog.models.length; offset += 200) {
      const batch = catalog.models.slice(offset, offset + 200);
      await tx.query(`INSERT INTO pricing_catalog(import_id,provider_key,model_id,input_rate,output_rate,cache_read_rate,cache_write_rate,cache_write_5m_rate,cache_write_1h_rate,subscription) VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`, batch.flatMap(row => [result.insertId, row.provider, row.model, ...row.rates, row.subscription]));
    }
    const providers = await tx.query('SELECT id,pricing_provider_key FROM llm_inference_providers WHERE pricing_provider_key IS NOT NULL');
    let added = 0, changed = 0;
    for (const provider of providers) { const counts = await syncProvider(tx, provider, result.insertId); added += counts.added; changed += counts.changed; }
    return { unchanged: false, import_id: result.insertId, model_count: catalog.models.length, added, changed };
  });
}
