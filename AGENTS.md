# InferGate — project and contributor guide

This guide describes the implementation checked on 2026-10-17, using [README.md](README.md), [backend/README.md](backend/README.md), [frontend/README.md](frontend/README.md), source code, lockfiles, and read-only inspection of local MySQL metadata.

Treat source, the public-release baseline and subsequent versioned migrations, and lockfiles as the implementation reference. Fresh MySQL installations start from `backend/src/db/migrations/001_public_release_baseline.sql`; pre-release migration histories are unsupported and must not be silently adopted. The READMEs contain some superseded statements: pricing and caps are implemented; access is configured through roles rather than directly on proxy keys. Keep this guide current when changing those contracts.

## Purpose and use cases

InferGate is an organizational inference gateway for sharing vendor credentials safely, controlling access, understanding actual AI consumption, and reducing inference spending. Employees and applications use individual proxy keys against an OpenAI-compatible API; InferGate owns the upstream credentials and routes requests to authorized providers. One administrator manages the system through a React dashboard and can delegate organization-wide user, group, proxy-key and reporting access to managers.

Cost cutting is a central product goal. A simple task should be eligible for a smaller, cheaper model, while harder tasks can use a stronger model. Classification plus administrator-defined evaluation scripts implements this routing decision. Savings depend on configured rules, model quality and actual prices; the gateway does not automatically determine the cheapest adequate model or prove savings.

Eight principal use cases:

1. **Share one vendor key across employees and applications.** Give each caller its own proxy key, attach keys to shared roles, and reuse the same upstream credential. Revoke one caller without redistributing the vendor secret.
2. **Analyze actual usage.** Trace requests, failures, latency and reported input/output/cache/reasoning tokens by user, proxy key, upstream key, provider, model and time period.
3. **Attribute estimated spending.** Combine recorded usage with current model prices to report estimated costs by model, user and inference vendor. Filter by organizational groups to inspect department/team consumption; multiple selected groups are a union without duplicate counting.
4. **Limit an employee's consumption.** Set an optional daily or weekly cap based on millions of tokens or estimated USD cost, across all that user's keys and providers. Enforcement uses the cap semantics below, including the 95% cutoff and concurrent-request limitations.
5. **Route simple work to cheaper models.** Classify a request, evaluate its category/complexity, and return an ordered list of suitable model IDs. The first available candidate replaces the requested model and must pass authorization. Reserve stronger models for work the configured evaluation identifies as hard.
6. **Apply consistent access rules and offboarding.** Reuse a named model policy and upstream assignments through a role. Suspending a user, revoking a key or disabling a role blocks subsequent calls across the affected identities.
7. **Use several inference vendors through one client interface.** Keep an application's OpenAI client configuration while using OpenAI-compatible services, native Anthropic/Gemini chat adapters, or AWS Bedrock Mantle. Compatibility depends on the adapter and endpoint.
8. **Inspect workload categories and sensitive-data signals.** Use classification metadata and complexity reports to improve routing rules; an evaluation script can prefer configured internal models for sensitive work. Sensitivity is metadata, not an automatic DLP guarantee: classification itself sends reduced messages to the configured classifier. Optional debug capture supports diagnosis under the retention rules below.

## Technology and versions

Versions below are repository/local observations, not claims about latest upstream releases. Use `npm ci` to reproduce lockfiles; do not upgrade dependencies as a side effect of unrelated work.

| Component | Current version / contract |
| --- | --- |
| Application packages | Backend and frontend `0.1.0`, private ES modules |
| Node.js | Required `>=24`; local runtime inspected: `24.16.0` |
| Express | Locked `5.2.1`; declared `^5.1.0` |
| MySQL | Target `8.4`; local server `8.4.5`, InnoDB |
| SQLite | Optional local mode through Node.js `node:sqlite`; selected with `DB_ENABLED=false` |
| mysql2 | Locked `3.24.4`; declared `^3.14.0`, promise API and parameterized SQL |
| Redis | Local server `8.10.2`; optional cache, not authoritative storage; no server-version constraint declared |
| @redis/client | Locked `6.3.0`; declared `^6.3.0` |
| React / React DOM | Locked and declared baseline `18.3.1` (`^18.3.1`) |
| Vite | Locked `6.4.3`; declared `^6.1.0` |
| Languages / HTTP | JavaScript/JSX, SQL, CSS; Node/browser native `fetch`, Web Streams, AbortController |
| Security / tests | Native `node:crypto` scrypt, SHA-256, AES-256-GCM; `node:test` |

Use JavaScript, not TypeScript. Prefer Node functionality and small focused dependencies. There is no ORM, Axios, frontend component/state framework, or OpenAI SDK dependency in the proxy. Official OpenAI SDK clients remain supported by the HTTP interface.

## Running and configuration

- Backend: `cd backend`, `npm ci`, copy `.env.example` to `.env`, set secrets, `npm run migrate`, then `npm start` (or `npm run dev`). Defaults to `127.0.0.1:3000`.
- Frontend: `cd frontend`, `npm ci`, `npm run dev`; defaults to `127.0.0.1:5173`. Vite proxies `/admin` and `/user` to the backend; `INFERGATE_BACKEND_URL` changes its target.
- `ENCRYPTION_KEY` must encode 32 random bytes in base64. `BOOTSTRAP_TOKEN` is a separate secret of at least 32 characters. Preserve the encryption key for existing credentials; never commit either secret.
- Database defaults: MySQL (`DB_ENABLED=true`), schema `InferGate`, `127.0.0.1:3307`, local development user `infergate`. Use runtime secrets and separate migration/runtime accounts in production. Set `DB_ENABLED=false` for the local `node:sqlite` database at `backend/data/infergate.sqlite` (override with `SQLITE_DB_PATH`). SQLite mode is intended for one local backend process; database files are independent and switching engines does not transfer data. MySQL encoding is `utf8mb4`, collation **`utf8mb4_0900_ai_ci`**.
- `MODEL_DEFAULT=DENY`; `BODY_LIMIT_BYTES=10485760` (10 MiB); `UPSTREAM_TIMEOUT_MS=300000` (five minutes). HTTP upload timeout is 30 seconds. Administrative JSON bodies are limited to 64 KiB.
- Redis defaults: enabled, `127.0.0.1:6379`, DB 0, 100 ms connection/command timeout; configure `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_TLS` when needed. `REDIS_ENABLED=false` disables both caches.
- Classification cache TTL: `CLASSIFICATION_CACHE_TTL_SECONDS=3600`. Model cache TTL: `MODEL_CATALOGUE_CACHE_TTL_SECONDS=300`. Redis failures fall back to uncached processing.
- Production: build frontend with `npm run build`; serve `frontend/dist/` over HTTPS and reverse-proxy `/admin/*`, `/user/*` and `/v1/*` on the same origin. Backend does not enable CORS or trust forwarded IP headers. Restrict administrator access at ingress. Vite preview is not a production server.

## Architecture and request processing

The active access relationship is:

```text
User -> Proxy API key -> Role -> Model policies (any may allow) -> ALLOW/DENY rules
                         |-> Optional classification handler + evaluation script
                         |-> Prioritized upstream assignments -> Upstream key -> Provider
Request -> api_requests -> recorded usage_events -> recorded usage_costs
```

Groups organize users through `user_groups`; they currently filter reporting rather than grant access or impose shared budgets. A user can own multiple proxy keys; a key has one optional role. A role has one required model policy and can serve many keys. An upstream key belongs to one provider and can serve many roles.

The pipeline creates a correlation/request record, authenticates the proxy key, checks key/user status and the user's cap, checks the role, reads bounded request metadata, optionally classifies/evaluates/remaps the model, enforces the role's policy, selects an upstream assignment, forwards the response incrementally, and finalizes tracking/usage/costs in a transaction. Authorization uses current database state on each call; changes affect subsequent requests, not work already in flight. Capture the role at authentication so concurrent reassignment cannot mix policies and routing.

Keep authentication, authorization, policy, classification/evaluation, routing, forwarding, usage collection and accounting distinct. The existing code uses small route/service/provider modules; do not introduce speculative repository/framework layers.

