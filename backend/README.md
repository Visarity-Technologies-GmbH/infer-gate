# InferGate backend

Node.js 24, Express 5, native fetch and MySQL 8.4 or built-in SQLite. No frontend or OpenAI SDK dependency is required by the server.

## Start locally

```sh
cd backend
npm ci
cp .env.example .env
```

Set `ENCRYPTION_KEY` to a base64-encoded random 32-byte key and `BOOTSTRAP_TOKEN` to a **separate** random value of at least 32 characters. Generate each using:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

The sample database settings match the supplied local MySQL service on port 3307. The valid MySQL collation is `utf8mb4_0900_ai_ci` (the project brief contains a spelling error). MySQL is selected by default (`DB_ENABLED=true`). To use SQLite instead, set `DB_ENABLED=false`; the built-in `node:sqlite` driver creates `backend/data/infergate.sqlite` by default. Set `SQLITE_DB_PATH` to change the file location. SQLite mode does not require MySQL credentials or a separate SQLite package.

```sh
npm run migrate
npm start
```

The default listener is `127.0.0.1:3000`. `GET /health` checks the process; `GET /ready` checks database connectivity. Startup requires the schema to have been migrated. The MySQL migrator creates the database if the configured account has permission; an administrator can provision the database beforehand instead.

Keep `.env` private. Preserve the encryption key securely: changing it without re-encrypting credentials makes existing upstream keys unusable. Production should supply environment secrets externally, use TLS at a trusted reverse proxy, restrict `/admin`, and use a dedicated runtime database account with only necessary permissions. The server does not trust forwarded IP headers or enable cross-origin access. A same-origin dashboard can use `/admin`.

SQLite uses its own checksum-checked schema snapshot, created with `npm run migrate` just like the MySQL schema. Fresh SQLite databases include the same OpenAI, Anthropic, Gemini and AWS Bedrock provider entries as MySQL. SQLite is intended for local, single-process use: its Node API is synchronous and SQLite serializes writes, so large reports or heavy write traffic can pause requests. Use MySQL for multi-instance or sustained production workloads. The two database files are independent; changing `DB_ENABLED` does not copy or migrate data between them.

## Administrator bootstrap

`GET /admin/setup` returns `setup_required`. Claim the single administrator using the runtime bootstrap token:

```sh
curl -X POST http://127.0.0.1:3000/admin/setup \
  -H 'Content-Type: application/json' \
  -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" \
  -d '{"password":"replace-with-a-long-password"}'
```

The token must be available in your shell for this example. Setup is protected by a database singleton constraint; later setup attempts cannot replace the password. Passwords use salted scrypt. Login:

```sh
curl -X POST http://127.0.0.1:3000/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"replace-with-a-long-password"}'
```

The response contains an eight-hour opaque bearer token. Store it securely and send `Authorization: Bearer <admin-token>` on subsequent administrative requests. Only its SHA-256 hash is stored. Logout revokes the session; changing the password revokes every session. Authentication attempts have an in-process rate limit and password hashing concurrency cap; use shared ingress rate limiting for multiple instances.

## Administrative API

All routes below are under `/admin` and require administrator authentication except setup and login. JSON mutations reject unknown fields. Identifiers can be JSON strings or numbers. No endpoint exposes stored credentials or password hashes.

| Routes | Request fields / behavior |
| --- | --- |
| `GET /setup`, `POST /setup`, `POST /login` | Bootstrap and login described above |
| `POST /logout` | Revoke current session |
| `PUT /password` | `current_password`, `password` (minimum 12 characters) |
| `GET /users`, `GET /users/:id`, `POST /users`, `PATCH /users/:id` | Create: `name`, `email`; update also accepts `status`: `ACTIVE` or `SUSPENDED` |
| `GET /groups`, `GET /groups/:id`, `POST /groups`, `PATCH /groups/:id` | `name`, optional `description` |
| `GET /groups/:id/users` | Group membership |
| `PUT /groups/:group/users/:user`, `DELETE /groups/:group/users/:user` | Add/remove membership |
| `GET /providers`, `GET /providers/:id`, `POST /providers`, `PATCH /providers/:id` | `name`, `api_url`, optional `api_type` (`OPENAI_COMPATIBLE`, `ANTHROPIC`, `GEMINI`, `AWS_BEDROCK`); update also accepts `status`: `ACTIVE` or `DISABLED` |
| `GET /upstream-keys`, `POST /upstream-keys` | Create: `provider_id`, `name`, `api_key`, required `aws_region` for Bedrock; AES-256-GCM encrypted at rest |
| `PATCH /upstream-keys/:id` | `name`, `status` (`ACTIVE` or `DISABLED`), `api_key` to replace the encrypted credential (literal or environment reference), or `aws_region` for Bedrock |
| `GET /provider-options` | Supported Bedrock regions for the region selector |
| `GET /proxy-keys`, `POST /proxy-keys` | Create: `user_id`, `name`; plaintext `api_key` returned only on creation |
| `POST /proxy-keys/:id/revoke` | Permanent revocation |
| `GET /roles`, `GET /roles/:id`, `POST /roles`, `PUT /roles/:id` | Role name, description, required non-empty `model_policy_ids` array, status (`ACTIVE` or `DISABLED`); a model is allowed if any assigned policy allows it |
| `GET /roles/:id/assignments`, `PUT /roles/:id/assignments` | Replace transactionally with an array of `{upstream_api_key_id, priority, status}` |
| `GET /proxy-keys/:id/role`, `PUT /proxy-keys/:id/role` | Read/assign `{role_id}`; null disables access by unassigning the role |
| `GET /dashboard` | Request totals by status and average latency |
| `GET /requests` | Request history, 100 records per page; use `next_before` as the next `before` query parameter |
| `GET /usage` | Token totals from recorded events, including counts of events reporting each token field |

Resource lists return up to 500 rows per page; pass the returned `next_after` as `after` to fetch subsequent pages. Group membership lists are bounded to 500 rows. Usage reports return at most 1,000 buckets; narrow the interval for larger datasets. Resource creation returns an identifier; successful updates return HTTP 204. Referenced entities are retained rather than physically deleted. Rotate upstream credentials by creating a new key, replacing assignments, and disabling the old key.

New installations start with OpenAI (`https://api.openai.com/v1`), Anthropic (`https://api.anthropic.com/v1`), and Gemini (`https://generativelanguage.googleapis.com/v1beta`) as default providers. These entries do not create credentials or assignments. Other providers default to `OPENAI_COMPATIBLE`; custom native endpoints can set `api_type` through the provider administration API.

Provider `api_url` is the full API base, e.g. `https://api.openai.com/v1` or an administrator-trusted internal HTTP endpoint. Provider URLs may not contain credentials, query strings or fragments. Clients cannot choose a provider URL. Redirects are never followed by the proxy.

Assignments are ordered by highest numeric priority, then lowest assignment ID. For model-bearing requests with multiple usable assignments, the proxy queries their model catalogues in that order and selects the first one advertising the exact requested model. Discovery failures stop routing; inference failures are never retried against a different credential. With a single usable assignment, the provider can resolve its own model aliases. Model-less requests retain highest-priority assignment selection and reject disabled keys/providers. Policies accept case-sensitive model names and patterns containing `*`. Precedence: exact rules, matching non-global patterns, catch-all `*`, then `MODEL_DEFAULT` (DENY by default). DENY wins within each level.

Example policy array:

```json
[{"model_pattern":"your-provider-model","policy":"ALLOW"},{"model_pattern":"*","policy":"DENY"}]
```

Suspension and revocation apply to subsequent requests, without cached authorization decisions. They do not terminate requests already in flight.

## Proxy compatibility

Clients can use the official OpenAI SDK with `baseURL: "http://127.0.0.1:3000/v1"` and the generated proxy key. Any `/v1/*` route can be forwarded to an `OPENAI_COMPATIBLE` provider with unrestricted model access; native adapters support the endpoints below. Upstream authorization replaces proxy authorization; cookies, organization/project selectors and unapproved client headers are not forwarded. Bodies and upstream error payloads are forwarded without JSON rewriting except for configured model remapping and streamed chat accounting. For JSON `POST /v1/chat/completions` with `stream: true`, InferGate sets upstream `stream_options.include_usage: true` (also when the caller omits it or sets it to false), preserving other options. The provider's usage chunk is forwarded normally and its reported counts produce recorded usage and cost records. Providers that omit usage even when requested still produce no usage event; InferGate never invents token counts. Native fetch may decompress responses; encoding and length headers are removed accordingly. SSE is forwarded incrementally with backpressure and client disconnect cancellation.

Restricted keys can POST to direct model-bearing inference endpoints: chat/completions, completions, responses, embeddings, moderations, images/generations, images/edits, and audio speech/transcriptions/translations. They must explicitly supply an allowed model. `GET /v1/models` (also with a trailing slash) is available to every active proxy key with an active role and valid upstream assignment. It queries every active assignment whose upstream key and provider are active, using each key’s own credential (including multiple keys on one provider), and filters the combined models through the same model policies used for inference. Duplicate model IDs keep the metadata from the highest-priority assignment, with assignment ID breaking ties. Model-bearing inference requests select the first usable assignment advertising the requested model when multiple assignments are available. Model metadata is preserved; no allowed models produces an empty list. Successful catalogues are buffered up to 10 MiB per upstream and 10 MiB of combined model data, validated, and returned with `Cache-Control: no-store`. Each proxy catalogue fetch times out after five seconds or half the configured upstream timeout, whichever is shorter. During combined discovery, a timeout, network fetch failure or HTTP 408/429/500/502/503/504 puts the key on a 30-second discovery cooldown in that backend process. Other keys are checked in priority order. Listings and evaluation can use partial catalogues. If discovery is incomplete and no usable match can be established, routing returns 503. Combined client model listings also skip other upstream HTTP errors and malformed catalogues, returning 503 if none succeeds. Single-assignment listings preserve upstream HTTP errors. Combined requests have NULL upstream key/provider/request IDs in tracking because there is no single upstream identity; each contacted key’s last-used timestamp is updated. Other routes—including batch, stored objects, file APIs and image variations—require unrestricted access (`*` ALLOW with no DENY policies, or ALLOW system default with no DENY policies). This prevents indirect execution of an unauthorized model. New endpoints can still be used immediately by unrestricted keys; review model semantics before admitting an endpoint for restricted keys.

Request bodies are held in memory up to `BODY_LIMIT_BYTES` (default 10 MiB) to inspect model authorization. JSON and multipart/form bodies are supported. Streaming **responses** are never fully buffered. WebSocket/realtime upgrades are not implemented. `UPSTREAM_TIMEOUT_MS` bounds the complete upstream operation (default five minutes). HTTP request upload timeout is 30 seconds.

