import { Router } from 'express';
import { fetchAnthropicPricing } from '../services/anthropic-pricing.js';
import { fetchCatalog, importCatalog, lockPricing, syncProvider, removePrices, PRICING_URL } from '../services/pricing.js';
import { normalizeRate } from '../services/accounting.js';
import { fail } from '../errors.js';
const text = value => { if (typeof value !== 'string' || !value.trim() || value.length > 255) fail(400, 'invalid_pricing_input', 'Use a non-empty identifier up to 255 characters'); return value; };
const id = value => { if (!/^[1-9]\d{0,18}$/.test(String(value))) fail(400, 'invalid_id', 'Invalid identifier'); return String(value); };
export function pricingRouter(db, dependencies = {}) {
  const router = Router();
  let downloading = false;
  router.get('/pricing/anthropic', async (req, res) => {
    res.json(await fetchAnthropicPricing(dependencies.anthropicPricingFetchImpl));
  });
  router.get('/pricing', async (req, res) => {
    const [latest] = await db.query('SELECT * FROM pricing_imports ORDER BY id DESC LIMIT 1');
    const providers = await db.query('SELECT id,name,pricing_provider_key,api_type FROM llm_inference_providers ORDER BY id');
    const catalog = latest ? await db.query('SELECT provider_key,model_id,subscription,input_rate,output_rate,cache_read_rate,cache_write_rate,cache_write_5m_rate,cache_write_1h_rate FROM pricing_catalog WHERE import_id=? ORDER BY provider_key,model_id', [latest.id]) : [];
    const aliases = await db.query('SELECT * FROM pricing_model_aliases ORDER BY provider_id,model_id');
    const overrides = await db.query("SELECT * FROM model_pricing WHERE source_kind='MANUAL' ORDER BY provider_id,model_pattern");
    const unmatched = await db.query(`SELECT DISTINCT e.provider_id,e.model FROM usage_events e
      LEFT JOIN model_pricing p ON p.provider_id=e.provider_id AND p.model_pattern=e.model
      WHERE e.timestamp>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 30 DAY) AND e.model IS NOT NULL AND p.id IS NULL LIMIT 100`);
    res.json({ unmatched, source_url: PRICING_URL, currency: 'USD', units: 'per million tokens', latest: latest || null, providers, catalog, aliases, overrides });
  });
  router.post('/pricing/import', async (req, res) => {
    if (downloading) fail(409, 'pricing_import_running', 'A pricing download is already running');
    downloading = true;
    try {
      const catalog = await fetchCatalog(dependencies.pricingFetchImpl);
      if (req.body?.preview) {
        const [latest] = await db.query('SELECT * FROM pricing_imports ORDER BY id DESC LIMIT 1');
        const old = latest ? await db.query('SELECT * FROM pricing_catalog WHERE import_id=?', [latest.id]) : [];
        const map = new Map(old.map(row => [JSON.stringify([row.provider_key, row.model_id]), row]));
        let added = 0, changed = 0;
        for (const row of catalog.models) {
          const previous = map.get(JSON.stringify([row.provider, row.model]));
          if (!previous) added++;
          else if ([previous.input_rate, previous.output_rate, previous.cache_read_rate, previous.cache_write_rate, previous.cache_write_5m_rate, previous.cache_write_1h_rate].some((rate, i) => rate !== row.rates[i]) || !!previous.subscription !== row.subscription) changed++;
        }
        res.json({ preview: true, checksum: catalog.checksum, generated_at: catalog.generated, model_count: catalog.models.length, provider_count: new Set(catalog.models.map(r => r.provider)).size, added, changed, missing: old.filter(row => !catalog.models.some(r => r.provider === row.provider_key && r.model === row.model_id)).length });
      } else {
        if (req.body?.checksum && req.body.checksum !== catalog.checksum) fail(409, 'pricing_feed_changed', 'The feed changed since preview. Preview the import again.');
        res.json(await importCatalog(db, catalog));
      }
    } finally { downloading = false; }
  });
  router.put('/pricing/providers/:id', async (req, res) => {
    const providerId = id(req.params.id), key = req.body?.provider_key === null ? null : text(req.body?.provider_key);
    if (!Array.isArray(req.body?.aliases) || req.body.aliases.length > 500) fail(400, 'invalid_pricing_input', 'Supply up to 500 model aliases');
    const aliases = req.body.aliases.map(row => ({ model: text(row?.model_id), source: text(row?.source_model_id) }));
    if (new Set(aliases.map(row => row.model)).size !== aliases.length) fail(400, 'invalid_pricing_input', 'Duplicate model aliases');
    await db.transaction(async tx => {
      await lockPricing(tx);
      const [provider] = await tx.query('SELECT id FROM llm_inference_providers WHERE id=? FOR UPDATE', [providerId]);
      if (!provider) fail(404, 'not_found', 'Provider not found');
      const [latest] = await tx.query('SELECT id FROM pricing_imports ORDER BY id DESC LIMIT 1');
      const models = key && latest ? await tx.query('SELECT model_id FROM pricing_catalog WHERE import_id=? AND provider_key=?', [latest.id, key]) : [];
      if (key && !models.length) fail(400, 'invalid_pricing_input', 'Select a provider from the imported catalog');
      const known = new Set(models.map(row => row.model_id));
      if (aliases.some(row => !known.has(row.source))) fail(400, 'invalid_pricing_input', 'Alias refers to an unknown pricing model');
      await tx.query('UPDATE llm_inference_providers SET pricing_provider_key=? WHERE id=?', [key, providerId]);
      await tx.query('DELETE FROM pricing_model_aliases WHERE provider_id=?', [providerId]);
      for (const row of aliases) await tx.query('INSERT INTO pricing_model_aliases(provider_id,model_id,source_model_id) VALUES (?,?,?)', [providerId, row.model, row.source]);
      await syncProvider(tx, { id: providerId, pricing_provider_key: key }, latest?.id, true);
    });
    res.sendStatus(204);
  });
  router.post('/pricing/overrides', async (req, res) => {
    const providerId = id(req.body?.provider_id), model = text(req.body?.model_id);
    let rates;
    try { rates = ['input','output','cache_read','cache_write','cache_write_5m_rate','cache_write_1h_rate'].map(key => normalizeRate(key.endsWith('_rate') ? req.body?.[key] ?? null : req.body?.[key])); }
    catch { fail(400, 'invalid_pricing_input', 'Use nonnegative decimal prices or null for unknown rates'); }
    await db.transaction(async tx => {
      await lockPricing(tx);
      const [provider] = await tx.query('SELECT id FROM llm_inference_providers WHERE id=?', [providerId]);
      if (!provider) fail(404, 'not_found', 'Provider not found');
      await tx.query(`INSERT INTO model_pricing(provider_id,model_pattern,input_price_per_million,output_price_per_million,cached_input_price_per_million,cache_write_price_per_million,cache_write_5m_rate,cache_write_1h_rate,currency,source_kind)
        VALUES (?,?,?,?,?,?,?,?,'USD','MANUAL') ON DUPLICATE KEY UPDATE
        input_price_per_million=?,output_price_per_million=?,cached_input_price_per_million=?,cache_write_price_per_million=?,cache_write_5m_rate=?,cache_write_1h_rate=?,
        currency='USD',subscription=FALSE,import_id=NULL,source_model_id=NULL`, [providerId, model, ...rates, ...rates]);
    });
    res.sendStatus(201);
  });
  router.delete('/pricing/overrides/:id', async (req, res) => {
    await db.transaction(async tx => {
      await lockPricing(tx);
      const [price] = await tx.query("SELECT id FROM model_pricing WHERE id=? AND source_kind='MANUAL' FOR UPDATE", [id(req.params.id)]);
      if (!price) fail(404, 'not_found', 'Override not found');
      await removePrices(tx, [price.id]);
    });
    res.sendStatus(204);
  });
  return router;
}