| Location | Responsibility |
| --- | --- |
| `backend/src/app.js`, `server.js`, `config.js` | HTTP wiring, runtime lifecycle and validated configuration |
| `backend/src/routes/` | Proxy, administrator resources, roles, policies, classifiers, reports, pricing and caps |
| `backend/src/services/routing.js`, `model-policy.js` | Key authentication/authorization, role routing and policy decisions |
| `backend/src/services/classification*.js`, `evaluation*.js` | Classifier calls, route-result caching and bounded script execution |
| `backend/src/services/model-catalogue.js`, `model-list.js`, `redis-cache.js` | Shared model discovery/cache and policy filtering |
| `backend/src/services/tracking.js`, `usage.js`, `accounting.js`, `pricing.js`, `usage-limits.js` | Transaction records, usage extraction, exact costs, current prices and caps |
| `backend/src/providers/` | OpenAI-compatible, Anthropic, Gemini and Bedrock adapters |
| `backend/src/security/`, `db/` | Credentials, shared MySQL/SQLite database class, checksummed MySQL migrations and SQLite schema snapshot |
| `frontend/src/main.jsx`, `api/client.js`, `components/ui.jsx` | App/auth/hash navigation, API/session handling and shared UI primitives |
| `frontend/src/pages/`, `style.css` | Administrative pages, reports and visual design |

### Policy and provider routing

- Model patterns are case-sensitive strings supporting `*`. Precedence: exact rules, matching non-global patterns, global `*`, then `MODEL_DEFAULT`. DENY wins within a level; an exact ALLOW can override a catch-all DENY.
- Assignment order is numeric priority descending, then assignment ID ascending. Never choose arbitrary credentials.
- Model-bearing calls with multiple usable assignments discover models in that order and select the first advertising the exact selected model. A single usable assignment can resolve its own aliases. Proxy discovery skips keys for 30 seconds per backend process after a discovery timeout, fetch failure or HTTP 408/429/500/502/503/504. Classification and model listing can use partial catalogues. Combined GET /v1/models also skips other upstream HTTP errors and malformed catalogues, returning 503 if none succeeds. Other discovery errors stop routing; inference failures do not trigger automatic retries or another provider/model.
- Model-less calls use the highest-priority active assignment and reject a disabled key/provider. Model discovery aggregates all usable assignments, including separate keys for one provider; duplicate IDs retain highest-priority metadata.
- Restricted roles can use known direct POST inference endpoints only with an authorized model, plus `GET /v1/models`. Indirect/stored-object/file/batch and unknown endpoints require unrestricted model access. Review endpoint semantics before adding restricted access.
- Provider URLs are trusted administrator configuration, never client input. Reject credentials/query/fragment in provider base URLs; never follow redirects or forward the client's proxy credential upstream.

### Classification and model remapping

An optional role handler stores an API URL, encrypted bearer credential and JSON template, defaulting to `{"prompt":"${PROMPT}"}`. For eligible JSON requests with messages (including chat completions), `${PROMPT}` becomes an escaped JSON string of reduced messages: retain system/user messages and remove their top-level `tool_calls` and `reasoning_content`. Preserve other fields, content and order. Before escaping and replacement, the serialized message string is truncated to floor(maxToken × 0.9) characters; nullable handler maxToken defaults to 30000 (27000 characters). Truncation keeps the prefix and can leave the prompt text as an incomplete JSON array, while the outer request remains valid JSON. Original messages remain intact for evaluation and inference.

After classification, discover available IDs across the role's usable assignments and invoke the role's administrator-authored JavaScript:

```js
async function evaluate(input, input_type, classification, models, context) {
  return { category: "other", sensitiveData: false, complexity: 0, models: null };
}
```

`input` is the original JSON request; `classification` is classifier JSON; `models` is the available ID array. The function must return a Promise resolving to an object; synchronous return values are errors. The resolved output requires a category string (at most 255 characters), boolean `sensitiveData`, `models` as an ordered string array or null, and optional/null complexity (`0` easy, `1` medium, `2` hard). The default script does not remap models. Scripts are syntax-checked without execution on save and run in a restricted child process with a one-second timeout and bounded memory/output.

The first candidate present in the catalogue replaces only the request's model field. Null, an empty list or no available candidate retains the original model. Model policy is checked **after** selection: if the selected candidate is denied, reject rather than skip to another candidate. Record original and resolved models separately. `usage_events.model` and cost pricing use the model sent upstream after gateway remapping; upstream response model names never override this identity. `api_requests.model_resolved` retains that sent model, and `usage_events.requestedModel` retains the original client model. A classifier failure stops inference; category and sensitivity do not independently enforce security rules.

Classification caching hashes the exact escaped `${PROMPT}` replacement string through the same shared function used by classification (all retained messages/fields, serialization, maxToken cap and escaping), scoped to role/handler/evaluation configuration. The maxToken used by both is captured at authentication. Eligible cache hits reuse model/category/sensitivity/complexity and skip classification/evaluation; they never bypass current authorization or policy. Any messages array can produce a cache key, including user-only or empty arrays; non-array input skips caching. Model catalogue caching uses identity/configuration/region/resolved-credential hashes, caches validated pre-policy catalogues, and reapplies policy on each request. Expired data is not used as fallback. Administrator key checks bypass the catalogue cache.

## Short API reference

### Client/proxy API

Use `Authorization: Bearer <proxy-api-key>` with base URL `http://127.0.0.1:3000/v1`. Existing OpenAI SDK clients change their API key/base URL; native adapters support a defined subset. Responses include `x-infergate-request-id`.

| Endpoint / provider | Behavior |
| --- | --- |
| `GET /health`, `GET /ready` | Process health / database readiness; outside `/v1` |
| `GET /v1/models` | Aggregated, deduplicated, policy-filtered catalogue; `Cache-Control: no-store` |
| `/v1/*`, `OPENAI_COMPATIBLE` | HTTP pass-through with authorization and endpoint/model checks; preserve status, body and relevant headers, except explicit classification remapping and streamed chat usage options |
| `POST /v1/chat/completions`, `ANTHROPIC` / `GEMINI` | Translate supported OpenAI chat requests and JSON/SSE responses to/from native APIs; native model discovery also supported |
| `POST /v1/messages` | Incoming Anthropic JSON/SSE; native Anthropic and Bedrock anthropic.* forwarding, or translation through OpenAI-compatible, Gemini and other Bedrock Mantle chat models |
| `POST /v1/messages/count_tokens` | Native Anthropic and Bedrock anthropic.* counting; other upstreams/models return 501 without inference or estimated counts |
| `AWS_BEDROCK` | OpenAI-compatible Mantle at `https://bedrock-mantle.{region}.api.aws/v1`, plus native Anthropic Messages/count_tokens at `/anthropic/v1` for anthropic.* model IDs; per-key validated commercial region and Bedrock API key, not IAM access/secret keys or native Converse |

Native chat supports text, base64 image data, conversation/system/developer messages, function tools and selected generation controls. Gemini supports JSON response formats and requires preserving opaque tool-call metadata. Its native adapter strips the OpenAI `store` field before validation regardless of value; this does not control provider retention or gateway diagnostics. Native Responses/embeddings/files/batches/audio/image-generation and unsupported options fail explicitly; do not advertise full OpenAI emulation. See provider modules and backend README for exact supported fields.

Incoming Anthropic Messages and token-count endpoints also accept `x-api-key: <proxy-key>`; `GET /v1/models` accepts it for SDK/discovery clients. Authorization takes precedence when both are supplied. Forward native body fields and `anthropic-*` protocol headers/query parameters, replacing authentication and disabling redirects. Relay bounded native SSE events including pings/thinking/tools; errors use sanitized Anthropic envelopes. Return native request IDs, retry hints and rate-limit headers. Classifier input/cache hashing prepends native top-level system as a synthetic system message, with a separate protocol cache scope; evaluation receives the original native body and remapping changes only model. Selected Bedrock anthropic.* models use the native /anthropic/v1 Messages/count_tokens endpoint, preserving output_config, adaptive thinking and other native fields, with x-api-key authentication and key-region-derived trusted URLs. Other OpenAI-compatible, Gemini and Bedrock selections translate via Chat Completions after authorization; unsupported translated fields fail before inference, without fallback. Count-token requests retain the original model, skip classification/evaluation and produce no usage/cost events or expected-consumption marker; ordinary auth/policies/caps still apply. The existing diagnostic switch also captures authenticated valid-JSON POST /v1/messages inference, including native and translated output; count_tokens is excluded.