## Upstream keys from environment variables

When creating an upstream key, `api_key` may be a literal credential or a reference such as `$OPENAIKEY`. Set `OPENAIKEY` in the backend process environment (or backend `.env`) to the actual provider credential. References work with every provider, including model discovery and streaming requests. Names must match `[A-Za-z_][A-Za-z0-9_]*`; a leading `$` always indicates a reference. Shell expressions and `${NAME}` syntax are not supported.

The reference is encrypted in the database; its resolved value is never stored or returned by administration endpoints. Resolution happens for each outgoing request without recursive expansion. A missing, empty, or invalid value returns HTTP 503 with `upstream_credential_unavailable` before contacting the provider. Restart the backend after changing its deployment environment or `.env` file. Existing literal credentials continue to work. No database migration is needed.

## AWS Bedrock

AWS Bedrock is available as a default provider. Create an upstream key, select AWS Bedrock, enter an **Amazon Bedrock API bearer key**, and select its AWS region. IAM access key IDs and secret access keys are not supported. Assign the upstream key to a role and configure its model policy as usual.

InferGate uses Bedrock's Mantle OpenAI-compatible API at `https://bedrock-mantle.{region}.api.aws/v1`. The region is required, validated against the supported commercial regions, stored on each upstream key, and editable in the dashboard. Two keys assigned to the same provider can use different regions. The provider displays a URL template; requests derive their trusted endpoint from the selected key's region. Request records snapshot `aws_region` so later edits preserve historical attribution. Combined model listings have no single region.

