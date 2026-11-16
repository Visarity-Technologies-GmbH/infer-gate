// Only * is special; all other characters are literal. Match case-sensitively.
function matchesPattern(model, pattern) {
  if (typeof model !== 'string') return false;
  const parts = pattern.split('*');
  const first = parts.shift(), last = parts.pop();
  if (!model.startsWith(first) || !model.endsWith(last)) return false;
  let offset = first.length;
  const end = model.length - last.length;
  if (offset > end) return false;
  for (const part of parts) {
    const index = model.indexOf(part, offset);
    if (index < 0 || index + part.length > end) return false;
    offset = index + part.length;
  }
  return true;
}
export function modelAllowed(model, policies, fallback = 'DENY') {
  const exact = policies.filter(rule => !rule.model_pattern.includes('*') && rule.model_pattern === model);
  if (exact.some(rule => rule.policy === 'DENY')) return false;
  if (exact.some(rule => rule.policy === 'ALLOW')) return true;
  const patterns = policies.filter(rule => rule.model_pattern !== '*' && rule.model_pattern.includes('*') && matchesPattern(model, rule.model_pattern));
  if (patterns.some(rule => rule.policy === 'DENY')) return false;
  if (patterns.some(rule => rule.policy === 'ALLOW')) return true;
  const wildcard = policies.filter(rule => rule.model_pattern === '*');
  if (wildcard.some(rule => rule.policy === 'DENY')) return false;
  if (wildcard.some(rule => rule.policy === 'ALLOW')) return true;
  return fallback === 'ALLOW';
}
export function modelAllowedByPolicies(model, rules, fallback = 'DENY') {
  // An empty policy list means there are no policy groups to constrain this
  // catalogue. Apply the caller's fallback directly (admin discovery passes
  // ALLOW so upstream keys show every advertised model).
  if (rules.length === 0) return modelAllowed(model, [], fallback);
  const groups = new Map();
  for (const rule of rules) {
    const id = rule.model_policy_id ?? 'default';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(rule);
  }
  return [...groups.values()].some(policy => modelAllowed(model, policy, fallback));
}
