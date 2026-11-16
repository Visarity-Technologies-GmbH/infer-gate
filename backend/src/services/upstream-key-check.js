import { fail } from "../errors.js";
import { prepareProviderRequest, executeProviderRequest } from '../providers/index.js';
import { filterModelList } from './model-list.js';

// Diagnostic only: no inference, request accounting, or credential state changes.
export async function checkUpstreamKey(assignment, config, { fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(Math.min(config.timeout || 15000, 15000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = (status, message, extra = {}) => ({ status, message, checked_at: new Date().toISOString(), ...extra });
  try {
    const request = { method: 'GET', url: '/models', get: () => undefined };
    const plan = prepareProviderRequest(assignment, request, undefined, config, combined);
    const upstream = await executeProviderRequest(plan, fetchImpl);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const messages = { 401: 'Credential rejected', 403: 'Access denied', 404: 'Models endpoint not found', 429: 'Provider rate limit reached' };
      return result('FAILED', messages[upstream.status] || 'Provider request failed', { http_status: upstream.status });
    }
    const catalogue = await filterModelList(upstream, [], 'ALLOW');
    return result('SUCCESS', 'Models API reachable', { http_status: upstream.status, model_count: catalogue.data.length });
  } catch (error) {
    // Never return provider bodies, URLs, credential references, or exception messages.
    const message = combined.aborted ? 'Check timed out or was cancelled'
      : error.code === 'upstream_credential_unavailable' ? 'Credential environment variable is unavailable'
      : error.code === 'invalid_model_list' ? 'Provider returned an invalid model list'
      : 'Unable to complete models API check';
    return result('FAILED', message);
  }
}

// Fresh administrator inspection, including disabled credentials, without role policies.
export async function listUpstreamModels(assignment, config, { fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(Math.min(config.timeout || 15000, 15000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const plan = prepareProviderRequest(assignment, { method: 'GET', url: '/models', get: () => undefined }, undefined, config, combined);
    const upstream = await executeProviderRequest(plan, fetchImpl);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new Error('Provider discovery failed');
    }
    const catalogue = await filterModelList(upstream, [], 'ALLOW');
    return { data: [...new Set(catalogue.data.map(model => model.id))].sort((a, b) => a.localeCompare(b)).map(id => ({ id })) };
  } catch (error) {
    const message = combined.aborted ? 'Model discovery timed out or was cancelled.'
      : error.code === 'invalid_model_list' ? 'Provider returned an invalid model list.'
      : 'Unable to load models. Check the upstream credential and provider configuration.';
    fail(502, 'model_discovery_failed', message);
  }
}