Model listing, chat completions (including streaming), and other OpenAI-compatible APIs offered by Mantle pass through the existing pipeline. Incoming Messages requests selecting a model ID with the `anthropic.` prefix instead use Mantle's native Anthropic endpoint at `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`; count-token requests use the matching `/messages/count_tokens` path. These native calls use the stored Bedrock key in `x-api-key`, preserve the native body (including `output_config`, adaptive thinking, tools and signatures), and retain Anthropic JSON/SSE output. The endpoint is derived from the key's validated region, never the provider URL or client headers. Claude Opus 4.7 supports Messages on Mantle but not Chat Completions, so it must use this native path. Unsupported model features remain provider errors; no fields are silently removed. Bedrock standard token estimates use configured provider/model prices, including separate cache-read and cache-write rates for native Claude Messages. See [AWS's Opus 4.7 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html) and [Mantle token counting](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html#count-tokens-mantle). Available models and operations depend on Mantle and the selected region; this does not expose every model available through Bedrock Runtime or implement the native Converse API. Use model IDs returned by `/v1/models`. Changing an existing provider to or from `AWS_BEDROCK` is blocked while it has upstream keys; create a separate provider instead.

References: [AWS OpenAI-compatible chat](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html), [model discovery](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html), [regional endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints-region-availability.html), and [Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html).

## Incoming Anthropic Messages and Claude Code

InferGate accepts `POST /v1/messages` (JSON or Anthropic SSE) with every supported provider type. Anthropic assignments and Bedrock Mantle `anthropic.*` models forward the native request; OpenAI-compatible, Gemini and other Bedrock Mantle models translate through the existing Chat Completions adapters and return Anthropic Message objects/events. Assign the upstream credential to the caller's role and allow each model used, including helper models. `POST /v1/messages/count_tokens` is supported for Anthropic assignments and Bedrock `anthropic.*` models; other upstreams/models return HTTP 501 without making an inference call or inventing a token estimate.

For Claude Code (terminal or IDE), use the gateway root URL, **without `/v1`**, and an InferGate proxy key:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=pak_your_infergate_proxy_key
claude --model "your-allowed-claude-model-id"
```

Use your HTTPS gateway URL in production. Anthropic SDK clients can instead set their `baseURL`/`base_url` to the same root and use the proxy key as their API key. Messages endpoints and `GET /v1/models` accept either `Authorization: Bearer <proxy-key>` or `x-api-key: <proxy-key>`; when both are present, Authorization takes precedence. Administrator/session credentials are never valid proxy credentials. This supports Claude Code's custom gateway connection, not Claude desktop sign-in or a claude.ai subscription credential. See [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway) and its [protocol guide](https://code.claude.com/docs/en/llm-gateway-protocol).

For Anthropic assignments and Bedrock `anthropic.*` models, the original native body is preserved, including tools/tool results, thinking/signatures, cache controls, metadata and future fields. `anthropic-*` protocol headers (including version and beta) and query strings such as `?beta=true` reach the trusted upstream. InferGate replaces authentication with its stored upstream key, drops client cookies and unrelated headers, disables redirects, and preserves backpressure, timeout and disconnect cancellation. Native SSE event names and payloads, including pings and thinking/tool deltas, are relayed incrementally; each event is bounded to 1 MiB. Upstream request IDs, retry hints and Anthropic rate-limit headers are returned. Error diagnostics are sanitized into native `{type:"error",error:{type,message}}` envelopes; recognized context-overflow and capability-rejection errors retain fixed recovery phrases without reflecting diagnostics. Recovery for other provider-specific error wording is limited.

The same authentication, user caps, role status, priority routing and post-classification model policies apply. For inference classification, top-level `system` is prepended as a synthetic system message for classifier input and cache hashing; native messages remain intact. Evaluation receives the original native request. Only the model field changes when evaluation remaps it. Classification caches are scoped separately from OpenAI-format requests and include the system prompt. Remapping may select any supported provider; translation is prepared only after current policy and provider routing checks. Unsupported translated features fail before inference with no retry or fallback. The same opt-in diagnostic switch captures both `/v1/chat/completions` and `/v1/messages` inference, including native and translated responses. Token counting is excluded.

Reported native usage is recorded, including partial usage on failed/cancelled streams. Cache reads/writes are added to Anthropic's uncached input to form gateway inclusive input; cumulative `message_delta` output counts replace earlier counts. Reported `usage.output_tokens_details.thinking_tokens` is stored as `reasoning_tokens`, including zero; it is already part of output tokens and is never added or charged again. Explicit `usage.total_tokens` from compatible gateways is retained if supplied. Otherwise, total tokens are derived as normalized inclusive input plus output when both are known and their sum is a safe integer. Cache reads/writes and thinking are not added again. Unknown or invalid components leave the total NULL; reasoning is never inferred. Derived totals on new successful requests contribute to existing token caps. Historical events are not automatically backfilled. Standard text/custom-tool requests support exact token-cost estimation; multimodal/server tools and special tiers remain unsupported. Streams missing the final message delta/stop are failed. Token-count requests enforce access and caps but skip classification/remapping, leave the requested workload intact, and create no usage/cost event or expected-consumption marker.

### Translating Messages to local and other models

For a local server exposing `/v1/chat/completions`, configure an `OPENAI_COMPATIBLE` provider with its API base (for example, `http://127.0.0.1:11434/v1`), an upstream credential accepted by that server, a role assignment and an allowed local model ID. InferGate's outgoing credential is separate from the caller's proxy key. Select the actual local model ID in the client, or use role classification/evaluation to remap an allowed requested ID to it. No implicit Claude-to-local model alias is created.

The reverse bridge supports system/conversation text, user base64 images, custom function tools, tool-use/result history, tool choice, token limits, temperature, top-p and stop sequences. Provider/model support still applies; for example, Gemini rejects disabling parallel tool calls. Images in tool results, documents, server tools, thinking/signature history, explicit enabled/adaptive thinking, `top_k`, `output_config`, context-management and unknown fields are rejected before inference by the reverse bridge; native Anthropic and Bedrock `anthropic.*` forwarding retains these fields for upstream validation. Omitted or `{type:"disabled"}` thinking is accepted. Cache controls are accepted as placement hints and omitted, because another API cannot enforce Anthropic caching. Valid `metadata.user_id` is omitted; InferGate's authenticated identity remains authoritative. Translated calls accept the Claude Code `?beta=true` query switch, but do not forward Anthropic beta/version headers to other providers; other query parameters are rejected.

For Claude Code through a translated upstream, disable incompatible capabilities in the client. Current Claude Code provides these [gateway compatibility variables](https://code.claude.com/docs/en/env-vars):

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=pak_your_infergate_proxy_key
export CLAUDE_CODE_DISABLE_THINKING=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_EFFORT_LEVEL=auto
export ENABLE_TOOL_SEARCH=false
claude --model "your-allowed-local-model-id"
```

Verified with Claude Code 2.1.306 against a local mock: disabling experimental betas and thinking alone still sends `output_config.effort`; `CLAUDE_CODE_EFFORT_LEVEL=auto` removes that field for an unrecognized model such as `qwen3.8-flash-next`. Restart Claude Code after changing these variables. These settings do not make every Claude-specific feature portable. Requests still containing unsupported options receive explicit errors. Start a fresh conversation rather than replaying Anthropic thinking/signature history to another provider. For vLLM/Qwen templates that reject mid-conversation system roles, InferGate maps recognized 400 diagnostics to the fixed `capability_rejected: mid_conv_system` token. Claude Code 2.1.306 was verified to retry with the context carried in a user message; the first rejected request remains visible in history. InferGate does not reorder messages or replay inference itself. The model must support the requested tools/images itself; Claude Desktop's third-party gateway setup and model picker have not been tested against InferGate.

JSON responses translate text/function calls and finish reasons. SSE translates text deltas, bounded incremental tool JSON, per-block stops and final message-delta/message-stop, and requires the upstream Chat stream's finish reason plus `[DONE]`. Truncated/invalid streams fail and preserve reported partial usage. Stop matches cannot be reconstructed from standard Chat finish reasons, so a Chat `stop` becomes `end_turn` with null `stop_sequence`; tool calls produce `tool_use`. Provider reasoning text is not exposed or fabricated as signed Anthropic thinking. Gemini tool-use blocks carry `extra_content.google`; preserve that extension when sending tool results so opaque signatures and call IDs round-trip.

Accounting uses the original upstream counters, retaining reported totals, cache breakdowns and reasoning counts. It does not derive accounting from the translated wire body or synthesize missing usage. Wire usage counters are nullable when the upstream has not reported them, including at message-start before a late usage chunk. No reported usage means no usage/cost event. Standard text estimates retain existing provider pricing rules; Bedrock standard token estimates use the configured provider/model prices; native Claude Messages also accounts for cache creation separately. Token caps can use totals actually reported by translated providers, while native Anthropic totals can also be derived from known inclusive input and output. Totals that remain NULL contribute zero under the existing cap rules.

## Anthropic and Gemini native adapters

Clients use the same proxy URL and proxy API key with `client.chat.completions.create(...)`. Use the exact ID returned by `client.models.list()`; Gemini IDs omit the native `models/` prefix. Provider credentials stay encrypted in InferGate and are sent only to the configured upstream, in `x-api-key` plus `anthropic-version: 2023-06-01` for Anthropic and `x-goog-api-key` for Gemini.

Supported native endpoints:

- `GET /v1/models`: native pagination is followed, IDs are normalized, and the existing aggregation and model policies apply.
- `POST /v1/chat/completions`: JSON and incremental SSE, system/developer messages, conversation history, text, base64 image data URLs, function definitions/calls/results, tool selection, token limits, temperature, top-p, and stop sequences.
- Gemini supports `response_format` JSON object/JSON schema modes. Anthropic currently supports text only. Native adapters support one candidate (`n=1`). Anthropic defaults to `max_tokens=4096` when no token limit is supplied.

The Gemini adapter removes the OpenAI `store` field before validation and never forwards it to Google, regardless of its value. This does not change provider retention policies or InferGate diagnostic logging.

Unsupported fields/endpoints fail explicitly before inference; this is not a complete emulation of every OpenAI API. Native `/responses`, embeddings, files, batches, audio, image generation, remote image URLs, explicit thinking controls, strict function schemas and arbitrary provider-specific options are not mapped. Existing OpenAI-compatible providers continue forwarding these APIs as before. Gemini cannot enforce `parallel_tool_calls=false`, so that option is rejected. Gemini tool calls carry opaque thought signatures and native call IDs under `tool_calls[].extra_content.google`; preserve the returned assistant message when submitting tool results.

Native streams produce OpenAI chat chunks and `[DONE]` only after completion. `stream_options.include_usage` controls client-visible usage chunks, while accounting captures reported usage regardless of that flag. Anthropic cache-read and cache-creation counts are included in mapped prompt tokens when reported; `output_tokens_details.thinking_tokens` is mapped to reasoning tokens, while totals are derived from known inclusive input and output if no total is reported. Missing components leave that derived total NULL, and unreported reasoning stays NULL. Gemini reasoning counts are included in completion tokens when reported, and are also recorded separately. Unknown counters stay NULL. Provider thinking text is not exposed as assistant content.

Native errors preserve HTTP status and retry/request-ID headers but use sanitized OpenAI error objects, rather than reflecting raw provider messages that might contain prompt data. Incomplete streams, upstream timeouts and client disconnects cancel forwarding and retain any usage already received. Native JSON and model responses are bounded at 10 MiB, SSE events at 1 MiB; model pagination is bounded at 100 pages. Model discovery and generation share the request timeout. No live provider calls are required by tests.

For Gemini HTTP 503 responses with native status `UNAVAILABLE`, InferGate returns the safe code `upstream_unavailable` and records `error_type=server_error` in request tracking. Known high-demand messages are described without reflecting raw provider text. This indicates provider availability; model listing can still work while generation fails. Retry later with bounded exponential backoff, or explicitly choose another authorized model. InferGate does not automatically replay generation or silently switch models. See [Google’s retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).

Mapping references: [OpenAI Chat](https://developers.openai.com/api/reference/resources/chat), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Gemini GenerateContent](https://ai.google.dev/api/generate-content), [Gemini models](https://ai.google.dev/api/models).

## Tracking and reporting

Requests receive an `x-infergate-request-id`; safe structured logs include this ID, status, duration and error code. Prompts, response bodies, credentials and URL query strings are never stored or logged. Request tracking records authenticated identities even for rejected requests. Database failure before forwarding fails closed. A finalization transaction updates the request and appends its usage event. If it fails after response bytes have started, the connection is terminated and an `accounting_write_failed` log event is emitted; operators must monitor this event. There is no durable replay queue, and already streamed data cannot be retracted.

Usage extraction supports Chat Completions and Responses JSON/SSE shapes. SSE inspection is bounded to 1 MiB per event, and JSON response inspection to 1 MiB total. Larger payloads continue forwarding but may have no usage event. The final reported usage is retained; missing token fields remain NULL, and zero is preserved. No usage is estimated. SSE without a completion marker is tracked as failed. Failed/cancelled requests retain reported usage when available. Asynchronous/background job polling and provider-specific accounting formats need additional collectors.

Usage-event, cost, and price rows can be maintained by database accounts with the corresponding SQL privileges; foreign keys and table constraints still apply. Reporting aggregates events, never mutable counters. Nullable sums and reported-event counts distinguish missing information from zero. Financial tables use fixed-precision decimals and current model prices. Pricing administration and cost calculation are implemented; invoicing is not.

Reports accept UTC `start` (inclusive) and `end` (exclusive), defaulting to the last 30 days. Filters: `user_id`, `proxy_api_key_id`, `upstream_api_key_id`, `provider_id`, `model`, `request_status`, `group_id`. Usage `group_by`: `company`, `user`, `proxy_key`, `upstream_key`, `provider`, `model`, `day`, `week` (ISO week), `month`. Repeat `group_id` to select multiple groups (for example, `group_id=1&group_id=2`, up to 500 selections). Matches include users belonging to any selected group without duplicating usage or requests. Omitting `group_id` includes everyone, including users without group membership. Group filters use **current** group membership; user/key/provider attribution is historical. Token reports count usage events, while request metrics count requests, so joins cannot multiply totals.

## Classification handlers

### Classification cache (Redis)

Redis settings are in `.env` and `.env.example`: `REDIS_ENABLED` (default true), `REDIS_HOST` (127.0.0.1), `REDIS_PORT` (6379), `REDIS_DB` (0), optional `REDIS_USERNAME` / `REDIS_PASSWORD`, `REDIS_TLS` (false), and `REDIS_TIMEOUT_MS` (100). Classification entries expire after `CLASSIFICATION_CACHE_TTL_SECONDS` (3600 seconds); model catalogues expire after `MODEL_CATALOGUE_CACHE_TTL_SECONDS` (300 seconds). The string cache uses the `string:v1:` namespace, expires after `STRING_CACHE_TTL_SECONDS` (3600 seconds), and rejects values longer than `STRING_CACHE_MAX_LENGTH` (32768 characters). The server closes Redis connections during shutdown. Restart the backend after changing these settings. No MySQL migration is required.

For requests with an assigned handler, the cache hashes the exact escaped string inserted for `${PROMPT}`, using MD5. Classification and cache-key generation share the same function: retain every system/user message in order, remove top-level tool_calls/reasoning_content, serialize, truncate to floor(maxToken × 0.9) characters (null defaults to 30000), and escape for insertion into the JSON template. Message metadata and additional system messages contribute to the hash; assistant/tool messages and text beyond the cap do not. Any messages array can produce a cache key, including user-only prompts and arrays that reduce to an empty prompt array; non-array input skips caching. The v5 key namespace prevents reuse of entries built with earlier prompt hashes or the old evaluation argument order; those old entries expire normally. Redis keys contain only hashes and a fixed namespace, never prompt text. Scopes include the role ID, role update time, handler configuration (URL/template/key fingerprint/maxToken), and evaluation script, so different roles and edited configurations cannot reuse each other's entries. The classifier uses the maxToken captured during authentication, matching cache-key generation even if the handler limit changes during a request. Upstream-assignment updates also update the role timestamp to invalidate its entries.

On a miss, classification and evaluation run normally. After policy validation and provider routing succeed, Redis receives the final routed model ID, category and sensitiveData with an atomic one-hour TTL. On a hit, classification and evaluation are skipped and the stored model ID replaces the current requested model. Cached category and sensitivity values are copied into any reported usage event. Authentication, suspension/revocation, current model policy, and active provider/key assignments are always checked; cache entries do not grant access. Provider discovery may still be needed when routing between multiple upstream assignments. Entries expire from their creation time; reads do not extend expiry. The cache stores the routed model ID, rather than changing it to any provider-reported model alias later.

Redis connection/command failures and malformed entries fall back to the normal classification flow. Connection and command waits are bounded, and connection errors briefly back off for five seconds. Failed classifications, evaluations, denied models and missing routes are not cached. No credentials or raw classification responses are stored in Redis. Redis should be private and access-controlled; enable TLS and credentials for remote deployments. Concurrent misses can each run classification; this initial cache does not coalesce in-flight requests.

When debug logging is enabled, `metadata.json` includes `classification_cache_hit`. Hits retain input/output logging but omit `classification_req.json`, `classification.json` and `evaluate.json`, since those operations did not run.

Run `TEST_REDIS=1 npm test` to include Redis integration tests. They launch a separate temporary local Redis server, verify database isolation and expiry, then stop it and remove its temporary directory; the configured Redis service is not cleared or modified by those tests.

The schema includes `roles.evaluation_script`. Roles with a classification handler expose the supplied default `async function evaluate(input, input_type, classification, models, context)` script until a custom script is saved. The Roles editor displays a JavaScript textarea when a handler is selected, with **Reset to default**. Role create/update endpoints accept `evaluation_script` as JavaScript text (up to 32768 characters); `null` resets to the default. Omission on updates preserves the current script, including when removing or changing the handler. Role list/detail endpoints return the script, and authenticated `GET /admin/role-options` returns `default_evaluation_script`. Saving validates syntax by compiling without executing the code. Scripts execute after successful classification and before model-policy evaluation and inference.

The current schema supports **Classification handlers** in the dashboard. Authenticated administrators can list (`GET /admin/classification-handlers`), create (`POST /admin/classification-handlers`) and edit (`PATCH /admin/classification-handlers/:id`) handlers.

Creation accepts `name`, optional `description`, `api_url`, `api_key` and optional `json_template`. The template is JSON text, defaulting to `{ "prompt": "${PROMPT}" }`. The server validates it with `JSON.parse` and MySQL stores it in a JSON column. Invalid JSON returns HTTP 400 with `invalid_json_template`. Listing returns JSON text for the template and a key fingerprint; credentials are encrypted at rest and never returned. Omit `api_key` when editing to preserve the existing credential. API URLs must use HTTP(S) without embedded credentials or fragments.

When the authenticated active role has a classification handler, JSON requests containing `messages` call it before model-policy evaluation and provider routing. Chat completions with a handler require a messages array; endpoints without messages, such as model discovery, skip classification. The proxy POSTs the rendered template to the exact configured API URL using `Authorization: Bearer <handler-api-key>` and `Content-Type: application/json`. `${PROMPT}` is replaced by an escaped JSON string of a reduced copy of messages: only system/user roles are retained, and top-level tool_calls and reasoning_content are removed. For example, a request with `messages: [{"role":"user","content":"Hello"}]` produces `{ "prompt": "[{\"role\":\"user\",\"content\":\"Hello\"}]" }` with the default template. Other client fields and headers are not sent to the classifier. Before escaping and replacement, the serialized message string is truncated to floor(maxToken × 0.9) characters; nullable handler maxToken defaults to 30000 (27000 characters). Truncation keeps the prefix and can leave the prompt text as an incomplete JSON array, while the outer request remains valid JSON. The original body is forwarded to the inference provider after classification, evaluation and policy checks succeed. If evaluation selects an available replacement model, only the model field is changed; messages and other options are preserved.

Classification results feed the role evaluation script; model policies remain enforced on the selected model. The service must return successful HTTP status and valid JSON. HTTP, network, invalid-JSON or oversized-response failures stop forwarding with a safe HTTP 502 error; classification timeouts return HTTP 504. Classification and inference share the configured request timeout and client-disconnect signal. Redirects are rejected and classifier responses are bounded to 1 MiB. No classification usage or cost is invented. Raw classification results are written only to optional chat completion debug logs, never the usage database or structured application logs.

The schema includes nullable `usage_events.category` (string) and `usage_events.sensitive_data` (boolean). After successful classification, the proxy discovers and deduplicates model IDs from the role’s active upstream assignments, then calls `evaluate(input, input_type, classification, models, context)` with the original JSON request, the classification JSON response, and those IDs. Discovery results are reused for routing within the request. The result must contain a category string (at most 255 characters), a boolean `sensitiveData`, and `models` as an array of model ID strings or null. When returned models is non-null, candidates are checked in their returned order against exact IDs in the available catalogue. The first available candidate replaces the original model for policy checks and provider routing. Null, an empty list or no matching ID retains the original model. A denied first match rejects the request; the proxy does not skip it or fall back to a different candidate. The original requested model remains in request tracking and debug input; the selected model is used for accounting when no model is reported by the provider.

Evaluation runs in a separate Node process with an empty environment, filesystem permission limited to its runner, a 64 MiB JavaScript heap limit, a 200 ms script deadline, and a 1 second process deadline. Inputs are JSON copies; no credentials, application objects, or Node globals are passed into the script context. Dynamic code generation is disabled. Exceptions, invalid results, resource-limit failures and timeouts stop inference with safe 502/504 errors. Client cancellation terminates evaluation. Evaluation functions must return a Promise; synchronous values and plain thenables fail. The runner validates the resolved object and handles rejected or unresolved Promises as failures/timeouts. Promise continuations remain subject to the script deadline.

Validated category and sensitiveData are captured on each recorded usage event when the provider reports usage, for normal and streamed responses. False remains false. Calls without evaluation, and existing historical events, retain NULL for both fields. If usage is unavailable, no usage event or token counts are invented. Classification and evaluation failures still finalize request tracking.

The schema includes nullable `usage_events.requestedModel`, preserving the original client-requested model alongside the selected/provider-resolved `model`. Both normal and streamed usage events capture the original request model, even after evaluation reroutes the call. A missing original model remains NULL. Existing recorded usage events retain NULL in the new column; their original model remains available through `api_requests.model_requested`.

The schema includes nullable `usage_events.requestedProvider_id`, referencing `llm_inference_providers.id`. New usage events record the provider that normal role routing would select for the original requested model, while `provider_id` records the provider actually used. Attribution follows assignment priority and the single-assignment alias behavior, including on classification cache hits. A missing or unavailable original model leaves the requested provider NULL. Existing recorded events retain NULL; no backfill is performed.

`GET /admin/requests` includes `model`, `requestedModel`, `category` and `sensitive_data` for Recent requests, using the latest usage event per request. A NULL `requestedModel` falls back to the event's `model`; requests without usage fall back to the tracked resolved/requested model and show unknown classification fields. Joining one event per request preserves request pagination. Sensitive data displays Yes, No, or — for unavailable values.

## Tests and migrations

```sh
npm test
npm run test:integration
```

Unit tests require no database. Integration tests require a MySQL account permitted to create/drop temporary databases, configured through `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` or `DB_SOCKET`. The integration runner creates a random `infergate_test_*` database, applies migrations twice, runs real HTTP/MySQL tests, and drops only its own database. The supplied local application account may not have these privileges. Integration tests are skipped by the unit-only command unless `TEST_DB_NAME` is explicitly set to an isolated test database.

Fresh MySQL installations use the single `001_public_release_baseline.sql` migration. Pre-release migration histories are unsupported; the migrator stops with a clear error if it finds one, so use a fresh database for this release. Add future schema changes as numbered migrations after the baseline and never edit an applied migration. MySQL migrations use SHA-256 checksums and an advisory lock. MySQL DDL commits implicitly: if a migration fails partway, inspect and repair that partial migration before retrying. Use separate migration/runtime credentials in production, back up data and encryption secrets, and test upgrades on a restored database first.

Upstream credential updates preserve the key ID and existing role assignments. Omit `api_key` to keep the current credential; an explicitly empty value is rejected. The edit form omits a blank replacement field. The replacement and its fingerprint are saved together and apply to subsequent requests.

`POST /admin/upstream-keys/:id/check` requires administrator authentication and tests the configured credential using the provider's models endpoint. It returns a safe `SUCCESS`/`FAILED` result, completion timestamp, HTTP status when available, and model count on success. Checks use existing provider adapters, have a maximum 15-second timeout, do not follow redirects, and do not write usage events or change key status. Disabled records can be checked explicitly without reactivation.

## Roles and reusable model policies

Run `npm run migrate` before starting the backend against its configured database. The public-release baseline creates the current schema for a fresh installation.

A role has a unique name, description, exactly one model policy, active/disabled status, and multiple upstream assignments. Multiple proxy keys can share one role; an upstream credential can be assigned to multiple roles. New proxy keys are initially unassigned and cannot make requests until assigned an active role. Disabling a role blocks subsequent requests from all its keys. Roles are retained rather than deleted. Model listing and inference use the role captured at authentication; reassignment never mixes one role's policy with another's upstream keys. Each new request captures `api_requests.role_id`; old records retain NULL. Historical role attribution can be obtained through the request associated with a usage event, never through the key's current role.

Use the Roles dashboard page to create roles, select a policy, and configure upstream routing. Proxy API keys → Configure selects a role and shows its policy and routing. Role changes affect all assigned keys, while editing a reusable policy affects every role referencing it.

Roles have an optional `classification_handler_id` foreign key. `POST /admin/roles` accepts this field as a handler ID or `null`; omission creates a role without a handler. `PUT /admin/roles/:id` can assign or replace the handler, or remove it with `null`; omission preserves the existing assignment for older clients. `GET /admin/roles` and `GET /admin/roles/:id` return the handler ID, without handler credentials. Invalid identifiers return HTTP 400, and nonexistent handlers return HTTP 409. The Roles editor offers a **Classification handler (optional)** selector with **None** to remove the assignment.

Policy admin endpoints:

- `GET /admin/model-policies`: paginated policy list with `assigned_roles` counts.
- `POST /admin/model-policies`: create `{name, description, rules: [{model_pattern, policy}]}`.
- `GET /admin/model-policies/:id`: read a policy and its rules.
- `PUT /admin/model-policies/:id`: atomically replace its name, description and rules.

Legacy `/admin/proxy-keys/:id/assignments`, `/policies`, and `/model-policy` endpoints return HTTP 410 with `role_configuration_required`. Update integrations to configure roles and assign them using `/admin/proxy-keys/:id/role`. Credentials and OpenAI-compatible client requests are unchanged.

Model rule patterns support `*` anywhere (for example `qwen*`, `vendor/*`, or `*instruct*`). Matching is case-sensitive and covers the entire model ID; `*` matches zero or more characters and all other characters are literal. Precedence is exact rules, matching non-global patterns, the catch-all `*`, then `MODEL_DEFAULT`. DENY wins over ALLOW within each level. For example, ALLOW `qwen*` plus DENY `*` permits only qwen-prefixed models; an exact DENY can exclude an individual model. The same matching applies to inference and model discovery. Patterns do not authorize model-less endpoints as unrestricted access.

### Estimated costs and pricing imports

Each usage report `costs` entry also returns numeric `saved_events`: the count of assessments in the same filtered bucket and currency where both `known_cost` and `requested_cost` are non-null. This includes zero costs and zero or negative savings; there is no additional status condition. If no assessments match, the count is 0.

The same entries expose `total_reducible_cost` (sum of requested costs) and `actual_reduced_cost` (sum of known costs), using exactly the COMPLETE assessments with both costs non-null that determine `estimated_saving_percent`. These amounts are exact decimal strings, grouped and filtered like the percentage, or `null` when no eligible assessments exist. Zero amounts remain zero strings; a zero `total_reducible_cost` still makes the percentage `null`.

`GET /admin/usage` (and the shared `/manager/usage` report) includes `estimated_saving_percent` in each `costs` entry, grouped by the selected bucket and currency with the existing report filters. It is `1 - SUM(known_cost) / SUM(requested_cost)`, restricted to COMPLETE assessments where both values are non-null. The database computes with decimal costs and returns the final fraction as a JSON number: `0.2` means 20% savings, zero means equal costs, and negative values mean higher costs. Missing comparable assessments or a zero requested-cost sum returns `null`. This comparison does not change `estimated_cost` or `known_cost` totals and uses the observed workload, not hypothetical original-model token consumption. The current schema includes the fields required for this comparison.

In **Settings → Estimated costs**, click **Import pricing.json**, review the preview, and apply it. The backend downloads only the fixed TokenWatch URL:

https://raw.githubusercontent.com/WyrdWerk/tokenwatch/refs/heads/main/public/pricing.json

TokenWatch documents rates as USD per million tokens: https://tokenwatch.wyrdwerk.com/choose/. Feed rates are normalized to eight decimal places; cost components use exact integer arithmetic with half-up rounding to twelve decimal places. Discounts in the feed are not applied again. No new dependencies are required.

Select a pricing provider for each InferGate connection. Match model IDs exactly, or add explicit aliases, for example API model `gpt-4o` → catalog model `openai/gpt-4o` when that catalog entry exists. The response's resolved model takes precedence over the requested model, so date-specific response IDs may also need aliases. Provider names, model prefixes and API types do not automatically select a pricing provider. Manual USD rates override imported rates for an exact provider/model; removing an override restores the applicable imported rate for subsequent requests.

Imports are validated, limited to 10 MB/20,000 entries and a 30-second download timeout, and require administrator authentication. Previews do not change data. Applying a preview checks its checksum; changed downloads require a fresh preview. Repeated snapshots are idempotent, older snapshots cannot replace newer ones, missing rows retain previous prices, and failed imports leave existing prices intact. Imports and mapping edits are serialized using a short database transaction; downloads occur before that transaction. Snapshots retain their checksum, generation timestamp, source URL and import timestamp. Prices become effective on application, never retroactively at the feed's generation time.

Each recorded usage event receives a stored cost assessment, atomically in the usage finalization transaction. Prices are selected from current provider/model rows when the cost is calculated, with manual overrides taking precedence. Pricing rows can be edited or deleted through SQL, subject to privileges, foreign keys and table constraints. Imports and override edits update these rows in place. Removing a price clears its stored cost references first. Editing a price does not automatically update existing stored cost assessments. Normal inference does not rewrite or automatically backfill historical usage and costs. Explicit administrator maintenance can delete usage history or recalculate supported stored assessments.

Cache reads are subtracted from inclusive input totals. Native Anthropic cache creation counts are captured separately and charged using the duration-specific rates when the provider reports a breakdown. Reasoning is already included in normalized output and is not billed twice. Missing counts and rates remain NULL in stored usage. For cost estimation only, unreported cache-read and aggregate cache-write counts (NULL or omitted) are assumed to be zero, so input is charged at the normal input rate after subtracting reported cache reads and writes. This applies to new assessments and explicit recalculation; reported duration breakdowns still require complete, consistent counts. Other missing counts and rates remain unknown. Stored cost assessments are recalculated only through explicit administrator maintenance. Assessments have `COMPLETE`, `PARTIAL`, `UNPRICED`, or `UNSUPPORTED` status. `known_cost` stores the sum of calculable cost components: the full estimate when status is `COMPLETE`, or the known portion when status is `PARTIAL`. The redundant `total_cost` column is not part of the current schema. Complete-estimate report sums use `SUM(CASE WHEN status='COMPLETE' THEN known_cost END)` to exclude partial estimates. Reports sum complete estimates separately by currency and show coverage counts; older events without assessments remain unpriced.

The schema includes nullable `usage_costs.requested_cost` (`DECIMAL(30,12)`). New `COMPLETE` assessments, only when either `model != requestedModel` or `provider_id != requestedProvider_id`, also estimate the reported workload at the original `usage_events.requestedModel` and `requestedProvider_id` prices, using current prices and manual-price precedence. For this comparison only, NULL `input_tokens`, `output_tokens`, `cached_input_tokens` and `cache_write_input_tokens` become zero. Normal input is input minus cache reads and writes; each component uses the existing exact half-up rounding, and reasoning is not added again. Requested cost stays NULL for non-COMPLETE actual assessments, missing requested identity/prices, missing required rates, invalid cache breakdowns, unsupported requested pricing, or a currency different from the actual assessment. Stored usage, actual costs, caps and reports retain their existing semantics. This is a comparison using observed token counts, not a measurement of what the original model would have consumed. Existing assessments retain NULL without backfill.

The supported scope is standard token billing for native Anthropic Messages, chat completions, completions, responses and embeddings, including AWS Bedrock Mantle. Subscriptions without manual overrides, special service/pricing tiers, multimodal and provider-hosted tool charges remain unsupported. Unknown provider-specific tier/context billing requires additional rules before these estimates can reflect those charges. Figures are estimated token charges, excluding taxes and invoice adjustments. Bedrock uses the configured provider/model rates at request start; pricing is not selected automatically by AWS region. Configure separate providers and appropriate rates when regions have different prices. Native Bedrock Claude Messages subtracts cache reads and writes from inclusive input and bills them separately; reasoning remains included in output. Existing UNSUPPORTED assessments are not automatically backfilled and remain excluded from cost recalculation because original billing flags are unavailable.

Administrative endpoints:

- `GET /admin/pricing`: import metadata, catalog identifiers, provider mappings, aliases, overrides and recent unmatched models.
- `GET /admin/pricing/anthropic`: administrator-only live scrape of [Anthropic's model pricing table](https://platform.claude.com/docs/en/about-claude/pricing). Returns an array of `{model, pricing: {input, output, cache_read, cache_write, cache_write_5m, cache_write_1h}}` with numeric USD prices per million tokens. Model names become lowercase slugs with all version dots replaced by hyphens (for example `Claude Opus 5.5` → `claude-opus-5-5`). Generic `cache_write` stays null; unavailable cache prices stay null. Uses the base/short-context tier only, excluding batch, fast mode, residency premiums and partner pricing. Fetches have a 30-second timeout, a 5 MiB response limit and no redirects; download/markup failures return 502. Does not import or persist prices.
- `POST /admin/pricing/import`: `{ "preview": true }` previews; `{ "checksum": "<preview checksum>" }` applies. An empty object imports directly.
- `PUT /admin/pricing/providers/:id`: `{ "provider_key": "openai", "aliases": [{ "model_id": "gpt-4o", "source_model_id": "openai/gpt-4o" }] }`; `provider_key: null` disables imported pricing for that connection.
- `POST /admin/pricing/overrides`: `{ "provider_id": 1, "model_id": "model", "input": "2", "output": "10", "cache_read": "0.2", "cache_write": null, "cache_write_5m_rate": null, "cache_write_1h_rate": null }`.
- `DELETE /admin/pricing/overrides/:id`: physically deletes the override after clearing its references in `usage_costs.pricing_id`; stored monetary amounts are preserved.

### Five-minute and one-hour cache writes

The schema includes nullable `cache_write_5m_rate` and `cache_write_1h_rate` to catalog and effective model prices, matching duration token counts in `usage_events`, and duration cost components in `usage_costs`. Existing rows retain NULL; no historical backfill is performed, including previously UNSUPPORTED assessments.

Native Anthropic/Bedrock JSON and SSE usage retains both `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. Their sum must match `cache_creation_input_tokens`; incomplete/inconsistent breakdowns produce partial estimates. Five-minute writes use `cache_write_5m_rate`, falling back to the generic write rate when unavailable. One-hour writes require `cache_write_1h_rate`; an unavailable rate produces a partial estimate. Legacy aggregate-only usage keeps generic pricing. Cache hits and refreshes share the cache-read rate.

`cache_write_cost` is the total of duration costs, not a third charge. `known_cost` includes each component once, including known duration components when another rate is missing. `requested_cost` uses the same duration counts at the requested model/provider rates and remains NULL when that comparison cannot be priced completely. Explicit cost recalculation uses these stored counters and current prices without changing token history; historical UNSUPPORTED rows remain skipped.

The pricing feed supports optional `pricing.cache_write_5m` and `pricing.cache_write_1h` amounts per million tokens. Missing values stay NULL; no prices are inferred. Provider mappings and aliases propagate them. Manual overrides accept optional `cache_write_5m_rate` and `cache_write_1h_rate` decimal strings or null; Settings provides both fields for new overrides and editing existing ones and shows them alongside mapped catalog rates. The usage-report API also returns duration token sums and their reported-event counts.

### User usage caps

Run `npm run migrate` before using caps. In **Users → Usage cap**, configure one optional daily or weekly cap per user, based on millions of tokens or estimated USD cost. Caps default to disabled and cover every key, provider and model used by that user. `5` million tokens means 5,000,000 tokens; new requests are rejected at 4,750,000. A USD 20 cap rejects at USD 19. Decimal values are compared exactly without JavaScript floating-point arithmetic.

Days reset at 00:00 UTC and weeks at Monday 00:00 UTC. Usage belongs to the period of its recorded usage-event timestamp (completion time); changing or enabling a cap includes existing usage in that period. Costs use stored historical assessments, never current model prices. Missing model prices and missing individual price rates contribute USD 0 for cap enforcement only; stored accounting remains unchanged. Known components of partial costs are included when the token breakdown is complete. Cached and reasoning tokens are not counted twice.

Successful and cancelled requests with usable consumption information contribute to caps. Failed, rejected, unfinished or abandoned requests count as zero, even if they have partial usage. Missing token totals contribute zero to token caps. For cost caps, missing cost-relevant token counts, invalid breakdowns and unsupported billing contribute zero; missing prices still contribute zero while known priced components count when the token breakdown is complete. These cap rules never overwrite the recorded usage or cost records. Requests already in progress finish normally, so concurrent requests and streams can exceed the cutoff; this is not a reserved hard budget.

Cap rejections return HTTP 429, an OpenAI-compatible error with `type: usage_limit_error`, `code: user_usage_limit_reached`, a UTC reset time in the message, `Retry-After`, and the request correlation ID. They are tracked as `REJECTED` without usage events and occur before classification or upstream calls. Changes take effect on the next authorization check; no quota cache or reset job is used.

Administrator-only endpoints:

- `GET /admin/users/:id/usage-limit`: saved settings, consumption, 95% cutoff, blocked state and reset time. Disabled/unconfigured caps return `enabled: false` without consumption queries.
- `PUT /admin/users/:id/usage-limit`: `{ "enabled": true, "period": "DAILY", "basis": "TOKENS", "amount": "5" }`. Use `WEEKLY` or `COST` as appropriate. Amounts are decimal strings (up to six decimal places for millions of tokens, twelve for USD); keep the settings and send `enabled: false` to disable.

### Chat completion and Messages debug logs

Run `npm run migrate` before using this feature. Settings → Chat completion debug logging enables or disables diagnostic capture; it defaults to disabled and persists in MySQL. Only authenticated administrators can read or change the switch.

For authenticated, active-user/role `POST /v1/chat/completions` and `POST /v1/messages` inference calls with valid JSON while enabled, `backend/logs/<timestamp>-<request-id>/` contains (including calls later rejected by model policy):

- `input.json`: the complete original request body, including messages and options.
- `classification_req.json`: the exact rendered JSON body sent to the classification API, after `${PROMPT}` substitution. Written before sending, including when the API call later fails. Omitted when classification is skipped or debug logging is disabled; authentication headers are not included.
- Classification-only message reduction keeps messages with role `system` or `user` and removes their top-level `tool_calls` and `reasoning_content` fields before JSON stringification. Message order, content (including empty/null or multimodal content), and other fields are preserved. Evaluation, inference and `input.json` retain the full original messages; `classification_req.json` records the reduced classifier payload.
- `classification.json`: the classifier's JSON response, when a handler is assigned and returns valid JSON (including HTTP error responses). No file is created when no classifier response is available.
- `evaluate.json`: the validated output of `evaluate` (category, sensitiveData and models), written after successful evaluation. Omitted when evaluation is skipped or fails. Like the other debug files, it is only written while chat completion debug logging is enabled.
- `metadata.json`: request ID, endpoint/method, UTC timestamps, model, status, completion flag, normalized usage, and the final client-facing response in `output`. Identity fields are `user_id`, `user_name`, `user_email`, `role_id`, `role_name`, `upstream_id`, `upstream_name`, `proxy_api_key_id` and `proxy_api_key_name`. User, role and proxy-key details are captured during authentication; upstream ID/name are captured when routing selects the upstream key, even if request preparation later fails. Unavailable values are explicit nulls (for example upstream identity on a policy rejection). Names/email are snapshots for that request; no lookup is performed at log finalization. Chat streaming deltas are assembled into a completion containing messages, tool calls, and finish reasons; Messages deltas are assembled into an Anthropic Message with text, thinking/signatures, tool inputs, citations, stop reason and native usage. Incomplete tool input JSON is retained in `partial_json`; stream errors retain assembled partial output. Native/translated error output remains sanitized as returned to the caller; individual events are not saved. Missing usage remains null; actual tokenizer token IDs are not available from the API.

The existing switch now covers Messages without a new migration or setting. `/v1/messages/count_tokens`, malformed bodies and requests rejected before active user/role authorization do not capture bodies. Classification/evaluation files for Messages follow the same optional-stage rules as chat completions; top-level system is included in classifier input while `input.json` retains the original native body. Streaming responses are forwarded incrementally while the diagnostic collector assembles the final output. No `output.log` is created. Diagnostic collection is bounded to 16 MiB of response bytes; larger outputs are omitted (`output: null`, `output_truncated: true`) without affecting forwarding. Interrupted calls retain partial output with `output_complete: false`. HTTP headers and authentication credentials are never captured; message content itself may contain secrets, so enable only for diagnostics. Files use owner-only permissions (directories `0700`, files `0600`) and are excluded from Git. Request directories older than 60 days are removed during the next logged call (checked at most hourly); if logging is disabled or idle, remove expired files manually. Disabling affects new calls, while calls already being captured finish. Disk failures produce safe structured error events and do not fail inference or accounting. Logs are not served by the administrative API.

### Upstream model catalogue cache

Model discovery for evaluation, provider routing, and client `GET /v1/models` requests shares a Redis cache. It uses the existing `REDIS_*` connection settings and `MODEL_CATALOGUE_CACHE_TTL_SECONDS` (default `300`, independent of the classification cache TTL). `REDIS_ENABLED=false` disables Redis caching for both services. Redis failures fall back to upstream discovery with bounded Redis connection/command timeouts.

Catalogues are cached before model-policy filtering. Every request still checks current authentication, user/role/key/provider status and model policies. The cache identity hashes the upstream key ID, provider ID/URL/type, region, resolved credential and requested models path/query. Credential rotation (including environment-backed credentials) or provider configuration changes therefore bypass old entries immediately. Redis stores catalogues, never credentials. Request IDs and rate-limit headers from earlier upstream responses are not replayed on cache hits.

Only successful, validated catalogues up to 10 MiB are cached. Entries expire without stale fallback: a failed refresh returns an error instead of using an expired catalogue. Concurrent misses for the same identity share a fetch within one backend process; separate processes share Redis entries but may refresh simultaneously. Cancelling one caller does not cancel the shared fetch, which retains its own upstream timeout. Administrator upstream-key checks always bypass the cache. Upstream key `last_used_at` is updated when a real discovery or inference request is made, rather than on catalogue cache hits. No database migration is required.


### Read-only user usage links

 Administrators manage one separate viewing key per user:

- `GET /admin/users/:id/viewing-key` returns `{exists, created_at}` without the key/hash.
- `POST /admin/users/:id/viewing-key` accepts no fields (omit the body or send `{}`), returns HTTP 201 `{key}`, and replaces any previous key atomically. Only the new plaintext key is returned, once.
- `GET /user/usage` requires `Authorization: Bearer <viewing-key>`. It returns only that active user's `{user: {name, email}, today, cap, updated_at}`, derived from the key rather than a client-supplied user ID. Query filters are rejected. No user mutation endpoints exist.

The frontend link is `/#user-<viewing-key>`. Viewing keys contain 32 random bytes and have separate SHA-256 storage in `user_viewing_keys`; they cannot authorize proxy or administrator APIs. Replaced keys and suspended users receive HTTP 401. Possession of the link grants read access; share it privately. Responses are uncached and keys must never be logged.

`today` contains input/output/total token sums and reporting counts, with `start` inclusive and `end` exclusive at UTC midnight. It aggregates recorded usage across all the user's keys, including reported failed/cancelled usage. Missing sums remain NULL; an empty day is displayed as zero by the UI. `cap` preserves existing limit semantics and adds `remaining`, calculated exactly and clamped to zero against the 95% cutoff. Token cap amounts/consumption/remaining are in millions of tokens; cost caps use estimated USD. Weekly cap consumption covers the full UTC week rather than just today. Disabled/unconfigured caps have no remaining allowance or reset. Production must route `/user/*` to the backend on the frontend origin, independently of administrator ingress restrictions.


The user usage page also displays today's estimated cost (UTC), grouped by currency, using stored cost assessments rather than current prices. The `/user/usage` response includes `today.costs` with exact decimal `estimated_cost` and `known_cost` sums and today's counts of fully priced, partially priced, unpriced (including missing assessments), and unsupported usage events. When coverage is incomplete the page labels amounts as the known portion and shows coverage; unavailable costs display —. These estimates include reported failed/cancelled usage and do not change the separate cap-enforcement rules. No additional database migration is needed for this cost display.


See the [complete Nginx deployment example](../deploy/nginx/README.md) for HTTPS, frontend hosting, API routing, streaming, administrator ingress restrictions and deployment checks.


The user page reuses Overview's **Token activity** bar chart for the last 14 UTC calendar days (today and the preceding 13 days). `/user/usage` includes `activity: {start, end, days}` with 14 chronological daily buckets, scoped on the server to the authenticated viewing key's user. Dates with no usage events have zero tokens; recorded events with unavailable totals retain NULL, and partial reporting remains identified by reporting counts. The interval is inclusive at the first midnight and exclusive at tomorrow's midnight. Reported failed/cancelled usage is included, matching today's token summary. The chart refreshes with the rest of the page and requires no new migration. Its shared frontend component is `frontend/src/components/Activity.jsx`.


## Manager accounts and API

 Manager dashboard permission is attached to users independently of inference Roles and groups. Only an administrator can `PUT /admin/users/:id/manager`:

- `{ "enabled": true }`: promote an active user. Returns `{temporary_password, expires_at}` once.
- `{ "enabled": true, "reset_password": true }`: replace an existing manager password and invalidate sessions.
- `{ "enabled": false }`: remove manager access, clear its password and invalidate sessions; returns 204.

Temporary passwords are random, scrypt-hashed, expire after 24 hours and must be shared manually. Suspended users must first be reactivated. User list/detail responses include `is_manager`; password hashes and session state are never returned.

Manager account endpoints use the separate `/manager` prefix:

| Endpoint | Contract |
| --- | --- |
| `POST /manager/login` | `{email,password}` → `{token,expires_in,user,password_change_required}`; eight-hour `mgr_` bearer session |
| `GET /manager/session` | Current `{user,password_change_required}` |
| `POST /manager/logout` | Revoke current session; 204 |
| `PUT /manager/password` | `{current_password,password}`; different new password, at least 12 characters; revoke all manager sessions; 204 |

A temporary session can access only session/logout/password endpoints. After changing the password, sign in again. Temporary password expiry requires administrator reset. Every manager request checks current ACTIVE/manager status, expiry and credential version. Suspension invalidates existing sessions permanently, including after reactivation. Password resets and demotion also invalidate them. Login and password-change work has bounded rate/concurrency limits; use shared ingress limits across instances.

Managers have organization-wide reporting and resource access through the same relative routes documented for `/admin`, mounted under `/manager`: dashboard, usage/models/categories, requests; user/group collection/detail reads and create/edit operations; suspension/reactivation; group membership reads/add/remove; proxy-key list/create/revoke and role reads/assignment; user usage-limit reads/updates; usage viewing-key reads/generation/replacement. Only existing active inference Roles can be newly assigned (null unassigns). User creation/edit rejects manager/password fields; managers cannot promote users, remove manager access or reset other managers' passwords. They can suspend/reactivate any user, including themselves or another manager.

Infrastructure, role definitions, model policies, classifiers, pricing and settings remain administrator-only. Supporting `GET /manager/roles` returns only active `{id,name,status}` choices. `GET /manager/providers` and `GET /manager/upstream-keys` expose only `{id,name}` for grouped-report labels. A method/path allowlist denies other manager endpoints by default; manager credentials cannot authenticate `/admin`, `/user/usage`, or inference calls.

Serve `/manager/*` on the frontend origin with TLS and no caching, preserve 64 KiB body limits, and keep `/admin` ingress restrictions separate. Do not log credentials, login/password bodies or temporary passwords. The frontend keeps manager sessions/secrets in memory.

### Usage maintenance permissions

Usage events and cost assessments can then be updated or deleted by accounts with the corresponding SQL privileges. Foreign keys remain: delete cost assessments before their usage events, and usage events before their request records. Referenced prices still cannot be deleted while `usage_costs.pricing_id` refers to them; table constraints and SQL privileges remain in force. The application continues inserting finalized usage/cost records without automatic recalculation or deletion; administrator maintenance endpoints are described below. Manual changes affect derived reports and user-cap consumption.

### Administrator usage maintenance

Both endpoints require `Authorization: Bearer <administrator-session>` and JSON bodies. Managers, proxy keys and user viewing keys cannot call them. The current schema supports these maintenance endpoints.

Delete usage events, their linked cost assessments, and eligible request history strictly before a UTC completion date:

```http
DELETE /admin/usage/events
Content-Type: application/json

{"before":"2026-01-01"}
```

Response: `{"deleted_events":123,"deleted_costs":123,"deleted_requests":150,"completed":true}`. After deleting costs and events, the route deletes terminal requests (`SUCCESS`, `FAILED`, `REJECTED`, `CANCELLED`) with no remaining usage events whose `completed_at` is strictly before the cutoff, falling back to `started_at` when `completed_at` is NULL. This also removes old requests without usage. In-flight requests, requests at/after the cutoff, and requests with any retained events remain. Model prices remain. This operates across all users/providers.

Recalculate existing assessments for events completed in a half-open UTC period (start inclusive, end exclusive):

```http
POST /admin/usage/recalculate-costs
Content-Type: application/json

{"start":"2026-01-01","end":"2026-02-01"}
```

Response: `{"recalculated_events":100,"skipped_unsupported":2,"skipped_missing_assessment":1,"completed":true}`.

Explicit recalculation reuses stored usage and selects current effective prices with manual overrides taking precedence. Current prices for actual and requested identities are read within each batch transaction; there is no historical-date lookup. It updates all cost components, `known_cost`, `requested_cost`, currency, price reference, status, reason and `calculated_at` consistently. Stored tokens remain unchanged. Comparison costs are recalculated regardless of their previous NULL/non-NULL value when the requested provider or model differs from the actual identity. They remain/become NULL for identical actual/requested identities or when the recorded requested identity, compatible currency or complete supported pricing is unavailable. Historical events with NULL requested identity cannot gain a comparison by inference from current key/role configuration.

UNSUPPORTED assessments and events with no assessment are skipped: original request bodies and provider-specific billing flags were not retained, so supported billing cannot safely be reconstructed for them. Existing supported assessments use the provider's current API type for Anthropic cache-write handling; changes to historical API types cannot be reconstructed.

Date fields accept strict `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss[.sss]Z`, with date-only values meaning midnight UTC. Missing/extra fields, invalid calendar dates and reversed/empty periods return 400. Both endpoints process all matching events up to a maximum event ID captured when the call begins, in batches of at most 100 per transaction. Deletion then processes eligible request records in batches of 100, using a separately captured maximum request ID. Batches commit independently; an error returns 500 with `completed:false` and counts of already committed work. Disconnects stop processing between batches. Retry the same criteria to finish; a repeated deletion returns zero when no events remain. Large operations may require a longer client/proxy response timeout. Reports and current cap consumption reflect maintenance changes immediately. No automatic schedule is added. Both operations are available in administrator Settings under Usage maintenance.


## Dual OpenAI/Anthropic providers

The provider schema supports the `OPENAI_ANTHROPIC` API type and nullable `llm_inference_providers.anthropic_api_url`. Existing provider types and URLs are preserved.

Provider Create/Edit offers `OPENAI_ANTHROPIC` and an optional Anthropic API base URL. The administrator provider POST/PATCH API accepts `anthropic_api_url` as an HTTP(S) URL without credentials, query or fragment; null clears it. Detail/list responses include this nullable field. It is used only for dual providers and falls back to `api_url` when null. The same upstream credential is used for both protocols with each adapter's normal authentication.

Dual providers forward `/v1/messages` and `/v1/messages/count_tokens` natively through the Anthropic base, preserving native body fields, protocol headers, JSON/SSE and sanitized errors. Other endpoints use existing OpenAI-compatible forwarding through `api_url`, including forced streamed Chat usage collection. There is no protocol fallback, inference retry or model-name heuristic. Model discovery and key checks use OpenAI `/models`; a listed model may not support native Messages. An unsupported combination returns the upstream error.

Dual-provider accounting uses Anthropic cache-write semantics only for `/v1/messages`; OpenAI endpoints keep OpenAI accounting. Explicit cost recalculation applies the same endpoint distinction using the current provider type, subject to the existing historical-type limitation. Count-token calls still skip classification, usage and costs. Existing role authorization, classification/remapping, caps and model-selection rules apply.


## Optional role scripts

Roles have nullable MEDIUMTEXT `prompt_script`, `input_script` and `output_script` columns. Administrator role POST/PUT accepts each as optional JavaScript text (at most 32768 characters per field). Null or whitespace-only text clears a field; omission on PUT preserves it. Saving checks syntax without execution; no function signature is required. Role list/detail responses include these fields. The existing 64 KiB administrative JSON request limit still applies to the combined payload.

The Roles create/edit widget exposes all three optional JavaScript editors, independently of classification-handler selection. Prompt, input and output script execution are described below.


### Custom classification prompts

When `roles.prompt_script` is non-null, `classificationPromptReplacement` calls `async function prompt(input, input_type, limit, context)`. Input is the complete original request JSON (including native Anthropic system fields); input_type is `ANTHROPIC` for Messages or `OPENAI` for OpenAI requests. Limit is `floor((maxToken ?? 30000) * 0.9)` (27000 by default), captured at authentication. The script controls prompt selection/truncation and must return a Promise resolving to a string (synchronous values and plain thenables are rejected); the gateway JSON-escapes that string for template insertion without additional truncation. Null prompt_script retains the existing message reduction, truncation and escaping.

The script executes once per eligible request, before cache lookup, in a permission-restricted child process with a 200 ms VM deadline, one-second wall-clock deadline, 64 MiB V8 heap and 256 KiB serialized result/context bound. Failures, invalid results, timeout or abort stop classification/inference with sanitized errors. Prompt scripts cannot mutate the original forwarded request. Token counting still skips classification and scripts.

Context starts per request as `{ user_id, role_id, request_id }`: the authenticated user and role IDs and the gateway correlation ID (`x-infergate-request-id`). Every role script (prompt, evaluation, input and output) also receives these helper functions on its context argument:

- `logDebug(fileName, text)` writes `text` as `fileName` into that request's debug directory, alongside files such as `metadata.json` and `input.json`. It resolves to `true` when written. It does nothing and resolves to `false` when debug logging is disabled, the name is not 1–128 characters of letters, digits, `.`, `_` or `-` (starting with a letter or digit), the text is not a string or exceeds 1 MiB, or the write fails. Files use `0600` and the existing 60-day retention and best-effort rules; an existing file of the same name is overwritten.
- `readStringCache(key)` and `writeStringCache(key, value)` expose the existing Redis string cache. Keys are non-empty strings shared across all requests, roles and users (stored under the `string:v1:` prefix); values are strings of at most `STRING_CACHE_MAX_LENGTH` characters (default 32768), expiring after `STRING_CACHE_TTL_SECONDS` (default 3600). Reads resolve to the string or `null`; writes resolve to `true` or `false`. Both fail soft when Redis is disabled or unavailable.
- `md5(text)` returns the lowercase hex MD5 digest of `String(text)` synchronously.

```js
async function prompt(input, input_type, limit, context) {
  const text = JSON.stringify(input.messages).slice(0, limit);
  const key = `prompt:${context.role_id}:${context.md5(text)}`;
  const cached = await context.readStringCache(key);
  if (cached !== null) return cached;
  await context.logDebug('prompt_source.txt', text);
  await context.writeStringCache(key, text);
  return text;
}
```

`logDebug` and string-cache calls are relayed to the gateway process and count toward each script's deadlines. Helper functions are not serialized: only the JSON fields of context are passed on to later scripts of the same request. Because string-cache keys are shared, include a role- or purpose-specific prefix in keys. JSON-serializable mutations are passed to evaluation as the fifth argument `evaluate(input, input_type, classification, models, context)`; The second argument is input_type ("ANTHROPIC" or "OPENAI"). Existing stored scripts must be updated manually to the new argument order; no database migration rewrites them. Context is never shared between requests or roles. Script output and context cross the process boundary as bounded JSON. A cache hit still runs prompt preparation but skips classification/evaluation. The classification cache stores only the routing decision (model, category, sensitivity and complexity), never script context. On a cache hit evaluation does not run and nothing is restored, so input and output scripts receive the current request's starting fields plus whatever the prompt script added; context written by evaluation exists only on cache misses. Entries written by earlier versions that still carry a context are used for the routing decision, but their context is ignored. For roles with input or output scripts, their source and a hash of the full original request remain part of the cache scope; entries exceeding the existing 8 KiB cache limit are not cached. Cache identity includes the exact escaped prompt sent to the classifier along with existing role/handler/evaluation/protocol scope. The prompt script source and its resulting context are not part of it, so per-request context such as `request_id` does not split the cache; editing a prompt script still invalidates entries because it updates the role's `updated_at`. Input and output script execution are described below.


### Input transformation scripts

For JSON POST `/v1/chat/completions` and `/v1/messages`, a non-null role `input_script` runs `async function updateInput(input, input_type, context)` after optional classification/evaluation/model remapping and before inference. It also runs without a classifier. Input is the current request object, including any classification-selected model; input_type is `OPENAI` or `ANTHROPIC`. The Promise must resolve to a JSON object, which replaces the inference request. The request-local JSON context is shared with prompt/evaluation scripts of the same request; on classification cache hits it holds only the starting fields and prompt-script additions, because evaluation does not run and no context is restored from the cache. Null input_script preserves existing forwarding; count_tokens and other endpoints skip it.

Execution uses the same restricted process, 200 ms VM/one-second wall-clock deadlines, 64 MiB V8 heap and 256 KiB serialized result/context bound as other role scripts. The transformed body must also fit BODY_LIMIT_BYTES. Errors, non-Promise or invalid results, timeout and cancellation stop inference without fallback. Revalidate model/messages, stream flag and native protocol fields; refresh billing-support metadata. Any classification-selected model and the final transformed model must pass current role policy. Route using the transformed model, preserve the original requested-model attribution, and account usage against the model actually sent.

When Chat completion debug logging is enabled, successful updateInput results are written as `update_input.json` alongside the original `input.json`, for both supported protocols. Capture occurs before transformed-request validation/provider adaptation. Files use 0600 in existing private request directories and the same 60-day retention and best-effort failure behavior. No file is created when logging is disabled or the script is absent/fails.


### Output transformation scripts

For JSON responses and JSON SSE events to POST `/v1/chat/completions` and `/v1/messages`, a non-null role `output_script` runs `async function updateOutput(output, output_type, context)` immediately before sending the body. The output is already translated into the client's protocol; output_type is `OPENAI` or `ANTHROPIC`, independent of upstream provider type. The Promise must resolve to a JSON object, which replaces the response body. HTTP status and safe response headers are preserved; response encoding/length headers are not reused. Null scripts preserve existing forwarding. Token counting and other endpoints skip output transformation. Streaming behavior is described below.

Context is shared with the prompt/evaluation/input scripts of the same request; it is never restored from the classification cache. Usage and costs use original upstream counters, never script-modified response usage. Output changes do not alter the recorded sent model. Script exceptions, invalid JSON/results, timeout or cancellation fail without returning the original response as fallback; original collected usage is retained for accounting.

Output transformation buffers at most 1 MiB of the translated JSON response. Script execution retains the 200 ms VM/one-second wall-clock deadlines, 64 MiB V8 heap and 256 KiB serialized result/context bound. Streams remain incremental, with only one bounded event buffered for transformation.

With Chat completion debug logging enabled, `original_output.json` captures the translated JSON response before updateOutput runs, including when the script subsequently fails. Existing metadata output reflects the transformed response returned to the client. Capture uses the existing private directories, 0600 files, 60-day retention and best-effort writes. Capture does not require an output_script: pass-through JSON responses and JSON SSE events are also written to original_output.json for Chat Completions, Messages and Responses. No file is created when logging is disabled or no valid JSON output has been received. Pass-through JSON bodies and individual SSE events are bounded to 16 MiB; oversized or invalid payloads are skipped without affecting forwarding.


Streaming output_script calls updateOutput once per JSON SSE event, in order, after provider translation. All calls share request context, including mutations from prior events. Scripts should handle protocol events/chunks rather than assume a complete response. Named Anthropic events (including JSON pings and terminal message_stop), OpenAI usage chunks, tools and text deltas are eligible. Preserve event/id/retry/comment lines; non-JSON [DONE] markers and comment-only keepalives pass through without calling the script. SSE line endings are normalized to LF. Malformed JSON, incomplete events and events over 1 MiB fail the stream. The existing per-script time/memory/result limits apply to each call.

Forward transformed events incrementally with backpressure; disconnects cancel the source and active script. Script failure after headers are sent terminates the connection without a synthetic success marker. Accounting and completion validation inspect original upstream events. With diagnostics enabled, original_output.json is a JSON array of original event payloads, appended before each script call and closed during final cleanup, including on script failure. Capture is bounded to 16 MiB plus a truncation marker. Metadata output assembles transformed events as before. No complete response buffering is introduced.


For transformed OpenAI streams, hold the completion tail beginning at the first non-null finish_reason until its trailing JSON events have been transformed and [DONE] arrives, then send the tail together and end the HTTP response. The tail is bounded to 1 MiB; earlier content remains incremental. This avoids marking clients that close on finish_reason as CANCELLED while a trailing usage script is still running. Missing [DONE] fails without emitting a misleading completion tail. Transformed Anthropic message_stop likewise ends HTTP delivery immediately. Disconnects before completion still cancel execution and record CANCELLED; historical request statuses are not rewritten.


Bedrock Mantle streamed Chat Completions normalize SSE JSON events before accounting, output scripts and Messages translation. On clean EOF only, InferGate appends `[DONE]` when every requested choice has reported a nonempty finish reason and the last JSON event is a usage-only chunk with valid input/output/total token counts. A literal final `data: [DONE]` without a blank-line delimiter is also accepted. Transport failures, partial JSON/events, provider errors and missing finish/usage signals are not repaired. Normal completion markers are not duplicated; usage remains provider-reported. Normalization is bounded to one SSE event, preserves JSON payload fields and safe response headers, and omits SSE comments/metadata. Other providers and native Bedrock Anthropic Messages retain their existing completion rules.

### MCP administration

Connect a Streamable HTTP client to `POST /admin/mcp` with the administrator bearer token returned by `POST /admin/login`. Each request checks the existing session. Clients using Streamable HTTP revisions `2025-11-25` or `2025-06-18` can send `initialize`, then `notifications/initialized`, and use the negotiated `MCP-Protocol-Version` header on subsequent POST requests. No MCP session ID is required. For the modern protocol, use a client supporting [revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). It can call `server/discover`, `tools/list`, and `tools/call` directly. Supply the protocol version and client capabilities in request metadata, mirror the version and method in the HTTP headers, and mirror the tool name in `Mcp-Name` for calls.

`list_role_upstreams` reads assignments in routing order. `set_role_upstreams` takes the role ID and an `assignments` array and atomically replaces the full list. An empty array clears it. `list_upstreams` pages through configured upstream keys, including disabled keys, with provider IDs and safe fingerprints. `list_model_policy_rules` accepts a policy ID and returns its complete ordered rule list with the policy details. The tool catalogue covers users, groups, proxy keys, upstream keys, providers, roles, model policies, and classifiers. List tools return up to 500 rows. Pass each non-null `next_after` back as `after` to retrieve the rest. Creating a usage link returns a dashboard-relative URL and replaces any previous link. Creating a proxy key or promoting a manager returns the one-time credential in the tool result.

Non-browser clients can omit Origin. To accept browser requests, set `MCP_ALLOWED_ORIGIN` to the exact trusted dashboard origin, including scheme and port. The server accepts 120 tool invocations per minute per process across administrator sessions.

### Reporting MCP

Route `/report/mcp` to the backend alongside `/admin/mcp`. Both endpoints support the same MCP revisions. The reporting endpoint accepts an existing administrator or manager bearer session and exposes only `get_usage_report`. Its optional arguments are `start`, `end`, `user_ids`, `group_ids`, `proxy_api_key_id`, `upstream_api_key_id`, `provider_id`, `model`, `request_status`, and `group_by`. The result matches the dashboard usage report. Dates are inclusive at the start and exclusive at the end. Omit all arguments for company totals over the last 30 days.


### Personal MCP tokens

The dashboard’s **MCP tokens** page lets administrators and managers create named credentials for individual MCP clients. Select a UTC date under **Valid through**. Expiry is exclusive midnight UTC on the following day. Copy the one-time value and configure the client with `Authorization: Bearer <token>`. Only the SHA-256 digest and display prefix are stored.

Each token has one scope. REPORT (default) authorizes `/report/mcp`; ADMIN authorizes `/admin/mcp` and can be issued only by an administrator. Dashboard sessions keep their existing MCP access. Dashboard logout leaves personal tokens active. Manager tokens require a current active manager with a permanent password. Suspension and demotion permanently revoke the manager’s tokens in the same transaction.

Session-authenticated `GET /mcp-tokens`, `POST /mcp-tokens` (name, valid_through, optional scope), `PATCH /mcp-tokens/:id` (name), and `POST /mcp-tokens/:id/revoke` are relative to `/admin` or `/manager`. Administrators see, rename and revoke all tokens. Managers see, rename and revoke their own. Rotate a credential by issuing its replacement, updating the client, and revoking the old one.


### Manager MCP

`/manager/mcp` accepts an active manager session or a manager-owned MANAGER-scope token from the **MCP tokens** page. REPORT remains the default token scope. Manager tokens follow the existing expiry and offboarding rules. The endpoint supports the same MCP revisions as the administrator endpoint.

Managers can list, create, rename and suspend users, set usage caps, create usage links, list/create/rename groups, assign group members, and create/rename/revoke proxy keys or assign them an active role. `list_roles` returns the ID, name and status of all roles, including disabled roles, with cursor pagination. Promotion, role editing and infrastructure tools are excluded.

Both `/admin/mcp` and `/manager/mcp` expose `list_proxy_keys`. Pass `next_after` as `after` to read subsequent pages of proxy key metadata, including the display prefix, owner, assigned role and status.

On both endpoints, `list_role_models` accepts a role `id` and returns sorted, deduplicated model IDs advertised by its usable upstream assignments and permitted by its model policy. Disabled roles return a tool error.

On `/admin/mcp` and `/manager/mcp`, `get_usage_cap` takes a user `id` and returns the dashboard usage-limit status. Active caps include current consumption and the next UTC reset. A user without a configured cap returns `{"enabled":false}`.

The administrator-only `list_providers` tool lists all configured inference providers, including disabled entries. Pass `next_after` as `after` for subsequent pages.

Proxy API keys accept an optional UTC `expires_at` timestamp on creation. Administrators and managers can change it with `PUT /proxy-keys/:id/expiry` under their dashboard API prefix. Send `{"expires_at":null}` to clear it. Existing keys have no expiry. Requests at or after expiry are rejected with HTTP 401.

Successful `updateOutput` results are also captured as `updated_output.json` when Chat completion debug logging is enabled, for both supported protocols. JSON responses are stored as an object; streams append an ordered array of successful script results, closed during cleanup even on later failure and bounded to 16 MiB plus a truncation marker. Capture uses the same private permissions, retention and best-effort writes. No file is created when logging is disabled, the script is absent, or no script call succeeds.

### Responses classification

`POST /v1/responses` can use the role's classifier and model evaluation when `input` is a string or an array and neither `previous_response_id` nor `conversation` is non-null. Instructions become a synthetic system message, string input becomes a user message, and array message items retain their roles and content. Standalone tool calls/results are excluded. The default prompt retains only system/user messages and uses the existing character cap; custom prompt scripts receive the original Responses body.

Prompt and evaluation scripts receive `input_type: "OPENAI_RESPONSES"` and the original request. Classification caching uses a separate Responses protocol scope with the existing prompt/configuration/script-context rules. Only `model` is remapped; all other Responses fields remain intact, and current model policy is enforced on cache hits and fresh decisions. Configure evaluation candidates and upstream assignments to support Responses: native Anthropic/Gemini translation is not provided, and unsupported selections fail without fallback.

Requests referencing `previous_response_id` or `conversation` bypass prompt scripts, classification, evaluation and classification caching, retaining their original model. This does not add upstream affinity or reconstruct stored history. Responses also supports `updateInput` and `updateOutput`, with protocol type `OPENAI_RESPONSES` and shared request-local context. Input scripts run after classification/remapping and before final authorization; their result must contain a valid model and a string/item-array input (or a conversation reference). Stream flags and references are validated, with existing body/script limits. Continuation requests still run input/output hooks, but input scripts cannot change their model or either conversation reference.

Output scripts receive the full JSON response or one parsed SSE event per call. SSE framing is preserved; original `response.completed`, `response.failed` and `response.incomplete` events terminate delivery. Original upstream usage and completion/failure state remain authoritative regardless of script changes. Scripts rewriting text should consistently handle both deltas and completed output representations. Existing opt-in diagnostic capture now includes Responses original/updated input and output under the same limits and retention rules.

### Role system prompt compaction

Enable any combination of `removeComments`, `minifyJson`, `compactLists`, `cleanWhitespace`, and `collapseNewlines` under **Roles → Edit → System prompt compaction**. The role API and administrator MCP accept the same flags, for example `"system_prompt_compaction": {"minifyJson": true}`. All options default off. An update can omit the object to preserve the role settings or supply an empty object to clear them.

Compaction runs once before optional classification. Classifier prompts, cache keys, evaluation, remapping and input scripts use the compacted request. Later input-script edits go directly to forwarding. It applies to Chat Completions system messages, Responses instructions and system message items, and Anthropic’s top-level system field on Messages and token-count requests. Developer and user messages are outside its scope. Text blocks retain their order and metadata. The scanner targets ordinary Markdown prose and valid fenced JSON. Exact spacing and HTML comments can carry instructions, and changing a system prefix can affect provider cache hits.

With debug capture active and any role compaction option enabled, eligible inference requests write the full post-compaction body to `input_compacted.json` before classification and input scripts, including when the text already satisfies the selected options. Token counting remains excluded from debug capture.