The reverse Messages bridge supports text, user base64 images, custom function tools/results/choice, token limits, temperature, top-p and stops. Unsupported thinking/signature history, enabled/adaptive thinking controls, documents/server tools, context-management, output_config, top_k and unknown fields fail explicitly. Disabled/omitted thinking is accepted. Cache placement hints and valid metadata.user_id are omitted during translation; no Anthropic cache behavior is promised. Only the optional beta=true query switch is accepted and removed; Anthropic headers are not sent to other providers. Preserve Gemini tool signatures/call IDs through tool-use extra_content.google. Existing per-provider limitations apply. See backend README for client compatibility settings, including CLAUDE_CODE_EFFORT_LEVEL=auto to avoid output_config.effort on custom models. Translation errors identify safe unsupported field names without exposing their values. Recognized upstream 400 system-role placement rejections return the fixed capability_rejected: mid_conv_system cue, allowing Claude Code to retry in its compatibility format. Keep upstream diagnostics sanitized; do not reorder client messages or retry inference inside the gateway. The initial rejection remains a separate tracked request.

Translated JSON/SSE uses native Anthropic envelopes/events with bounded incremental text/tool deltas, finish reasons and completion markers. A Chat stream needs both a finish reason and [DONE]; errors/incomplete streams retain partial upstream usage and never emit success. Standard Chat stops become end_turn/null stop_sequence because exact stop matches are unavailable. Accounting retains authoritative upstream counters (including total/reasoning/cache tokens), even when translated wire usage contains null placeholders. Missing upstream usage creates no event. Bedrock standard token estimates use the configured provider/model prices; native Claude Messages also accounts for cache creation separately. Tool metadata is bounded to 100 calls, 1 MiB argument text per tool and 10 MiB cumulative metadata.

Native Messages usage merges message-start and cumulative message-delta counters; inclusive input adds reported cache read/write counts to uncached input. Map reported usage.output_tokens_details.thinking_tokens to reasoning_tokens (including zero); thinking is already included in output_tokens and must not be added or charged again. Preserve explicitly reported total_tokens when supplied by compatible gateways. Otherwise derive Anthropic total_tokens as normalized inclusive input_tokens + output_tokens when both are known and their sum is a safe integer; count cache reads/writes and thinking only once. Missing/invalid components leave the derived total NULL, and unreported reasoning remains NULL. These new derived totals contribute to existing token caps for successful and cancelled requests; cost-cap semantics remain unchanged. Do not backfill historical events without an explicit maintenance request. Text/custom-tool Messages can receive exact estimates; special tiers and multimodal/server tools remain unsupported. A successful native stream requires message-start, final message-delta and message-stop. See backend README for Claude Code setup and error-recovery limitations.

For OpenAI-compatible and Bedrock JSON streamed chat completions, set upstream `stream_options.include_usage: true` even if omitted or false in the client request, preserving other options and forwarding the provider usage chunk normally. This ensures accounting does not depend on the caller requesting usage. Providers that still omit usage produce no usage event; never invent counts. Native adapters already collect usage independently of this client flag.

Forward SSE with backpressure and disconnect cancellation; never buffer an entire stream for accounting. Native fetch can decompress content, so remove stale encoding/content-length headers. Native errors preserve status/relevant retry headers but return sanitized OpenAI error objects. Request bodies are buffered within the configured limit; WebSocket/realtime upgrades are not implemented.

### Administrator API

The administrator session also authorizes MCP revision 2026-07-28 requests and Streamable HTTP initialize clients (2025-11-25 and 2025-06-18) at `POST /admin/mcp`. `list_role_upstreams` reads assignments in routing order. `set_role_upstreams` takes the role ID and an `assignments` array and atomically replaces the full list. An empty array clears it. `list_upstreams` pages through configured upstream keys, including disabled keys, with provider IDs and safe fingerprints. `list_model_policy_rules` accepts a policy ID and returns its complete ordered rule list with the policy details. Tool discovery and calls share the resource handlers used by the dashboard. Proxy keys support administrator-only rename through `PATCH /admin/proxy-keys/:id` with `{name}`. See the backend README for client configuration.

All paths below are relative to `/admin`. Except setup/login, require the **administrator** bearer token, separate from proxy authentication. `GET /setup` reports `setup_required`; `POST /setup` requires `X-Bootstrap-Token` and a password of at least 12 characters. Setup creates exactly one administrator and cannot replace it. Login returns an eight-hour opaque session token; logout revokes it and changing password revokes all sessions.

| Routes | Contract |
| --- | --- |
| `GET/POST /setup`, `POST /login`, `POST /logout`, `PUT /password` | Setup/login `{password}`; password change `{current_password,password}` |
| `GET /users[/:id]`, `POST /users`, `PATCH /users/:id` | Name/email; patch can set `ACTIVE` or `SUSPENDED` |
| `GET /groups[/:id]`, `POST /groups`, `PATCH /groups/:id` | Name/optional description |
| `GET /groups/:id/users`, `PUT/DELETE /groups/:group/users/:user` | Read/add/remove group membership |
| `GET /providers[/:id]`, `POST /providers`, `PATCH /providers/:id` | Name, API base, API type; patch can disable |
| `GET /provider-options` | Supported Bedrock regions |
| `GET/POST /upstream-keys`, `PATCH /upstream-keys/:id` | Provider/name/credential/Bedrock region; patch can rotate credential or disable; responses contain safe fingerprints |
| `POST /upstream-keys/:id/check` | Models API credential check, safe status/error/time/model count; does not activate keys or create accounting events |
| `GET/POST /proxy-keys`, `POST /proxy-keys/:id/revoke` | Create with user/name and optional role_id; managers may select active roles; plaintext key returned once |
| `GET/PUT /proxy-keys/:id/role` | Read/assign `{role_id}`; null unassigns and blocks access |
| `GET /roles[/:id]`, `POST /roles`, `PUT /roles/:id` | Name, description, required policy, status; optional handler and evaluation script |
| `GET/PUT /roles/:id/assignments` | Transactionally replace with array of `{upstream_api_key_id,priority,status}` (at most 100) |
| `GET /role-options` | Default evaluation script |
| `GET /model-policies[/:id]`, `POST /model-policies`, `PUT /model-policies/:id` | Named reusable policy with `rules: [{model_pattern,policy}]` |
| `GET/POST /classification-handlers`, `PATCH /classification-handlers/:id` | Name, description, URL, API key, JSON template, nullable positive integer `maxToken`; no credential readback |
| `GET /dashboard`, `GET /requests`, `GET /usage` | Request status/latency, paginated history, token and estimated-cost aggregates |
| `DELETE /usage/events` | Administrator-only `{before}`: delete older usage events, linked costs and eligible request history |
| `POST /usage/recalculate-costs` | Administrator-only `{start,end}`: recalculate existing supported assessments using current prices; recalculate eligible NULL requested_cost |
| `GET /usage/models`, `GET /usage/categories` | Historical model IDs; category/complexity event counts |
| `GET /pricing`, `POST /pricing/import` | Pricing metadata; `{preview:true}` then `{checksum}` applies reviewed feed; `{}` directly imports |
| `GET /pricing/anthropic` | Administrator-only live Anthropic standard model prices; array of `{model,pricing:{input,output,cache_read,cache_write,cache_write_5m,cache_write_1h}}`, numeric USD/MTok, generic write null; no persistence |
| `PUT /pricing/providers/:id` | `{provider_key,aliases:[{model_id,source_model_id}]}`; null key disables imported pricing for that provider |
| `POST /pricing/overrides`, `DELETE /pricing/overrides/:id` | Manual provider/model input/output/cache rates as decimal strings; deletion removes the override and clears its cost references |
| `GET/PUT /users/:id/usage-limit` | Settings/consumption/reset; PUT `{enabled,period:"DAILY" or "WEEKLY",basis:"TOKENS" or "COST",amount:"5"}` |
| `GET/PUT /settings/debug-logging` | Persisted opt-in diagnostic switch, `{enabled:boolean}` |

The bracket notation above means collection and detail GET routes, not literal URL brackets. JSON mutations reject unknown fields; IDs may be strings or numbers. Resource creation usually returns HTTP 201 and an ID; successful updates return 204. Lists use `{data,next_after}` with `after` (500 per page); requests use `{data,next_before}` with `before` (100). Group-member retrieval is bounded to 500. Legacy proxy-key `/assignments`, `/policies`, `/model-policy` routes return 410 `role_configuration_required`; configure roles instead.

