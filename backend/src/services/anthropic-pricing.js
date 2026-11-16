import { fail } from '../errors.js';

export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const invalidPage = () => fail(502, 'invalid_anthropic_pricing', 'Anthropic model pricing table is missing or has an unsupported format');

function cellText(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/&(?:nbsp|amp|dollar|ndash|mdash);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&dollar;': '$', '&ndash;': '–', '&mdash;': '—' })[entity])
    .replace(/\s+/g, ' ').trim();
}

function rate(cell) {
  const text = cellText(cell);
  if (/^(?:—|–|-|N\/A)(?:\s*\/\s*MTok)?$/i.test(text)) return null;
  const match = /^\$\s*(\d+(?:\.\d+)?)\s*\/\s*MTok\b/.exec(text);
  if (!match || !Number.isFinite(Number(match[1]))) invalidPage();
  return Number(match[1]);
}

export function parseAnthropicPricing(html) {
  // Scope to standard model pricing: batch, fast mode and partner tables have different rates.
  const heading = /<h2\b[^>]*\bid=["']model-pricing["'][^>]*>/i.exec(html);
  if (!heading) invalidPage();
  const section = html.slice(heading.index + heading[0].length).split(/<h2\b/i)[0];
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(section)?.[1];
  if (!table) invalidPage();
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const headers = rows.map(row => [...row.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => cellText(match[1])));
  const expected = ['Name', 'Input', 'Output', '5m writes', '1h writes', 'Hits and refreshes'];
  if (!headers.some(header => header.length === expected.length && expected.every((label, index) => header[index] === label))) invalidPage();
  const models = [], seen = new Set();
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    if (!cells.length) continue;
    const name = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)*)(?=\s|$)/.exec(cellText(cells[0]));
    // Additional-model separator rows and rowspan continuation tiers are not base prices.
    if (!name) {
      if (/^Claude\b/.test(cellText(cells[0]))) invalidPage();
      continue;
    }
    if (cells.length !== 6) invalidPage();
    const model = `claude-${name[1].toLowerCase()}-${name[2].replaceAll('.', '-')}`;
    if (seen.has(model)) invalidPage();
    seen.add(model);
    const [input, output, cache_write_5m, cache_write_1h, cache_read] = cells.slice(1).map(rate);
    if (input === null || output === null) invalidPage();
    models.push({ model, pricing: { input, output, cache_read, cache_write: null, cache_write_5m, cache_write_1h } });
  }
  if (!models.length) invalidPage();
  return models;
}

export async function fetchAnthropicPricing(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(ANTHROPIC_PRICING_URL, {
      signal: AbortSignal.timeout(30000), redirect: 'error', headers: { accept: 'text/html' },
    });
    if (!response.ok || !response.body) fail(502, 'anthropic_pricing_fetch_failed', 'Unable to download Anthropic pricing');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_PAGE_BYTES) invalidPage();
      chunks.push(Buffer.from(chunk));
    }
    return parseAnthropicPricing(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (['invalid_anthropic_pricing', 'anthropic_pricing_fetch_failed'].includes(error.code)) throw error;
    fail(502, 'anthropic_pricing_fetch_failed', 'Unable to download Anthropic pricing');
  }
}
