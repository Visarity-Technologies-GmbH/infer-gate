# InferGate frontend

React 18 / JavaScript administrative dashboard. Uses native fetch, React, React DOM and Vite; no UI framework.

## Development

Start the backend using its README, then run:

```sh
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Vite forwards `/admin`, `/manager` and `/user` requests to http://127.0.0.1:3000. Set `INFERGATE_BACKEND_URL` when starting Vite to change the target. The initial setup screen requires the backend bootstrap token and a password of at least 12 characters.

## Production

```sh
npm ci
npm run build
```

Serve `dist/` over HTTPS with a web server and reverse-proxy `/admin/*`, `/manager/*`, `/user/*` and `/v1/*` to the backend on the same origin. Keep the backend private. Navigation uses URL hashes, so no route fallback is required. `npm run preview` previews the built files only and requires a separate same-origin API proxy for API calls; it is not a production server. Fonts use Google Fonts with system fallbacks.

## Behavior

- Setup, sign-in, session expiry, logout, password changes.
- User creation/editing/suspension, group editing and immediate membership changes.
- Provider and upstream-key creation/editing/disablement.
- Classification handler creation/editing with name, description, API URL, encrypted API key and a JSON request template. The default is `{ "prompt": "${PROMPT}" }`; the form and server reject invalid JSON. Apply backend migration 009 before using this page. Assigned handlers run before model policy and inference, substituting a JSON-encoded messages string. Chat completion debug logging saves the JSON result in `classification.json` within the request's log directory.
- Chat completion debug logging also saves successful evaluation output to `evaluate.json` within the same request directory. No evaluation file is created if evaluation is skipped or fails, or logging is disabled.
- `classification_req.json` contains the exact rendered JSON body sent to the classification API, without authentication headers. It is saved only when debug logging is enabled and classification is attempted.
- Classification payloads include only system/user messages, with tool_calls and reasoning_content removed. Full original messages are retained for evaluation, inference and input debug logs.
- Redis caches classification routing for one hour using the first system and all user message contents in order, scoped to the role and handler/evaluation configuration. Hits skip classification/evaluation and reuse the model, category and sensitivity; normal authorization and model policy still apply. Debug metadata marks `classification_cache_hit`; skipped classification/evaluation files are omitted. Configure Redis in the backend `.env`.
- Roles can optionally reference one classification handler. Select a handler when creating or editing a role, or choose **None** to remove it. The role table displays the assigned handler. Apply backend migration 010 before using this selector.
- Selecting a classification handler reveals an editable JavaScript evaluation script, prefilled with the default `evaluate(input, input_type, classification, models, context)` contract. **Reset to default** restores it. The server checks JavaScript syntax on save; custom scripts are retained when the handler is removed or changed. Apply backend migration 011. Scripts run after successful classification, receiving the original request, classifier response and available model IDs. Apply backend migration 012 to store category and sensitiveData on usage events. The first available ID in returned models replaces the requested model, subject to model policy; null, an empty list or no match retains the original.
- Proxy-key creation with a one-time secret display, revocation, assignments and model policies.
- Dashboard, daily token chart, usage grouping, date/model/status filters, a multi-select group filter and paginated requests. Select groups and click Apply filters to include users in any selected group; no selection includes everyone, including users without a group.
- Recent requests shows the selected model, requested model (falling back to model when NULL), category and sensitive data (Yes/No/—). Classification metadata comes from the latest usage event, with one row per request.
- Dates filter inclusive calendar dates in UTC by converting the end date to the next day's exclusive boundary. Display timestamps use the browser's local timezone.
- Administrator tokens and newly generated proxy keys are held only in React memory. Reloading requires sign-in. Upstream credentials are submitted only for creation and never listed.
- Group member retrieval is limited to 500 by the current API; usage reports to 1,000 groups. Resource lists load all API pages.
- Unreported usage displays `—`, not zero. No fabricated metrics or costs. Pricing/accounting management is pending backend endpoints.

Run `npm test` for API-client security, error, pagination and null-accounting tests, and `npm run build` to validate the production bundle.

The upstream-key overview automatically checks every listed credential through the provider's models API (including disabled records; this does not activate them). Checks run four at a time and repeat on refresh or edits. Each row shows the current check result, safe error details and completion time. A successful model listing confirms models API access, not inference access to every model.

Inference providers → Create/Edit includes an API type selector for `OPENAI_COMPATIBLE`, `ANTHROPIC`, `GEMINI`, `AWS_BEDROCK` and `OPENAI_ANTHROPIC`, initialized to the provider's current type when editing. Switching to or from Bedrock is rejected by the backend if the provider already has upstream keys; create a separate provider in that case.

Model Policies has its own navigation page for creating and editing named rule sets. Assign a reusable policy via Proxy API keys → Configure → Model policy. One policy can be shared by multiple keys; edits affect every assigned key. No policy uses the backend's default model authorization. Apply backend migration 005 before using this feature.


## User usage page

In **Users → Usage link**, generate or replace the user's private viewing link. Copy it before closing the dialog; it is displayed once. Replacing the link immediately invalidates its predecessor. The `/#user-<key>` page identifies the user in its header as `INFERGATE · YOUR USAGE: {name} ({email})` and opens directly without administrator sign-in and shows only the associated user's consumption for today (explicitly UTC), daily/weekly token or estimated USD cap, consumption in that cap period, remaining allowance to the 95% cutoff, and next UTC reset. It refreshes every minute and offers manual refresh. It has no configuration controls. Suspended users and invalid/replaced links cannot retrieve usage.

The link itself grants viewing access. Viewing keys are separate from administrator and proxy credentials, sent in an authorization header to `/user/usage`, and never stored in local/session storage. Expose `/user/*` through the same-origin production API proxy. Apply the backend viewing-key migration before generating links.


The user usage page also displays today's estimated cost (UTC), grouped by currency, using stored cost assessments rather than current prices. The `/user/usage` response includes `today.costs` with exact decimal `estimated_cost` and `known_cost` sums and today's counts of fully priced, partially priced, unpriced (including missing assessments), and unsupported usage events. When coverage is incomplete the page labels amounts as the known portion and shows coverage; unavailable costs display —. These estimates include reported failed/cancelled usage and do not change the separate cap-enforcement rules. No additional database migration is needed for this cost display.


See the [complete Nginx deployment example](../deploy/nginx/README.md) for HTTPS, frontend hosting, API routing, streaming, administrator ingress restrictions and deployment checks.


The user page reuses Overview's **Token activity** bar chart for the last 14 UTC calendar days (today and the preceding 13 days). `/user/usage` includes `activity: {start, end, days}` with 14 chronological daily buckets, scoped on the server to the authenticated viewing key's user. Dates with no usage events have zero tokens; recorded events with unavailable totals retain NULL, and partial reporting remains identified by reporting counts. The interval is inclusive at the first midnight and exclusive at tomorrow's midnight. Reported failed/cancelled usage is included, matching today's token summary. The chart refreshes with the rest of the page and requires no new migration. Its shared frontend component is `frontend/src/components/Activity.jsx`.


## Manager dashboard

After backend migration 018, the root sign-in page offers a separate **Manager sign in** widget with email/password. It remains usable when administrator ingress restrictions block the administrator setup check. First login with an administrator-issued temporary password forces a new password (at least 12 characters), then another sign-in. Temporary passwords expire after 24 hours; request an administrator reset if expired or forgotten. Manager sessions expire after eight hours, remain only in React memory, and are revoked by password changes/resets, suspension or demotion.

Managers see only Overview, Usage & requests, Users, Groups and Proxy API keys with organization-wide data. They can create/edit/suspend/reactivate users, create/edit groups and memberships, create/revoke keys and assign existing active inference Roles, edit user caps, and generate/replace usage links. Other hash routes show Overview with an access notice, and backend permissions independently protect the APIs. **Change password** is available in the manager sidebar. Existing read-only usage links still open independently.

Only the administrator sees **Promote to manager** / **Manager access** on Users. Promotion and password reset show a temporary password once for manual delivery; closing the modal discards it. Manager access also offers removal, which signs out that user's manager sessions. Infrastructure and Settings remain administrator-only. Reports use minimal provider/upstream name lookups; managers cannot inspect their configuration or edit Role definitions.

### Usage maintenance

Administrator Settings includes Usage maintenance controls to delete old history (`DELETE /admin/usage/events`) and recalculate costs (`POST /admin/usage/recalculate-costs`). Date inputs use UTC midnight; deletion is strictly before the cutoff, and recalculation includes the start date and excludes the end date. Both operations show a confirmation with the selected dates; deletion also requires acknowledgment that it cannot be undone. The controls disable during an operation and display deleted event/cost/request counts or recalculated/skipped assessment counts. Failed operations retain any returned progress and explain how to retry the same dates. Recalculation uses current effective prices and recalculates eligible requested-cost comparisons even when previously NULL. Managers do not see Settings and cannot use these endpoints.

The existing Chat completion debug logging switch covers both `POST /v1/chat/completions` and `POST /v1/messages`, including native and translated JSON/SSE responses. It saves original input and assembled final/partial output under the same retention and permission rules; Messages token-count requests are excluded.


### Claude cache pricing

Settings → Manual price overrides includes **Update Claude Pricing**. It fetches `/admin/pricing/anthropic` using the administrator session and fills editable drafts for existing overrides whose `model_pattern` contains the pricing model ID. Matching is literal and case-sensitive and uses the longest matching ID. The pricing endpoint converts version dots to hyphens (for example `claude-opus-5-5`). All six rates are copied, with null prices becoming blank fields; unmatched drafts remain untouched. Changed fields are highlighted and rows show **Unsaved changes**, just as for manual edits. Decimal formatting alone does not mark a change. A status message reports the number of rows updated by the click. Review each row and use **Save** to persist or **Cancel** to discard. The button is disabled while a pricing action runs; errors appear in the existing pricing error box.

After backend migration 025, Settings → Provider pricing mappings shows separate five-minute and one-hour cache-write catalog rates. Manual price overrides supports creating and editing both rates in USD per million tokens. Five-minute writes can use the generic rate when their specific rate is blank; one-hour writes require their own rate. Cache reads, hits and refreshes share the cache-read rate. Changes apply to future requests; explicit Usage maintenance recalculation can reprice supported events with stored duration counts. Historical unsupported assessments remain unchanged.


## Dual OpenAI/Anthropic providers

Apply migration `026_dual_protocol_providers.sql` before deploying this feature. It adds `OPENAI_ANTHROPIC` to the provider API types and nullable `llm_inference_providers.anthropic_api_url`. Existing provider types and URLs are preserved.

Provider Create/Edit offers `OPENAI_ANTHROPIC` and an optional Anthropic API base URL. The administrator provider POST/PATCH API accepts `anthropic_api_url` as an HTTP(S) URL without credentials, query or fragment; null clears it. Detail/list responses include this nullable field. It is used only for dual providers and falls back to `api_url` when null. The same upstream credential is used for both protocols with each adapter's normal authentication.

Dual providers forward `/v1/messages` and `/v1/messages/count_tokens` natively through the Anthropic base, preserving native body fields, protocol headers, JSON/SSE and sanitized errors. Other endpoints use existing OpenAI-compatible forwarding through `api_url`, including forced streamed Chat usage collection. There is no protocol fallback, inference retry or model-name heuristic. Model discovery and key checks use OpenAI `/models`; a listed model may not support native Messages. An unsupported combination returns the upstream error.

Dual-provider accounting uses Anthropic cache-write semantics only for `/v1/messages`; OpenAI endpoints keep OpenAI accounting. Explicit cost recalculation applies the same endpoint distinction using the current provider type, subject to the existing historical-type limitation. Count-token calls still skip classification, usage and costs. Existing role authorization, classification/remapping, caps and model-selection rules apply.


## Optional role scripts

Migration `027_role_optional_scripts.sql` adds nullable MEDIUMTEXT `prompt_script`, `input_script` and `output_script` columns to roles. Apply it through the normal migration workflow before deploying this change. Administrator role POST/PUT accepts each as optional JavaScript text (at most 32768 characters per field). Null or whitespace-only text clears a field; omission on PUT preserves it. Saving checks syntax without execution; no function signature is required. Role list/detail responses include these fields. The existing 64 KiB administrative JSON request limit still applies to the combined payload.

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

With Chat completion debug logging enabled, `original_output.json` captures the translated JSON response before updateOutput runs, including when the script subsequently fails. Existing metadata output reflects the transformed response returned to the client. Capture uses the existing private directories, 0600 files, seven-day retention and best-effort writes. No original_output.json is created when logging is disabled, output_script is null, or no JSON event has been received.


Streaming output_script calls updateOutput once per JSON SSE event, in order, after provider translation. All calls share request context, including mutations from prior events. Scripts should handle protocol events/chunks rather than assume a complete response. Named Anthropic events (including JSON pings and terminal message_stop), OpenAI usage chunks, tools and text deltas are eligible. Preserve event/id/retry/comment lines; non-JSON [DONE] markers and comment-only keepalives pass through without calling the script. SSE line endings are normalized to LF. Malformed JSON, incomplete events and events over 1 MiB fail the stream. The existing per-script time/memory/result limits apply to each call.

Forward transformed events incrementally with backpressure; disconnects cancel the source and active script. Script failure after headers are sent terminates the connection without a synthetic success marker. Accounting and completion validation inspect original upstream events. With diagnostics enabled, original_output.json is a JSON array of original event payloads, appended before each script call and closed during final cleanup, including on script failure. Capture is bounded to 16 MiB plus a truncation marker. Metadata output assembles transformed events as before. No complete response buffering is introduced.


For transformed OpenAI streams, hold the completion tail beginning at the first non-null finish_reason until its trailing JSON events have been transformed and [DONE] arrives, then send the tail together and end the HTTP response. The tail is bounded to 1 MiB; earlier content remains incremental. This avoids marking clients that close on finish_reason as CANCELLED while a trailing usage script is still running. Missing [DONE] fails without emitting a misleading completion tail. Transformed Anthropic message_stop likewise ends HTTP delivery immediately. Disconnects before completion still cancel execution and record CANCELLED; historical request statuses are not rewritten.