Reports use inclusive UTC `start`, exclusive `end`, default last 30 days. Filters: repeatable `user_id` (up to 500 selections, matching any selected user), `proxy_api_key_id`, `upstream_api_key_id`, `provider_id`, `model`, `request_status`, repeatable `group_id` (up to 500 selections). User and group selections combine with AND; omitting either includes all users for that filter. Group filters use current memberships and any-match semantics, not historical membership snapshots. Usage `group_by`: company, user, proxy_key, upstream_key, provider, model, category, day, ISO week, month; token/cost reports return at most 1,000 buckets. Group reporting is a filter, not a `group_by=group` API. Request model filtering uses the original requested model; usage filtering uses the recorded event model.

`GET /requests` includes `user_name`, resolved from the request's recorded `user_id` to the user's current name. Unattributed requests retain a null name and remain in the results. The Recent requests table displays this as its first column.

Each `/admin/usage` cost entry (also shared by `/manager/usage`) includes numeric `estimated_saving_percent`: `1 - SUM(known_cost) / SUM(requested_cost)`, using only the same filtered bucket/currency's COMPLETE assessments where both costs are non-null. Monetary sums/division use database decimal arithmetic before converting the final fraction to a JSON number. `0.2` means 20% savings; negative values indicate higher costs. No comparable costs or a zero requested-cost sum returns null. Existing `estimated_cost` and `known_cost` totals retain their independent semantics.

Overview and Usage & requests Estimated cost widgets, including Overview's today's cost widget, display only currency amounts; savings percentages and labels are not displayed.

Overview also includes a Todays Savings metric using today's UTC company usage: original comparable cost (`total_reducible_cost`), actual comparable cost (`actual_reduced_cost`), and their exact decimal difference, green when positive. Currencies remain separate; missing comparisons show —. Its footer shows summed `saved_events` / `priced_events` for today. It refreshes with the existing today metrics.

The shared `CostSavings` component also appears as Cost Savings immediately after Estimated cost in the time-range metrics on Overview and Usage & requests, using the filtered company totals for the selected period. The daily Overview instance retains its Todays Savings title and UTC-day scope.

Each usage report cost entry also includes numeric `saved_events`, counting assessments in that filtered bucket/currency where `known_cost` and `requested_cost` are both non-null. Zero costs count, including a zero requested-cost baseline; no matching assessments returns 0. This count adds no status or positive-savings condition.

Cost entries expose the exact decimal-string sums used by `estimated_saving_percent`: `total_reducible_cost` sums requested costs and `actual_reduced_cost` sums known costs, restricted to COMPLETE assessments with both costs non-null in the same filtered bucket/currency. Both are null when no eligible assessments exist; reported zeros remain decimal-string zeros, including when a zero baseline makes the percentage null.

## Database model and accounting

MySQL remains the default and production database. The optional SQLite path uses `node:sqlite` and a separate schema snapshot; it does not migrate data from MySQL. Keep the two schemas and their database-specific behavior aligned when changing tables or queries. SQLite is synchronous and single-process oriented, so retain MySQL for multi-instance or sustained production workloads.

A prior local inspection found pre-release migration history and an additional nullable `users.role_id` foreign key, which current source does not use. The public-release baseline does not adopt pre-release database history; use a fresh database for this release. This observation does not imply user-level role inheritance.

| Tables | Purpose and important fields |
| --- | --- |
| `admins`, `admin_sessions` | Singleton password hash; hashed session token and expiry |
| `users`, `groups`, `user_groups` | Employee identities/status and relational many-to-many memberships; nullable password hash is used for manager login; is_manager grants dashboard access, separate from inference Roles; read-only usage links use separate viewing keys |
| `llm_inference_providers` | Trusted API URL, `api_type`, status, pricing provider mapping |
| `upstream_api_keys` | Provider, encrypted credential, safe fingerprint, status, region and last use |
| `proxy_api_keys` | Owner, key hash/prefix, status, active `role_id`; old `model_policy_id` retained as legacy |
| `roles`, `role_upstream_assignments` | Shared policy/handler/evaluation configuration and prioritized credentials |
| `model_policies`, `model_policy_rules` | Named reusable policy and relational ALLOW/DENY rules |
| `classification_handlers` | Trusted classifier URL, encrypted credential, JSON template and nullable `maxToken` character budget |
| `api_requests` | Unique correlation ID, historical user/key/provider/role/region, endpoint/method, requested/resolved models, timestamps, status/errors and `usage_expected` |
| `usage_events` | Request-linked identity/model/token records; cache-read/cache-write/reasoning counts, category, `sensitive_data`, nullable complexity, original `requestedModel` and nullable `requestedProvider_id` (actual camel-case columns) |
| `usage_costs` | Event-linked estimate with pricing ID, components, currency, status, reason, `known_cost`; one assessment per event |
| `model_pricing` | Current prices per provider/model/source, provider/model, DECIMAL rates, feed/manual provenance and subscription flag |
| `pricing_imports`, `pricing_catalog`, `pricing_model_aliases`, `pricing_state` | Checksummed feed snapshots, catalogues, explicit model aliases and serialized pricing mutations |
| `user_usage_limits` | One optional user cap, enabled/period/basis, integer token limit or DECIMAL cost limit |
| `user_viewing_keys` | One hashed read-only usage viewing key per user; administrator replacement invalidates the previous link |
| `debug_logging_settings`, `schema_migrations` | Diagnostic singleton; migration names/checksums/application times |
| `proxy_key_upstream_assignments`, `proxy_key_model_policies` | Legacy audit/verification data; not the active routing/policy source |

Use foreign keys, unique constraints and query-driven indexes. Preserve historical entities with suspension/revocation/disablement rather than deleting referenced records. UTC timestamps and half-open intervals are required. Parameterize SQL; whitelist dynamic column/grouping expressions. Keep transactions short and never open across upstream HTTP calls.

Request statuses: `RECEIVED`, `FORWARDED`, `SUCCESS`, `FAILED`, `REJECTED`, `CANCELLED`. Tracking exists independently of usage: denied requests or responses without reported usage need not have events. Snapshot historical identity rather than joining through a key's current assignment. Multi-assignment model listings have no single upstream identity. `usage_expected` marks inference that may consume resources before execution.

**Usage events are the consumption source of truth.** The current schema permits UPDATE/DELETE operations on `usage_events` and `usage_costs` for database accounts with corresponding privileges. Database maintenance can update or delete these rows; foreign keys still apply, so delete cost assessments before their usage events and usage events before their requests. Changes affect derived reports and cap consumption. Normal inference still inserts finalized records. Administrator-only maintenance endpoints can delete old events and recalculate existing supported cost assessments; see Usage maintenance below. Pricing UPDATE/DELETE operations are subject to ordinary table constraints and SQL privileges. The current schema has no price validity-date columns. Pricing administration updates current rows in place and clears cost references before removing prices; direct price edits do not automatically recalculate stored cost assessments. Never replace this with mutable aggregate counters. Reports derive totals from events; preserve NULL for unavailable token counts and zero for explicitly reported zero. Do not invent usage. Failed/cancelled calls retain reported usage when available.

Request finalization, usage insertion and cost insertion share a transaction. Usage events are final usage records; request outcomes remain in `request_status`. Database failure before forwarding fails closed. Failure after streaming starts terminates the connection and emits `accounting_write_failed`; there is no durable accounting replay queue. Keep structured correlation logging and these operational limits visible.

### Estimated costs

Pricing administration and frontend management are implemented. Imports fetch the fixed TokenWatch feed defined by `PRICING_URL` in `services/pricing.js`; mappings/explicit aliases connect provider model IDs to imported prices, and manual overrides take precedence. Pricing aliases affect accounting, not inference model remapping.

Select **current prices when calculating an assessment**, with manual prices taking precedence over imported prices. There is one row per provider/model/source, enforced by a unique key; validity dates and historical price versions are not part of the public-release schema. Preserve historical assessments; no automatic repricing/backfill. Rates are `DECIMAL(20,8)` and costs `DECIMAL(30,12)`; backend uses BigInt fixed-unit arithmetic with half-up component rounding. Never use JavaScript floating-point arithmetic as the authoritative financial representation.

Assessment statuses are `COMPLETE`, `PARTIAL`, `UNPRICED`, `UNSUPPORTED`. `known_cost` stores the sum of calculable components and is NULL when none are calculable. For `COMPLETE` assessments it is the full estimate; for `PARTIAL` assessments it is only the known portion. The redundant `total_cost` column is not part of the schema. Complete-estimate report sums use `SUM(CASE WHEN status='COMPLETE' THEN known_cost END)`; preserve this distinction from sums that include partial estimates. Reports show coverage and separate currencies. Cache reads/writes are removed from inclusive input before charging normal input; normalized output already includes reasoning, so do not charge it twice. The unused `reasoning_cost` column is absent; retain `usage_events.reasoning_tokens` for reporting and bill reasoning through `output_cost`. Missing cache reads are assumed zero **for estimation only**, without changing stored usage.

