import { fail } from '../errors.js';
import { decrypt } from './credentials.js';

const environmentReference = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
export function validateUpstreamCredential(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n]/.test(value)) {
    fail(400, 'invalid_key', 'Invalid API key');
  }
  if (value.startsWith('$') && !environmentReference.test(value)) {
    fail(400, 'invalid_key_reference', 'Use $ followed by an environment variable name');
  }
  return value;
}

// Store the encrypted reference, never the resolved environment secret. Resolve
// once per outgoing request; environment values are not recursively expanded.
export function resolveUpstreamCredential(encrypted, encryptionKey, env = process.env) {
  const stored = decrypt(encrypted, encryptionKey);
  if (!stored.startsWith('$')) return stored;
  const name = stored.slice(1);
  const value = environmentReference.test(stored) && Object.hasOwn(env, name) ? env[name] : undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
    fail(503, 'upstream_credential_unavailable', 'Upstream credential environment variable is missing or invalid');
  }
  return value;
}
