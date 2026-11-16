export const overridePriceFields = [
  ['input', 'Input', 'input_price_per_million'],
  ['output', 'Output', 'output_price_per_million'],
  ['cache_read', 'Cache read', 'cached_input_price_per_million'],
  ['cache_write', 'Cache write (generic)', 'cache_write_price_per_million'],
  ['cache_write_5m_rate', 'Cache write (5 min)', 'cache_write_5m_rate'],
  ['cache_write_1h_rate', 'Cache write (1 hour)', 'cache_write_1h_rate'],
];

export const overrideValues = row => Object.fromEntries(overridePriceFields.map(([key, , column]) => [key, row[column] ?? '']));

// Compare decimal strings without floating-point conversion or marking formatting-only changes.
const normalizedPrice = value => {
  const text = String(value ?? '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return text;
  return text.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};
export const samePrice = (left, right) => normalizedPrice(left) === normalizedPrice(right);

export function applyClaudePricing(rows, drafts, pricing) {
  const candidates = [...pricing].sort((left, right) => right.model.length - left.model.length);
  const next = { ...drafts };
  let updatedCount = 0;
  for (const row of rows) {
    const match = candidates.find(entry => row.model_pattern.includes(entry.model));
    if (!match) continue;
    const original = overrideValues(row), current = drafts[row.id] || original;
    const values = Object.fromEntries(overridePriceFields.map(([key]) => {
      const rate = match.pricing[key.replace(/_rate$/, '')];
      const value = rate == null ? '' : String(rate);
      return [key, samePrice(value, original[key]) ? original[key] : value];
    }));
    if (overridePriceFields.some(([key]) => !samePrice(current[key], values[key]))) {
      next[row.id] = values;
      updatedCount++;
    }
  }
  return { drafts: next, updatedCount };
}