Standard text token estimates cover native Anthropic Messages, chat completions, completions, responses and embeddings. Subscription pricing without overrides, special tiers, multimodal/provider-hosted tools remain unsupported. Estimates exclude taxes and invoice adjustments; classifier consumption/cost is not separately accounted for. Do not label estimates as actual invoices or claim automatic cheapest-model optimization. Bedrock uses the configured provider/model rates at request start; pricing is not selected automatically by AWS region. Configure separate providers and appropriate rates when regions have different prices. Native Bedrock Claude Messages subtracts cache reads and writes from inclusive input and bills them separately; reasoning remains included in output. Existing UNSUPPORTED assessments are not automatically backfilled and remain excluded from cost recalculation because original billing flags are unavailable.

The schema includes nullable `usage_costs.requested_cost` (`DECIMAL(30,12)`). Only new `COMPLETE` actual assessments where either `model != requestedModel` or `provider_id != requestedProvider_id` calculate this comparison using the event's `requestedModel`/`requestedProvider_id`, current prices and manual-price precedence. Treat NULL input/output/cache-read/cache-write token counts as zero only for this comparison; subtract cache reads and writes from inclusive input and use the existing exact component rounding. Leave requested cost NULL if requested identity/pricing is missing, rates/breakdowns cannot yield a complete supported estimate, or currencies differ. Historical assessments initially retain NULL; explicit administrator cost recalculation can populate previously NULL requested costs when requested identity differs from actual identity and current pricing supports a complete comparison. Actual costs, reporting and caps are unchanged. This compares the observed workload at requested prices, not the original model's hypothetical token consumption.

### User cap semantics

Caps are disabled by default and checked before classification/upstream calls. `TOKENS` amounts are in millions (up to six decimal places); `COST` is estimated USD (up to twelve). Reject new calls when recorded consumption reaches **95%**: a 5-million-token cap cuts off at 4.75 million; USD 20 at USD 19. Daily boundaries are midnight UTC; weekly boundaries Monday midnight UTC. Enabling/changing a cap includes existing events in that completion-time period.

Successful and cancelled events with usable consumption count. Missing totals count zero for token caps; failed/rejected/unfinished calls count zero even when accounting retains partial usage. Missing prices/rates count zero for enforcement; known partial costs count only with a usable complete token breakdown. Unsupported billing/invalid or missing required breakdowns contribute zero. These exceptions do not overwrite accounting NULLs. Requests already in flight finish; concurrency can exceed the cutoff. There is no reservation, hard budget guarantee, group cap or reset job.

Rejections are tracked as `REJECTED` without usage events and return HTTP 429, type `usage_limit_error`, code `user_usage_limit_reached`, UTC reset time, `Retry-After` and correlation ID.

## UI/UX and visual design

Preserve the existing restrained dark administrative interface rather than introducing a new component framework or design language. `frontend/src/style.css` is the visual reference:

- Dark forest surfaces (`#101513` background, `#171e19` sidebar), pale text (`#dce5e0`), muted gray-green text (`#8b9b92`), fine borders (`#2a332e`) and lime accent (`#c2ee8a`). Rounded controls/cards, compact typography and clear spacing support dense operational data.
- DM Sans for body/controls, Manrope for headings/brand; Google Fonts with system fallbacks. Inline SVG icons come from `components/ui.jsx`; charts use existing lightweight markup/SVG/CSS.
- Fixed 245 px desktop sidebar, top bar and content workspace; narrower grids at tablet widths and menu-controlled sidebar on mobile (650 px breakpoint). Authentication uses a branded story panel plus focused setup/sign-in form.
- Hash navigation, no routing dependency or server route fallback. Main pages: Overview, Usage & requests, Users, Groups, Proxy API keys, Upstream API keys, Inference providers, Roles, Model Policies, Classification handlers, Settings.
- Overview highlights today's UTC requests/tokens/estimated costs alongside period metrics, trends and category/complexity views. Usage combines filters, grouped token/cost tables, coverage and paginated recent requests. Display selected vs requested model, category and sensitivity so remapping is visible.
- Date inputs represent inclusive UTC calendar days; convert the final day to the next exclusive midnight for API calls. Display record timestamps in the browser's local timezone. Model/status/group/user selections use Apply filters; Groups and Users support multiple selections. Changing or clearing Groups immediately clears selected Users; the Users options then list members of any selected group, or all users when no groups are selected. `GET /users` accepts repeatable `group_id` (up to 500) and preserves pagination while filtering current membership without duplicate users. No selected users includes everyone; no selected groups includes users without groups.
- Resource pages use tables, status badges, explicit actions and modal editors. Roles configure policy, upstream priorities, optional classifier and evaluation script with Reset to default. Proxy-key Configure selects the role and shows its policy/routing. Show that shared role/policy edits affect all referencing keys.
- Provider Create/Edit includes an API type selector (`OPENAI_COMPATIBLE`, `ANTHROPIC`, `GEMINI`, `AWS_BEDROCK`, `OPENAI_ANTHROPIC`) initialized from the current provider when editing. The backend rejects switching to or from Bedrock when upstream keys already exist.
- Users offer Usage cap; groups have immediate membership editing. Upstream-key rows automatically check credentials four at a time, including disabled records, and show safe outcome/time; successful model discovery does not guarantee inference access.
- Settings combines diagnostic logging, pricing import preview/apply, provider mappings/aliases, manual price overrides and password changes. No invoicing portal exists. A separate read-only user page shows own UTC usage and cap status through an administrator-generated link.
- Administrator/manager session tokens and newly created proxy secrets stay in React memory, never local/session storage; refresh requires sign-in. Show a newly created proxy key once. Upstream/classifier credentials are write-only inputs; omit blank replacement fields to preserve existing secrets.
- Preserve labeled fields, keyboard focus, busy/disabled controls, inline errors, retry/empty states and session-expiry handling. Unknown usage/cost displays `—`, never a fabricated zero. Keep implementation details out of normal product flows unless needed to make an administrative decision.

## Security, privacy and streaming rules

- Exactly one administrator. Passwords use salted scrypt (`N=32768`, `r=8`, `p=1`); session/proxy keys have 32 random bytes and SHA-256 storage. Do not persist plaintext passwords or proxy keys. Protect bootstrap and login rate/concurrency limits; use shared ingress limits for multiple instances.
- Recoverable upstream and classifier credentials use AES-256-GCM with the encryption secret outside MySQL. Never return secrets or hashes through normal admin APIs or log authentication headers. Upstream credentials may be literal or encrypted `$ENV_NAME` references resolved on each outgoing call; this environment-reference feature applies to upstream keys, not classifier keys. Missing references fail safely before contacting providers.
- Preserve OpenAI-compatible errors on OpenAI-format proxy routes, use Anthropic error envelopes for native Messages endpoints, and sanitize internal/native-adapter failures. Never expose stack traces, SQL details, filesystem paths, encryption material or raw provider diagnostics that may contain prompt data.
- Default request tracking/logging persists metadata and reported usage, not prompts/responses or query strings. Use safe structured logs with correlation IDs. Diagnostic logging is the explicit opt-in exception below.
- Stream incrementally with bounded usage inspection (1 MiB JSON inspection / SSE event), abort/timeouts and backpressure. Preserve reported partial usage; incomplete SSE is failed. Native responses/catalogues have separate 10 MiB bounds and native pagination is bounded. Do not conflate upload buffering, bounded accounting inspection, caching or diagnostics with permission to buffer streaming responses before delivery.

### Opt-in chat diagnostics

The persisted switch defaults off. For eligible POST `/v1/chat/completions` and `/v1/messages` inference, `backend/logs/<timestamp>-<request-id>/` may contain `input.json`, `classification_req.json`, `classification.json`, `evaluate.json`, and `metadata.json` (assembled final/partial output, completion flag, usage and metadata). Classification/evaluation files exist only when those stages run; cache hits skip them. Messages SSE is assembled into an Anthropic Message containing text, thinking/signatures, tool inputs, citations and final usage; incomplete tool JSON is retained as partial_json, and stream errors retain assembled partial content. Metadata includes endpoint/method and explicit nullable identity fields user_id/user_name/user_email, role_id/role_name, upstream_id/upstream_name (from upstream_api_keys), proxy_api_key_id/proxy_api_key_name. Capture user/role/proxy-key identity in the authentication query and selected upstream identity in routing, including preparation failures; do not reread mutable identities at finalization. These names/email belong only in opted-in diagnostic files, not ordinary structured logs; response output is the client-facing (sanitized for native/translated errors) response. No `output.log` is created.

