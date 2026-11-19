import { compactSystemBody } from '../services/system-prompt-compaction.js';
import { validateResponsesInput } from '../services/responses-input.js';
import { responsesClassifierMessages } from '../services/responses-classification.js';
import { createDiscoveryCooldown } from '../services/discovery-cooldown.js';
import { messagesPath, tokenCountPath, validateMessages } from '../providers/anthropic-messages.js';
import { createModelCatalogue } from '../services/model-catalogue.js';
import { createDebugLogger, debugLoggingEnabled } from '../services/debug-log.js';
import { classifyMessages, classificationPromptReplacement } from '../services/classification.js';
import { classificationCacheKey } from '../services/classification-cache.js';
import { transformOutputStream } from '../services/output-stream.js';
import { updateResponseOutput } from '../services/output-script.js';
import { updateRequestInput } from '../services/input-script.js';
import { evaluateClassification } from '../services/evaluation.js';
import { supportsTokenBilling } from '../services/accounting.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { authenticate, authorize, routeForModel, modelListRoutes, evaluatedModel } from '../services/routing.js';
import { filterModelList } from '../services/model-list.js';
import { modelAllowed, modelAllowedByPolicies } from '../services/model-policy.js';
import { UsageCollector } from '../services/usage.js';
import { startRequest, finalizeRequest } from '../services/tracking.js';
import { enforceUsageLimit } from '../services/usage-limits.js';
import { responseHeaders } from '../providers/openai-compatible.js';
import { prepareProviderRequest, executeProviderRequest } from '../providers/index.js';
import { fail, HttpError } from '../errors.js';
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > limit) { req.resume(); fail(413, 'body_too_large', 'Request body too large'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function metadata(body, contentType, anthropic = false, counting = false) {
  if (!body.length) { if (anthropic) fail(400, 'invalid_body', 'A JSON body is required'); return {}; }
  if (contentType.includes('application/json')) {
    let data; try { data = JSON.parse(body.toString('utf8')); } catch { fail(400, 'invalid_json', 'Malformed JSON body'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_body', 'Expected a JSON object');
    if (data.model !== undefined && (typeof data.model !== 'string' || !data.model || data.model.length > 255)) fail(400, 'invalid_model', 'Invalid model');
    if (data.stream !== undefined && typeof data.stream !== 'boolean') fail(400, 'invalid_stream', 'Invalid stream flag');
    if (anthropic) validateMessages(data, counting);
    const messages = anthropic && data.system !== undefined ? [{ role: 'system', content: data.system }, ...data.messages] : data.messages;
    return { model: data.model, stream: data.stream, messages, cost_supported: supportsTokenBilling(data, { anthropic }) };
  }
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    let data; try { data = await new Request('http://localhost', { method: 'POST', body, headers: { 'content-type': contentType } }).formData(); } catch { fail(400, 'invalid_body', 'Malformed form body'); }
    const models = data.getAll('model');
    if (models.length > 1 || models.some(value => typeof value !== 'string' || !value || value.length > 255)) fail(400, 'invalid_model', 'Invalid model');
    return { model: models[0] };
  }
  return {};
}
export function proxyHandler(db, config, { fetchImpl = fetch, debugLogDirectory, classificationCache, stringCache, modelCatalogue, log = event => console.log(JSON.stringify(event)), discoveryCooldown = createDiscoveryCooldown(log) } = {}) {
  const cataloguesService = modelCatalogue ?? createModelCatalogue(config, { fetchImpl, log });
  const discover = (assignment, options) => discoveryCooldown(assignment, options,
    () => cataloguesService.get(assignment, options));
  const beginDebugLog = createDebugLogger({ log, directory: debugLogDirectory });
  return async (req, res, next) => {
    const anthropic = messagesPath(req.url), counting = tokenCountPath(req.url);
    res.locals.anthropicProtocol = anthropic;
    const record = { request_id: randomUUID(), endpoint: req.originalUrl.split('?')[0].slice(0, 2048), http_method: req.method, started_at: new Date(), request_status: 'RECEIVED' };
    res.setHeader('x-infergate-request-id', record.request_id);
    const controller = new AbortController(); let clientClosed = false, collector, timer, nativeAccounting, upstreamStarted = false;
    // A translated response may contain nullable protocol usage placeholders.
    // Only the actual upstream's usage is authoritative, even when absent.
    const requestUsage = () => counting ? null : nativeAccounting?.authoritativeUsage ? nativeAccounting.usage : nativeAccounting?.usage || collector?.usage;
    const disconnect = () => { if (!res.writableFinished) { clientClosed = true; controller.abort(); } };
    res.on('close', disconnect);
    let caught, debugLog, outputComplete = false;
    try {
      await startRequest(db, record);
      const apiKeyHeader = (anthropic || /^\/models\/?$/.test(req.url.split('?')[0])) && req.get('x-api-key');
      const key = await authenticate(db, req.get('authorization') ?? (apiKeyHeader ? `Bearer ${apiKeyHeader}` : undefined));
      record.user_id = key.user_id; record.proxy_api_key_id = key.id; authorize(key);
      record.role_id = key.role_id;
      record.user_name = key.user_name; record.user_email = key.user_email;
      record.role_name = key.role_name; record.proxy_api_key_name = key.proxy_api_key_name;
      await enforceUsageLimit(db, key.user_id);
      if (!key.role_id) fail(403, 'missing_role', 'No role is assigned to this proxy key');
      if (key.role_status !== 'ACTIVE') fail(403, 'role_disabled', 'Assigned role is disabled');
      const body = await readBody(req, config.bodyLimit);
      let forwardingBody = body;
      if (anthropic && req.method !== 'POST') fail(405, 'method_not_allowed', 'Anthropic Messages endpoints require POST');
      if (anthropic && !(req.get('content-type') || '').includes('application/json')) fail(400, 'invalid_content_type', 'Anthropic Messages endpoints require application/json');
      const meta = await metadata(body, req.get('content-type') || '', anthropic, counting);
      record.cost_supported = meta.cost_supported;
      record.model_requested = meta.model; record.stream = meta.stream || false;
      timer = setTimeout(() => controller.abort(new Error('timeout')), config.timeout); timer.unref();
      const responses = req.method === 'POST' && /^\/responses\/?$/.test(req.url.split('?')[0]);
      const classificationInputType = responses ? 'OPENAI_RESPONSES' : anthropic ? 'ANTHROPIC' : 'OPENAI';
      const chatCompletion = req.method === 'POST' && /^\/chat\/completions\/?$/.test(req.url.split('?')[0]);
      const supportsScripts = responses || chatCompletion || (anthropic && !counting);
      if (supportsScripts && (key.role_debug_enabled === true || key.role_debug_enabled === 1)) {
        try { if (await debugLoggingEnabled(db)) debugLog = await beginDebugLog(record, body); }
        catch { log({ event: 'debug_log_setting_read_failed', request_id: record.request_id }); }
      }
      if ((supportsScripts || counting) && forwardingBody?.length && (req.get('content-type') || '').includes('application/json') &&
          Object.values(key.system_prompt_compaction ?? {}).some(Boolean)) {
        forwardingBody = compactSystemBody(forwardingBody, classificationInputType, key.system_prompt_compaction);
        if (!responses && forwardingBody !== body)
          meta.messages = (await metadata(forwardingBody, 'application/json', anthropic, counting)).messages;
        await debugLog?.compactedInput(forwardingBody);
      }
      if (responses) meta.messages = forwardingBody.length && (req.get('content-type') || '').includes('application/json')
        ? responsesClassifierMessages(JSON.parse(forwardingBody.toString('utf8'))) : undefined;
      const catalogues = new Map();
      let discoveryBytes = 0;
      const lookup = async assignment => {
        const cacheKey = assignment.upstream_api_key_id;
        if (catalogues.has(cacheKey)) return catalogues.get(cacheKey);
        const response = await discover(assignment, {
          signal: controller.signal, requestId: record.request_id,
          onFetch: async () => {
            await db.query('UPDATE upstream_api_keys SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?', [assignment.upstream_api_key_id]);
            upstreamStarted = true;
          },
        });
        if (!response) { catalogues.set(cacheKey, null); return null; }
        if (!response.ok) { const status = response.status; await response.body?.cancel(); fail(status, 'model_discovery_failed', 'Upstream model discovery failed'); }
        const catalogue = await filterModelList(response, [], 'ALLOW');
        const ids = { data: catalogue.data.map(model => ({ id: model.id })) };
        discoveryBytes += Buffer.byteLength(JSON.stringify(ids));
        if (discoveryBytes > 10 * 1024 * 1024) fail(502, 'invalid_model_list', 'Combined provider model list exceeds the supported size');
        catalogues.set(cacheKey, ids);
        return ids;
      };
      const context = { user_id: key.user_id, role_id: key.role_id, request_id: record.request_id };
      const scriptHelpers = {
        logDebug: async (fileName, text) => debugLog ? debugLog.logDebug(fileName, text) : false,
        readStringCache: key => stringCache?.readStringCache(key) ?? null,
        writeStringCache: (key, value) => stringCache?.writeStringCache(key, value) ?? false,
      };
      let pendingCacheWrite;
      const cacheOptions = { signal: controller.signal, requestId: record.request_id };
      if (!counting && key.classification_handler_id != null && (meta.messages !== undefined || chatCompletion)) {
        const classificationInput = JSON.parse(forwardingBody.toString('utf8'));
        if (!Array.isArray(meta.messages)) fail(400, 'invalid_messages', 'Messages must be an array');
        const promptReplacement = await classificationPromptReplacement(meta.messages, key.classification_max_token, {
          script: key.prompt_script, input: classificationInput, inputType: classificationInputType,
          context, signal: controller.signal, helpers: scriptHelpers, scriptTimeouts: config.scriptTimeouts,
        });
        const cacheKey = classificationCache ? classificationCacheKey(key, meta.messages, responses ? 'OPENAI_RESPONSES' : anthropic ? 'ANTHROPIC' : undefined, promptReplacement, context, classificationInput) : null;
        let cached = cacheKey ? await classificationCache.get(cacheKey, cacheOptions) : null;
        let selectedModel;
        if (cached) {
          // Cache entries hold only the routing decision. Script context is per request and is never
          // stored or restored, so a hit cannot carry another request's user_id/request_id.
          record.classification_cache_hit = true;
          record.evaluation = { category: cached.category, sensitiveData: cached.sensitiveData, complexity: cached.complexity ?? null, models: null };
          selectedModel = cached.model;
        } else {
          const classification = await classifyMessages(db, key.classification_handler_id, meta.messages, config, {
            fetchImpl, signal: controller.signal, maxToken: key.classification_max_token ?? null, promptReplacement,
            onRequest: body => debugLog?.classificationRequest(body),
            onResult: result => debugLog?.classification(result),
          });
          const availableModels = new Set();
          let availableCatalogues = 0;
          for (const assignment of await modelListRoutes(db, key.role_id)) {
            const catalogue = await lookup(assignment);
            if (!catalogue) continue;
            availableCatalogues++;
            for (const model of catalogue.data) {
              availableModels.add(model.id);
              if (availableModels.size > 10000) fail(502, 'invalid_model_list', 'Combined provider model list exceeds the supported size');
            }
            const upstreamIds = new Set(catalogue.data.map(model => model.id));
            const aliases = await db.query(`SELECT DISTINCT entry.model_alias,entry.model_upstream
              FROM role_upstream_model_aliases assigned
              JOIN model_alias_entries entry ON entry.model_alias_id=assigned.model_alias_id
              WHERE assigned.role_upstream_assignment_id=?`, [assignment.role_upstream_assignment_id]);
            for (const alias of aliases) if (upstreamIds.has(alias.model_upstream)) availableModels.add(alias.model_alias);
          }
          if (!availableCatalogues) fail(503, 'model_discovery_unavailable', 'Upstream model discovery temporarily unavailable');
          record.evaluation = await evaluateClassification(key.evaluation_script, classificationInput, classification, [...availableModels], { signal: controller.signal, inputType: classificationInputType, context, helpers: scriptHelpers, scriptTimeouts: config.scriptTimeouts });
          await debugLog?.evaluation(record.evaluation);
          selectedModel = evaluatedModel(meta.model, record.evaluation.models, availableModels);
          if (cacheKey && selectedModel && availableCatalogues === catalogues.size) pendingCacheWrite = { key: cacheKey, value: {
            version: 1, model: selectedModel, category: record.evaluation.category, sensitiveData: record.evaluation.sensitiveData,
            complexity: record.evaluation.complexity,
          } };
        }
        if (selectedModel !== meta.model) {
          meta.model = selectedModel;
          record.model_resolved = selectedModel;
          forwardingBody = Buffer.from(JSON.stringify({ ...classificationInput, model: selectedModel }));
        }
      }
      const listingModels = req.method === 'GET' && /^\/models\/?$/.test(req.url.split('?')[0]);
      const resolvedRoute = !listingModels && meta.model ? await routeForModel(db, key.role_id, meta.model, lookup) : null;
      if (resolvedRoute && resolvedRoute.resolved_model !== meta.model) {
        meta.model = resolvedRoute.resolved_model;
        record.model_resolved = meta.model;
        const requestInput = JSON.parse(forwardingBody.toString('utf8'));
        requestInput.model = meta.model;
        forwardingBody = Buffer.from(JSON.stringify(requestInput));
      }
      const policies = await db.query('SELECT rp.model_policy_id,r.model_pattern,r.policy FROM role_model_policies rp LEFT JOIN model_policy_rules r ON r.model_policy_id=rp.model_policy_id WHERE rp.role_id=?', [key.role_id]);
      if (key.input_script != null && supportsScripts) {
        if (!(req.get('content-type') || '').includes('application/json'))
          fail(400, 'invalid_content_type', 'Input scripts require application/json');
        const updated = await updateRequestInput(key.input_script, JSON.parse(forwardingBody.toString('utf8')),
          classificationInputType, context, { signal: controller.signal, bodyLimit: config.bodyLimit, helpers: scriptHelpers, scriptTimeouts: config.scriptTimeouts });
        await debugLog?.updateInput(updated.input);
        if (responses) validateResponsesInput(updated.input, JSON.parse(body.toString('utf8')));
        const updatedMeta = await metadata(updated.body, 'application/json', anthropic);
        if (!responses && (!updatedMeta.model || !Array.isArray(updatedMeta.messages)))
          fail(502, 'invalid_input_script_result', 'Updated input must contain a model and messages array');
        Object.assign(meta, updatedMeta);
        forwardingBody = updated.body;
        record.model_resolved = meta.model;
        record.stream = meta.stream || false;
        record.cost_supported = meta.cost_supported;
      }
      // APIs that execute uploaded or stored work can hide the real model. Only known
      // direct-inference endpoints are safe for keys with model restrictions.
      const unrestricted = modelAllowedByPolicies(undefined, policies, config.modelDefault) && !policies.some(rule => rule.policy === 'DENY');
      const direct = ['/messages', '/messages/count_tokens', '/chat/completions', '/completions', '/responses', '/embeddings', '/moderations', '/images/generations', '/images/edits', '/audio/speech', '/audio/transcriptions', '/audio/translations'];
      if (!listingModels && !unrestricted && (req.method !== 'POST' || !direct.includes(req.url.split('?')[0].replace(/\/$/, '')))) fail(403, 'model_not_allowed', 'This endpoint requires unrestricted model access');
      // Object-based APIs can select a stored model implicitly. Restricted keys must supply a model.
      if (!listingModels && (meta.model ? !modelAllowedByPolicies(meta.model, policies, config.modelDefault) : !modelAllowedByPolicies(undefined, policies, config.modelDefault) || policies.some(rule => rule.policy === 'DENY'))) fail(403, 'model_not_allowed', 'Model is denied or cannot be authorized for this request');
      const assignments = listingModels ? await modelListRoutes(db, key.role_id) : [resolvedRoute || await routeForModel(db, key.role_id, meta.model, lookup)];
      const selected = assignments[0];
      record.api_type = selected.api_type;
      // A combined discovery request has no single upstream identity.
      record.upstream_api_key_id = assignments.length === 1 ? selected.upstream_api_key_id : null;
      record.upstream_name = assignments.length === 1 ? selected.upstream_name : null;
      record.provider_id = assignments.length === 1 ? selected.provider_id : null;
      record.model_resolved = meta.model;
      const plans = listingModels ? [] : assignments.map(assignment => prepareProviderRequest(assignment, req, forwardingBody, config, controller.signal));
      if (pendingCacheWrite) await classificationCache.set(pendingCacheWrite.key, pendingCacheWrite.value, cacheOptions);
      if (!listingModels && record.model_requested) {
        if (meta.model === record.model_requested) record.requestedProvider_id = selected.provider_id;
        else {
          // Attribute the original model using normal priority/alias routing, even
          // when evaluation sends inference to a different provider.
          try {
            record.requestedProvider_id = (await routeForModel(db, key.role_id, record.model_requested, lookup)).provider_id;
          } catch (error) {
            if (!(error instanceof HttpError) || !['model_not_available', 'model_discovery_unavailable'].includes(error.code)) throw error;
          }
        }
      }
      record.aws_region = assignments.length === 1 && selected.api_type === 'AWS_BEDROCK' ? selected.aws_region : null;
      await db.query("UPDATE api_requests SET request_status='FORWARDED',user_id=?,proxy_api_key_id=?,upstream_api_key_id=?,provider_id=?,model_requested=?,stream=?,aws_region=?,role_id=? WHERE id=?", [key.user_id, key.id, record.upstream_api_key_id, record.provider_id, record.model_requested || null, !!meta.stream, record.aws_region, record.role_id, record.id]);
      await db.query('UPDATE proxy_api_keys SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?', [key.id]);
      record.request_status = 'FORWARDED';
      let upstream, catalogue;
      const models = new Map(); let catalogueBytes = 0;
      for (const [index, assignment] of assignments.entries()) {
        const onFetch = async () => {
          await db.query('UPDATE upstream_api_keys SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?', [assignment.upstream_api_key_id]);
          upstreamStarted = true;
        };
        if (listingModels) {
          const options = { signal: controller.signal, requestId: record.request_id, url: req.url, onFetch };
          let response;
          try {
            response = assignments.length === 1
              ? await cataloguesService.get(assignment, options)
              : await discover(assignment, options);
            if (!response) continue;
            if (!response.ok && assignments.length > 1) {
              await response.body?.cancel();
              log({ event: 'model_discovery_skipped', upstream_api_key_id: assignment.upstream_api_key_id, status: response.status, request_id: record.request_id });
              continue;
            }
            if (response.ok) catalogue = await filterModelList(response, policies, config.modelDefault);
          } catch (error) {
            controller.signal.throwIfAborted();
            if (assignments.length === 1 || !['invalid_model_list', 'invalid_provider_response'].includes(error.code) &&
                error.name !== 'TypeError' && error.name !== 'TimeoutError') throw error;
            log({ event: 'model_discovery_skipped', upstream_api_key_id: assignment.upstream_api_key_id, request_id: record.request_id });
            continue;
          }
          upstream = response;
        } else {
          await onFetch();
          // Persist before execution so crashes cannot silently erase unknown consumption.
          record.usage_expected = req.method === 'POST' && !counting;
          if (record.usage_expected) await db.query('UPDATE api_requests SET usage_expected=TRUE WHERE id=?', [record.id]);
          upstream = await executeProviderRequest(plans[index], fetchImpl);
        }
        nativeAccounting = upstream.infergate;
        if (!listingModels || !upstream.ok) break;
        for (const model of catalogue.data) if (!models.has(model.id)) {
          catalogueBytes += Buffer.byteLength(JSON.stringify(model));
          if (catalogueBytes > 10 * 1024 * 1024) fail(502, 'invalid_model_list', 'Combined provider model list exceeds the supported size');
          models.set(model.id, model);
        }
        const availableModels = new Set(catalogue.data.map(model => model.id));
        const aliases = await db.query(`SELECT DISTINCT entry.model_alias,entry.model_upstream
          FROM role_upstream_model_aliases assigned
          JOIN model_alias_entries entry ON entry.model_alias_id=assigned.model_alias_id
          WHERE assigned.role_upstream_assignment_id=?`, [assignment.role_upstream_assignment_id]);
        for (const alias of aliases) if (availableModels.has(alias.model_upstream) && !models.has(alias.model_alias)) {
          const model = { id: alias.model_alias };
          catalogueBytes += Buffer.byteLength(JSON.stringify(model));
          if (catalogueBytes > 10 * 1024 * 1024) fail(502, 'invalid_model_list', 'Combined provider model list exceeds the supported size');
          models.set(alias.model_alias, model);
        }
      }
      if (!upstream) fail(503, 'model_discovery_unavailable', 'Upstream model discovery temporarily unavailable');
      record.http_status = upstream.status;
      record.upstream_request_id = assignments.length === 1 ? (upstream.headers.get('x-request-id') || (anthropic && upstream.headers.get('request-id')) || null)?.slice(0, 255) : null;
      if (listingModels && upstream.ok) {
        catalogue = { ...(assignments.length === 1 ? catalogue : { object: 'list' }), data: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
        res.status(upstream.status);
        if (assignments.length === 1) responseHeaders(upstream, res);
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.write(JSON.stringify(catalogue));
        record.request_status = 'SUCCESS';
      } else {
        collector = new UsageCollector(upstream.headers.get('content-type') || '', undefined, anthropic ? 'ANTHROPIC' : 'OPENAI');
        record.stream = collector.sse || record.stream;
        const transformOutput = key.output_script != null && supportsScripts;
        if (transformOutput && collector.sse) {
          res.status(upstream.status); responseHeaders(upstream, res);
          res.setHeader('x-accel-buffering', 'no'); res.flushHeaders();
          // Account original bytes before transformation; never trust modified usage.
          const originalBody = async function* () {
            if (upstream.body) for await (const chunk of upstream.body) {
              collector.push(chunk);
              yield chunk;
            }
          };
          for await (const chunk of transformOutputStream(originalBody(), key.output_script,
            classificationInputType, context, {
            signal: controller.signal, helpers: scriptHelpers, scriptTimeouts: config.scriptTimeouts, onOriginal: output => debugLog?.originalOutputEvent(output),
              onUpdated: output => debugLog?.updatedOutputEvent(output),
            })) {
            debugLog?.push(chunk, 'text/event-stream');
            if (clientClosed) throw new Error('client disconnected');
            if (chunk.infergateTerminal) {
              // End HTTP delivery with the protocol terminal frame. A client
              // closing after completion must not abort a pending tail script.
              res.end(chunk);
              break;
            }
            if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
          }
          collector.finish();
        } else if (transformOutput) {
          const chunks = []; let size = 0;
          if (upstream.body) for await (const chunk of upstream.body) {
            collector.push(chunk);
            size += chunk.length;
            if (size > 1024 * 1024) fail(502, 'invalid_output_script_input', 'Response exceeds the output script input limit');
            chunks.push(chunk);
            if (clientClosed) throw new Error('client disconnected');
          }
          collector.finish();
          let output;
          try { output = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { fail(502, 'invalid_output_script_input', 'Output script requires a JSON response'); }
          if (!output || typeof output !== 'object' || Array.isArray(output))
            fail(502, 'invalid_output_script_input', 'Output script requires a JSON object');
          await debugLog?.originalOutput(output);
          const updated = await updateResponseOutput(key.output_script, output, classificationInputType, context, { signal: controller.signal, helpers: scriptHelpers, scriptTimeouts: config.scriptTimeouts });
          await debugLog?.updatedOutput(updated);
          res.status(upstream.status); responseHeaders(upstream, res);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          debugLog?.push(updated, 'application/json');
          if (!res.write(updated)) await once(res, 'drain', { signal: controller.signal });
        } else {
          res.status(upstream.status); responseHeaders(upstream, res);
          if (collector.sse) { res.setHeader('x-accel-buffering', 'no'); res.flushHeaders(); }
          if (upstream.body) for await (const chunk of upstream.body) {
            collector.push(chunk);
            await debugLog?.pushOriginal(chunk, upstream.headers.get('content-type') || '');
            debugLog?.push(chunk, upstream.headers.get('content-type') || '');
            if (clientClosed) throw new Error('client disconnected');
            if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
          }
          collector.finish();
        }
        outputComplete = true;
        record.request_status = upstream.ok && !collector.failed && (!collector.sse || collector.terminal) ? 'SUCCESS' : 'FAILED';
        if (record.request_status === 'FAILED') {
          record.error_code = nativeAccounting?.error?.code || (collector.sse && !collector.terminal ? 'incomplete_stream' : upstream.status === 401 ? 'upstream_authentication' : upstream.status === 429 ? 'upstream_rate_limit' : 'upstream_error');
          record.error_type = nativeAccounting?.error?.type || (upstream.status >= 500 || collector.sse ? 'server_error' : 'invalid_request_error');
        }
      }
    } catch (error) {
      caught = error;
      record.request_status = clientClosed ? 'CANCELLED' : record.request_status === 'FORWARDED' ? 'FAILED' : error instanceof HttpError && error.status < 500 ? 'REJECTED' : 'FAILED';
      const status = error instanceof HttpError ? error.status : controller.signal.aborted ? 504 : upstreamStarted ? 502 : 500;
      if (!res.headersSent) record.http_status = status;
      record.error_code = clientClosed ? 'client_disconnected' : error instanceof HttpError ? error.code : controller.signal.aborted ? 'upstream_timeout' : status === 502 ? 'upstream_network_error' : 'internal_error';
      record.error_type = status >= 500 ? 'server_error' : 'invalid_request_error';
      if (error.type === 'usage_limit_error') record.error_type = error.type;
      if (!(error instanceof HttpError)) caught = new HttpError(status, record.error_code, status === 500 ? 'Internal server error' : 'Upstream request failed');
    } finally {
      clearTimeout(timer); res.off('close', disconnect);
      if (record.id) try { await finalizeRequest(db, record, requestUsage()); } catch {
        log({ event: 'accounting_write_failed', request_id: record.request_id });
        // Preserve failure metadata when the accounting transaction rolled back.
        if (record.usage_expected) try {
          await db.query("UPDATE api_requests SET completed_at=UTC_TIMESTAMP(3),request_status='FAILED',error_code='accounting_write_failed' WHERE id=?", [record.id]);
        } catch { /* The persisted usage_expected marker survives database outages. */ }
        caught = new HttpError(503, 'accounting_unavailable', 'Request accounting unavailable');
      }
      await debugLog?.finish(record, requestUsage(), outputComplete && (!collector?.sse || collector.terminal));
      log({ event: 'proxy_request', request_id: record.request_id, status: record.request_status, http_status: record.http_status, duration_ms: Date.now() - record.started_at.getTime(), error_code: record.error_code });
    }
    if (caught) { if (!clientClosed) next(caught); } else res.end();
  };
}