This feature captures raw message/output data, potentially including secrets in content; it does not redact message contents. Never enable by default or add ordinary body logging. Authentication headers are excluded. Directories/files use `0700`/`0600` and are Git-ignored, not served by the admin API. Response collection is bounded to 16 MiB; oversized output is omitted and marked truncated without interrupting forwarding. Cleanup removes directories older than seven days on logged calls, at most hourly; disabled/idle logging needs manual expiry cleanup. Disk failures emit safe events without failing inference/accounting.

## Contributor workflow and verification

1. Read the relevant implementation and tests before editing. Make the smallest correct change; preserve native fetch, incremental streaming and separation of concerns.
2. Add versioned migrations after the public-release baseline for schema changes. Never edit applied SQL/checksums or alter database history. The migrator uses an advisory lock and checksum checks; MySQL DDL commits implicitly, so inspect partial failures before retrying. Trigger creation may require a privileged migration account when binary logging is enabled.
3. Keep credentials and personal prompt data out of code, logs, fixtures and replies. Use trusted administrator URL configuration, bounded input, parameterized SQL and established crypto.
4. Preserve historical attribution, usage accounting and NULL semantics. Do not silently switch to an unauthorized model/provider, retry inference against another credential, or change cap/estimate semantics without explicit requirements and tests.
5. Update these instructions and affected READMEs/API descriptions when behavior changes. Document observed drift separately from intended features; local database state does not justify destructive fixes or bypassing migrations.
6. Test changed behavior with `cd backend && npm test`; frontend API-client changes with `cd frontend && npm test`; frontend changes with `cd frontend && npm run build`. Add security-sensitive tests for auth, policies, role routing, header replacement, classifier scripts/caches, caps, accounting, streams/disconnects and credential handling. No live vendor credentials/calls in tests.
7. For schema/database changes use `cd backend && npm run test:integration` with an account permitted to create/drop isolated `infergate_test_*` databases. The runner migrates twice, runs HTTP/MySQL tests, then drops only its generated database. Never point integration tests at the application/production database or fabricate a success when unavailable.

Existing limitations include no WebSocket/realtime proxy, complete native OpenAI emulation, automatic inference failover, invoice generation, historical group snapshots, reserved hard budgets, durable accounting replay, or full provider-specific billing. Extend these only for concrete requirements, with explicit contracts and appropriate tests.


## Read-only user usage links

The schema includes `user_viewing_keys`, with one SHA-256 key hash per user and a creation timestamp. Administrator-only `GET /admin/users/:id/viewing-key` returns existence/time; `POST` with an empty body creates/replaces a random viewing key, returned once. Replacement is serialized on the user row and invalidates the old key. The Users page offers **Usage link** to generate or replace a copyable `/#user-uvk_…` URL.

`GET /user/usage` accepts only a viewing bearer key, authenticates against the current hash and ACTIVE user status, and derives the user ID on the server. No query filters or mutation routes are supported. Viewing keys cannot authorize administrator or inference APIs. Responses use `Cache-Control: no-store`; secrets stay out of logs and browser storage. Possession of the link grants read access to its user's usage.

The `/user/usage` response includes `user: {name, email}` from the authenticated user row; display these in the header as `INFERGATE · YOUR USAGE: {name} ({email})`. The user page bypasses administrator sign-in, shows today's UTC total/input/output tokens across all of the user's keys, refreshes every minute or on demand, and shows the configured daily/weekly token/USD cap, current-period cap consumption, 95% cutoff, nonnegative remaining allowance to that cutoff, and UTC reset. Today uses recorded events in a half-open UTC completion-time day, including reported failed/cancelled usage. Missing token counts remain unknown; an empty day displays zero. Cap consumption retains the successful-or-cancelled/usable-consumption rules and may differ from today's totals. Weekly caps use the entire UTC week. Remaining allowance uses exact fixed-unit arithmetic, in millions of tokens or estimated USD.

Production ingress must expose `/user/*` on the frontend origin in addition to the existing API paths; administrator ingress restrictions remain separate. Apply the new migration with the established migration workflow before using usage links.


The user usage page also displays today's estimated cost (UTC), grouped by currency, using stored cost assessments rather than current prices. The `/user/usage` response includes `today.costs` with exact decimal `estimated_cost` and `known_cost` sums and today's counts of fully priced, partially priced, unpriced (including missing assessments), and unsupported usage events. When coverage is incomplete the page labels amounts as the known portion and shows coverage; unavailable costs display —. These estimates include reported failed/cancelled usage and do not change the separate cap-enforcement rules. No additional database migration is needed for this cost display.


A complete deployment reference is maintained in `deploy/nginx/nginx.conf.example` and `deploy/nginx/README.md`. Keep its API prefixes, body/time limits, streaming/cancellation behavior, private-data logging rules and administrator ingress restrictions aligned with backend contracts when changing deployment-related behavior.


The user page reuses Overview's **Token activity** bar chart for the last 14 UTC calendar days (today and the preceding 13 days). `/user/usage` includes `activity: {start, end, days}` with 14 chronological daily buckets, scoped on the server to the authenticated viewing key's user. Dates with no usage events have zero tokens; recorded events with unavailable totals retain NULL, and partial reporting remains identified by reporting counts. The interval is inclusive at the first midnight and exclusive at tomorrow's midnight. Reported failed/cancelled usage is included, matching today's token summary. The chart refreshes with the rest of the page and requires no new migration. Its shared frontend component is `frontend/src/components/Activity.jsx`.


## Manager dashboard access

The schema includes `users.is_manager`, temporary-password state/expiry, an authentication version, and `manager_sessions`. Dashboard manager status is independent of inference Roles and group membership. The singleton administrator remains unchanged.

Only the administrator can `PUT /admin/users/:id/manager` with `{enabled:true}` to promote an ACTIVE user, `{enabled:true,reset_password:true}` to reset an existing manager password, or `{enabled:false}` to demote. Promotion/reset returns a random temporary password once, with its UTC expiry 24 hours later; store only its scrypt hash. Share it manually. Demotion clears the manager password. Promotion, reset, demotion, password changes and suspension invalidate manager sessions; reactivation does not revive old sessions. Password verification runs outside transactions; credential versions and current account state are checked under a user-row lock before issuing sessions/changing credentials.

`/manager` is a separate, same-origin API using `mgr_` bearer sessions (eight hours, SHA-256 storage). Public `POST /manager/login` accepts `{email,password}`. Authenticated `GET /manager/session` returns identity and `password_change_required`; `POST /manager/logout` revokes that session; `PUT /manager/password` accepts `{current_password,password}`, minimum 12 characters, requires a different password and revokes all manager sessions. Temporary sessions can use only these account endpoints until changing their password. Expired temporary passwords require administrator reset. Check current ACTIVE/manager status, authentication version and expiry on every request. Keep login/password attempts and password work bounded, never trust forwarded IPs, and use shared ingress limits for multiple instances.

Managers see only `#overview`, `#usage`, `#users`, `#groups`, `#proxy-keys`, with all organizational data. They may create/edit/suspend/reactivate users, create/edit groups and memberships, create/revoke proxy keys, assign/unassign existing active inference Roles, change user caps, and generate/replace usage links. They cannot promote/demote/reset managers or configure infrastructure, policies, classifiers, pricing or diagnostics. Backend method/path allowlists enforce this independently of navigation and reject future/unknown routes by default. Shared resource/report handlers use the same response contracts under `/manager`; supporting `GET /manager/roles` returns only active role IDs/names/status, and provider/upstream-key lists return IDs/names for report labels. No role definitions, upstream credentials or configuration are exposed through these lookups. User list/detail responses include is_manager but never password/authentication fields. Suspension remains allowed even for a manager's own account.

The root page includes a separate email/password Manager sign in widget, including when administrator ingress is unavailable. First login forces a password change and another sign-in. Managers can change their password from the sidebar without access to Settings. Administrator-only manager controls appear on Users; temporary passwords are displayed once in a modal and held only in memory. Existing usage-link pages and inference API authorization remain independent.

Proxy `/manager/*` to the backend in development and production with 64 KiB JSON limits, no caching/private request logging, TLS, and login/password rate limiting. Preserve `/admin` ingress restrictions separately.

## Usage maintenance

Administrator-only `DELETE /admin/usage/events` accepts `{before:"YYYY-MM-DD"}` and deletes all usage events with completion `timestamp < before`, deleting linked cost assessments first. After deleting events and costs, it deletes terminal requests (SUCCESS/FAILED/REJECTED/CANCELLED) whose `completed_at` (or `started_at` when completion time is NULL) is strictly before the cutoff and which have no remaining usage events. This also cleans up old requests without usage. In-flight requests and requests with retained events remain; prices remain. The response includes `deleted_events`, `deleted_costs`, `deleted_requests`, and `completed`.

Administrator-only `POST /admin/usage/recalculate-costs` accepts `{start:"YYYY-MM-DD",end:"YYYY-MM-DD"}`. It selects events by completion timestamp in `[start,end)` and updates existing cost assessments using stored token counts/identities, current prices read within each batch transaction, manual-price precedence, and the same exact arithmetic as inference accounting. It updates component costs, `known_cost`, `requested_cost`, currency, pricing reference, status, reason and calculation time together. requested_cost is recalculated regardless of its previous NULL/non-NULL value when the requested provider or model differs from the actual identity and pricing supports a complete same-currency comparison. Matching actual/requested identities leave requested_cost NULL. Missing original requested identity leaves the comparison NULL; no token history is rewritten. Existing UNSUPPORTED assessments and events without an assessment are skipped because original request bodies/billing flags are not retained. Current provider API type determines Anthropic cache-write handling; historical API-type changes are not reconstructable. Response counts: `recalculated_events`, `skipped_unsupported`, `skipped_missing_assessment`, `completed`.

Both routes require the administrator session, reject unknown fields, and are unavailable to managers, proxy keys and viewing keys. Dates are strict UTC calendar dates or UTC timestamps (`YYYY-MM-DDTHH:mm:ss[.sss]Z`); date-only values mean midnight UTC. Each request captures the current maximum event ID (and maximum request ID for deletion) and processes all matching records through that ID in transactions of at most 100 records. Batches commit independently. A failure returns HTTP 500 with `completed:false` and counts of committed progress; disconnects stop work between batches. Retry the same criteria after a failure/disconnect. Explicit recalculation uses current prices; normal inference accounting also uses current prices at finalization. Maintenance changes report totals and may change current cap consumption. No background cleanup/repricing is scheduled. Administrator Settings exposes both operations through Usage maintenance controls.


## Duration-specific Claude cache pricing

The schema includes nullable `cache_write_5m_rate` and `cache_write_1h_rate` (USD per million tokens) in `model_pricing` and `pricing_catalog`, nullable `cache_write_5m_tokens` / `cache_write_1h_tokens` to `usage_events`, and nullable `cache_write_5m_cost` / `cache_write_1h_cost` to `usage_costs`. No historical usage, price values or costs are backfilled.

Native Anthropic and Bedrock Claude Messages retain `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` through JSON/SSE and normalized Chat usage. Aggregate cache-write counts remain inclusive of both durations and are not added again to input or total tokens. A reported duration breakdown must contain both valid counts and sum to the aggregate; missing/inconsistent breakdowns produce partial estimates. Each duration uses its own price; five-minute writes may fall back to the existing generic write rate, but one-hour writes never do. For cost estimation only, unreported aggregate cache-write counts (NULL or omitted) are assumed to be zero, like unreported cache reads; stored usage retains NULL. This applies to new assessments and explicit recalculation. Without a duration breakdown, legacy aggregate writes keep the existing generic calculation. Missing one-hour rates yield PARTIAL, not UNSUPPORTED. Special service tiers and server-tool charges remain unsupported.

`cache_write_cost` remains the total cache-write cost; the two duration costs are its breakdown, not additional charges. If a duration rate is unknown the aggregate write cost is NULL while calculable duration components still contribute once to `known_cost`. Both normal accounting and explicit recalculation use the same exact decimal arithmetic, including requested-model/provider comparisons. Recalculation retains stored duration counts and still skips historical UNSUPPORTED assessments because their original billing flags are unavailable. Reports expose duration token sums and reporting counts.

Pricing feeds accept optional `pricing.cache_write_5m` / `pricing.cache_write_1h`; absent rates stay NULL and are never derived from input-rate multipliers. Import preview, provider synchronization and aliases propagate both rates. Manual overrides accept optional `cache_write_5m_rate` / `cache_write_1h_rate` decimal strings or null. Settings displays both rates in Provider pricing mappings and create/edit Manual price overrides. Cache hits and refreshes continue to use the existing cache-read rate.

Settings → Manual price overrides **Update Claude Pricing** fetches `/admin/pricing/anthropic` and stages all six rates in existing override drafts. Matching uses case-sensitive literal model-ID containment in `model_pattern`, longest match first; the pricing endpoint replaces all version dots with hyphens (for example `claude-opus-5-5`). Null rates become blank inputs. Unmatched drafts remain unchanged. Changed fields are highlighted and rows display Unsaved changes, including ordinary manual edits; decimal formatting alone is not a change. Each row still requires Save to persist or Cancel to discard; the fetch does not write prices.


## Dual OpenAI/Anthropic providers

The provider schema includes the `OPENAI_ANTHROPIC` API type and nullable `llm_inference_providers.anthropic_api_url`. Existing provider types and URLs are preserved.

Provider Create/Edit offers `OPENAI_ANTHROPIC` and an optional Anthropic API base URL. The administrator provider POST/PATCH API accepts `anthropic_api_url` as an HTTP(S) URL without credentials, query or fragment; null clears it. Detail/list responses include this nullable field. It is used only for dual providers and falls back to `api_url` when null. The same upstream credential is used for both protocols with each adapter's normal authentication.

Dual providers forward `/v1/messages` and `/v1/messages/count_tokens` natively through the Anthropic base, preserving native body fields, protocol headers, JSON/SSE and sanitized errors. Other endpoints use existing OpenAI-compatible forwarding through `api_url`, including forced streamed Chat usage collection. There is no protocol fallback, inference retry or model-name heuristic. Model discovery and key checks use OpenAI `/models`; a listed model may not support native Messages. An unsupported combination returns the upstream error.

Dual-provider accounting uses Anthropic cache-write semantics only for `/v1/messages`; OpenAI endpoints keep OpenAI accounting. Explicit cost recalculation applies the same endpoint distinction using the current provider type, subject to the existing historical-type limitation. Count-token calls still skip classification, usage and costs. Existing role authorization, classification/remapping, caps and model-selection rules apply.


## Optional role scripts

The schema includes nullable MEDIUMTEXT `prompt_script`, `input_script` and `output_script` columns on roles. Administrator role POST/PUT accepts each as optional JavaScript text (at most 32768 characters per field). Null or whitespace-only text clears a field; omission on PUT preserves it. Saving checks syntax without execution; no function signature is required. Role list/detail responses include these fields. The existing 64 KiB administrative JSON request limit still applies to the combined payload.

The Roles create/edit widget exposes all three optional JavaScript editors, independently of classification-handler selection. Prompt, input and output script execution are described below.


### Custom classification prompts

When `roles.prompt_script` is non-null, `classificationPromptReplacement` calls `async function prompt(input, input_type, limit, context)`. Input is the complete original request JSON (including native Anthropic system fields); input_type is `ANTHROPIC` for Messages or `OPENAI` for OpenAI requests. Limit is `floor((maxToken ?? 30000) * 0.9)` (27000 by default), captured at authentication. The script controls prompt selection/truncation and must return a Promise resolving to a string (synchronous values and plain thenables are rejected); the gateway JSON-escapes that string for template insertion without additional truncation. Null prompt_script retains the existing message reduction, truncation and escaping.

The script executes once per eligible request, before cache lookup, in a permission-restricted child process with a 200 ms VM deadline, one-second wall-clock deadline, 64 MiB V8 heap and 256 KiB serialized result/context bound. Failures, invalid results, timeout or abort stop classification/inference with sanitized errors. Prompt scripts cannot mutate the original forwarded request. Token counting still skips classification and scripts.

Context starts as a fresh object per request. JSON-serializable mutations are passed to evaluation as the fifth argument `evaluate(input, input_type, classification, models, context)`; The second argument is input_type ("ANTHROPIC" or "OPENAI"). Existing stored scripts must be updated manually to the new argument order; no database migration rewrites them. Context is never shared between requests or roles. Script output and context cross the process boundary as bounded JSON. A cache hit still runs prompt preparation but skips classification/evaluation. Roles with input or output scripts cache and restore the post-evaluation context, with input/output script source and a hash of the full original request included in cache scope; entries exceeding the existing 8 KiB cache limit are not cached. Cache identity includes the exact escaped prompt sent to the classifier, custom prompt source and its resulting context, along with existing role/handler/evaluation/protocol scope. Input and output script execution are described below.


### Input transformation scripts

For JSON POST `/v1/chat/completions` and `/v1/messages`, a non-null role `input_script` runs `async function updateInput(input, input_type, context)` after optional classification/evaluation/model remapping and before inference. It also runs without a classifier. Input is the current request object, including any classification-selected model; input_type is `OPENAI` or `ANTHROPIC`. The Promise must resolve to a JSON object, which replaces the inference request. The request-local JSON context is shared with prompt/evaluation, including restored evaluation context on classification cache hits. Null input_script preserves existing forwarding; count_tokens and other endpoints skip it.

Execution uses the same restricted process, 200 ms VM/one-second wall-clock deadlines, 64 MiB V8 heap and 256 KiB serialized result/context bound as other role scripts. The transformed body must also fit BODY_LIMIT_BYTES. Errors, non-Promise or invalid results, timeout and cancellation stop inference without fallback. Revalidate model/messages, stream flag and native protocol fields; refresh billing-support metadata. Any classification-selected model and the final transformed model must pass current role policy. Route using the transformed model, preserve the original requested-model attribution, and account usage against the model actually sent.

When Chat completion debug logging is enabled, successful updateInput results are written as `update_input.json` alongside the original `input.json`, for both supported protocols. Capture occurs before transformed-request validation/provider adaptation. Files use 0600 in existing private request directories and the same seven-day retention and best-effort failure behavior. No file is created when logging is disabled or the script is absent/fails.


### Output transformation scripts

For JSON responses and JSON SSE events to POST `/v1/chat/completions` and `/v1/messages`, a non-null role `output_script` runs `async function updateOutput(output, output_type, context)` immediately before sending the body. The output is already translated into the client's protocol; output_type is `OPENAI` or `ANTHROPIC`, independent of upstream provider type. The Promise must resolve to a JSON object, which replaces the response body. HTTP status and safe response headers are preserved; response encoding/length headers are not reused. Null scripts preserve existing forwarding. Token counting and other endpoints skip output transformation. Streaming behavior is described below.

Context is shared with prompt/evaluation/input scripts, including restoration from classification cache for output-only roles. Usage and costs use original upstream counters, never script-modified response usage. Output changes do not alter the recorded sent model. Script exceptions, invalid JSON/results, timeout or cancellation fail without returning the original response as fallback; original collected usage is retained for accounting.

Output transformation buffers at most 1 MiB of the translated JSON response. Script execution retains the 200 ms VM/one-second wall-clock deadlines, 64 MiB V8 heap and 256 KiB serialized result/context bound. Streams remain incremental, with only one bounded event buffered for transformation.

With Chat completion debug logging enabled, `original_output.json` captures the translated JSON response before updateOutput runs, including when the script subsequently fails. Existing metadata output reflects the transformed response returned to the client. Capture uses the existing private directories, 0600 files, seven-day retention and best-effort writes. Capture does not require an output_script: pass-through JSON responses and JSON SSE events are also written to original_output.json for Chat Completions, Messages and Responses. No file is created when logging is disabled or no valid JSON output has been received. Pass-through JSON bodies and individual SSE events are bounded to 16 MiB; oversized or invalid payloads are skipped without affecting forwarding.


Streaming output_script calls updateOutput once per JSON SSE event, in order, after provider translation. All calls share request context, including mutations from prior events. Scripts should handle protocol events/chunks rather than assume a complete response. Named Anthropic events (including JSON pings and terminal message_stop), OpenAI usage chunks, tools and text deltas are eligible. Preserve event/id/retry/comment lines; non-JSON [DONE] markers and comment-only keepalives pass through without calling the script. SSE line endings are normalized to LF. Malformed JSON, incomplete events and events over 1 MiB fail the stream. The existing per-script time/memory/result limits apply to each call.

Forward transformed events incrementally with backpressure; disconnects cancel the source and active script. Script failure after headers are sent terminates the connection without a synthetic success marker. Accounting and completion validation inspect original upstream events. With diagnostics enabled, original_output.json is a JSON array of original event payloads, appended before each script call and closed during final cleanup, including on script failure. Capture is bounded to 16 MiB plus a truncation marker. Metadata output assembles transformed events as before. No complete response buffering is introduced.


For transformed OpenAI streams, hold the completion tail beginning at the first non-null finish_reason until its trailing JSON events have been transformed and [DONE] arrives, then send the tail together and end the HTTP response. The tail is bounded to 1 MiB; earlier content remains incremental. This avoids marking clients that close on finish_reason as CANCELLED while a trailing usage script is still running. Missing [DONE] fails without emitting a misleading completion tail. Transformed Anthropic message_stop likewise ends HTTP delivery immediately. Disconnects before completion still cancel execution and record CANCELLED; historical request statuses are not rewritten.


Roles → Show models opens a read-only overlay backed by administrator-only `GET /admin/roles/:id/models`. It freshly discovers models from all active assignments with active keys/providers, applies the current role policy and MODEL_DEFAULT, deduplicates IDs and returns `{data:[{id}]}` sorted by ID. Discovery bypasses the catalogue cache, has a 15-second overall timeout, and creates no inference/accounting events. Disabled roles and missing usable assignments show explicit errors; transient discovery failures share the proxy’s per-key cooldown and return permitted models from successful upstreams, or 503 if none succeed. The role overlay also skips credentials returning HTTP 401/403 when another upstream succeeds. If none succeeds and a credential was rejected, it reports a credential error. The overlay supports loading, empty/error states and Refresh.

Upstream keys → Show models uses administrator-only `GET /admin/upstream-keys/:id/models` to freshly list all model IDs advertised for that credential without role-policy filtering. Like the existing key check, disabled keys/providers can be inspected without enabling them. The response is `{data:[{id}]}`, sorted and deduplicated, with no credential or upstream metadata. Discovery bypasses caches, has a 15-second timeout, supports cancellation, sanitizes failures, and creates no accounting events. The shared models overlay supports loading, empty/error states and Refresh.


Bedrock Mantle streamed Chat Completions normalize SSE JSON events before accounting, output scripts and Messages translation. On clean EOF only, InferGate appends `[DONE]` when every requested choice has reported a nonempty finish reason and the last JSON event is a usage-only chunk with valid input/output/total token counts. A literal final `data: [DONE]` without a blank-line delimiter is also accepted. Transport failures, partial JSON/events, provider errors and missing finish/usage signals are not repaired. Normal completion markers are not duplicated; usage remains provider-reported. Normalization is bounded to one SSE event, preserves JSON payload fields and safe response headers, and omits SSE comments/metadata. Other providers and native Bedrock Anthropic Messages retain their existing completion rules.

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

### System prompt compaction

Administrators can enable independent role options in the role editor, role API or role MCP tools. The optional `system_prompt_compaction` object accepts booleans `removeComments`, `minifyJson`, `compactLists`, `cleanWhitespace`, and `collapseNewlines`. All default off. Supplying the object replaces the settings; omitting it on update preserves them.

Compaction runs once before optional classification. Classifier prompts, cache keys, evaluation, remapping and input scripts use the compacted request. Later input-script edits go directly to forwarding. It targets Chat Completions system messages, Responses instructions and system message items, and Anthropic top-level system text (including native token counting). Each text block is processed separately, preserving cache metadata. Comments use HTML comment syntax. JSON minification requires a valid fenced JSON literal. List indentation is reduced conservatively for standalone flat lists. Code, hard line breaks, and text that would become empty are protected. Review exact-spacing instructions and provider cache effects when enabling these options.

With debug capture active and any role compaction option enabled, eligible inference requests write the full post-compaction body to `input_compacted.json` before classification and input scripts, including when the text already satisfies the selected options. Token counting remains excluded from debug capture.

## Current pricing storage

A unique key enforces one price per `(provider_id, model_pattern, source_kind)` so manual and imported prices can coexist. All accounting, including ordinary inference finalization, uses current rows with manual-over-feed precedence. Imports and manual override saves update rows in place; stored cost amounts are unchanged until explicit recalculation. Deleting an override or removing a mapped imported price clears dependent cost price references before physical deletion. No usage events or cost assessments are deleted by this schema migration.
