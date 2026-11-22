# Four scripts hooks enabling classification, model-routing, compaction etc.
An InferGate role has **four JavaScript scripts**. On a request that uses all four, they run in this order: `prompt` prepares text for the classifier → `evaluate` uses the classifier’s answer to select a model → `updateInput` edits the request before inference → `updateOutput` edits what the client receives.

Each function must return a **Promise**. The simplest way to meet that contract is to declare the function `async` and `return` the value described below.

| Role script | Function signature | What the return value controls |
|---|---|---|
| Prompt | `async function prompt(input, input_type, limit, context)` | A **string** inserted into the classifier’s `${PROMPT}` placeholder. |
| Evaluation | `async function evaluate(input, input_type, classification, models, context)` | An **object** containing classification metadata and optional model preferences. |
| Input | `async function updateInput(input, input_type, context)` | A **JSON object** that replaces the complete inference request body. |
| Output | `async function updateOutput(output, output_type, context)` | A **JSON object** that replaces the complete client response body or one streaming event payload. |

`input_type` and `output_type` identify the **client protocol**. Their values are `OPENAI` for `/v1/chat/completions`, `ANTHROPIC` for `/v1/messages`, and `OPENAI_RESPONSES` for `/v1/responses`. For example, an Anthropic Messages client routed to an OpenAI-compatible provider still gets `output_type === "ANTHROPIC"`.

### 1. `prompt(input, input_type, limit, context)`

`input` is the **original parsed JSON request**. Its shape depends on `input_type`. Chat Completions has `input.messages`, Anthropic Messages can also have a top-level `input.system`, and Responses uses `input.input` and can include `input.instructions`.

`limit` is a **character budget** calculated as `Math.floor((maxToken ?? 30000) * 0.9)`, or **27,000 characters** by default. A custom script chooses what to include and applies its own truncation. Return the text directly. InferGate JSON-escapes it for insertion into the classifier template and applies no further truncation. This function changes what the **classifier** sees. The original request remains available to `evaluate` and `updateInput`.

### 2. `evaluate(input, input_type, classification, models, context)`

`input` is still the **original request**. `classification` is the parsed JSON returned by the configured classifier, so its fields depend on that classifier. The `models` **argument** is an array of model ID strings discovered across the role’s usable upstream assignments.

The default function returns this object:

```js
return { category: "other", sensitiveData: false, complexity: 0, models: null };
```

- `category` is a required string of up to 255 characters.
- `sensitiveData` is a required boolean recorded as metadata. Setting it to `true` does not itself block or reroute inference.
- `complexity` is optional or `null`. Use `0` for easy, `1` for medium, or `2` for hard.
- The returned `models` field is an **ordered preference list** of model IDs, or `null`. InferGate selects the first available candidate. `null`, `[]`, or no available match keeps the requested model. If policy denies the selected candidate, the request fails without trying the next candidate.
### 3. `updateInput(input, input_type, context)`

Here `input` is the **current inference request**. If evaluation selected another model, `input.model` already contains that selection. Return the **whole request body**, including the fields you want to keep. For example, this script changes one Chat Completions field and passes other protocols through:

```js
async function updateInput(input, input_type, context) {
  if (input_type === "OPENAI") input.temperature = 0.2;
  return input;
}
```

InferGate validates the returned body and enforces model policy before forwarding. This script also runs when the role has no classifier. For Responses continuation requests using `previous_response_id` or `conversation`, it can edit permitted fields but must preserve the model and conversation references.

### 4. `updateOutput(output, output_type, context)`

`output` is the parsed JSON **after translation into the client’s protocol**. For a non-streaming response, the function runs once with the complete response object. For a stream, it runs once per JSON event, in order. An event may contain a text delta, tool data, usage, or a protocol lifecycle event. Non-JSON markers such as `[DONE]` pass through without a call.

Return the whole response object or event payload. `return output` passes it through unchanged. Edits affect the response the client sees. Accounting continues to use the original upstream usage counters and the model actually sent.

### `context` across all four scripts

`context` starts with `{ user_id, role_id, request_id }`. You can add JSON-serializable fields in one script and read them in later scripts **on the same request**, including subsequent `updateOutput` calls in a stream. It also provides `await context.logDebug(fileName, text)`, `await context.readStringCache(key)`, `await context.writeStringCache(key, value)`, `await context.fetchJson(object, apiUrl, bearerToken)`, and synchronous `context.md5(text)`. Redis string-cache keys are shared across requests, roles, and users.

One detail matters when passing values between scripts: on a **classification cache hit**, prompt preparation still runs, but `evaluate` is skipped. Input and output scripts can read fields added by `prompt` on this request. Fields that only `evaluate` would have added can be absent. Responses continuation requests skip both `prompt` and `evaluate` but still run configured input and output scripts. `/v1/messages/count_tokens` skips all four.

### `context.fetchJson(object, apiUrl, bearerToken)`

This asynchronous helper is available in all four role scripts. It sends an HTTP POST to `apiUrl` with `JSON.stringify(object)` as the body and these headers.

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Authorization` | `Bearer ${bearerToken}` |

The Promise resolves to the parsed JSON response, or `null` for an empty response body. Invalid JSON throws an error with the message `Invalid JSON response from ${apiUrl}`. For an unsuccessful HTTP status, the helper throws an error with these properties.

| Property | Value |
|---|---|
| `message` | The first truthy value of `result.message`, `result.error`, or `"Request failed"`, converted to an error message. |
| `status` | The HTTP response status code. |
| `response` | The parsed JSON response, including `null` for an empty body. |

A script can catch helper failures and choose how to proceed. This example records a service result in request-local context and logs a failure when debug logging is enabled. Replace the example URL and token with the intended service configuration.

```js
async function updateInput(input, input_type, context) {
  try {
    context.serviceResult = await context.fetchJson(
      { model: input.model, input_type },
      "https://example.com/analyze",
      "YOUR_SERVICE_TOKEN"
    );
  } catch (error) {
    await context.logDebug("fetch-error.json", JSON.stringify({
      message: error.message,
      status: error.status,
      response: error.response
    }));
  }
  return input;
}
```

Each call has a **60-second default deadline**, configured with `SCRIPT_FETCH_TIMEOUT_MS=60000`, covering the HTTP request and response body read. A per-call timeout rejects the Promise and can be caught by the script.

Time with one or more pending `fetchJson` calls is excluded from the existing **one-second script execution budget**. Each script invocation also has a **300-second default total deadline**, configured with `SCRIPT_TOTAL_TIMEOUT_MS=300000`, including all waits. The total deadline terminates the script process, so script-level `catch` blocks cannot recover from it. For streaming output scripts, these budgets apply separately to each event invocation. The **200 ms synchronous JavaScript limit** still applies.

The overall gateway request timeout or client cancellation can end execution earlier. Outstanding fetches are cancelled when the script finishes or is terminated. The helper bridge allows at most **32 KiB of serialized arguments** per call, including the object, URL and token. The existing **256 KiB serialized script result/context limit** also applies when returning or retaining fetched data.

When calling InferGate itself, the supplied proxy key determines the nested request's role and scripts. Use a role without the same transformation when the nested input could trigger recursive calls. Each nested request has its own diagnostic directory. The parent request's successful input transformation is captured as `update_input.json` in the parent's directory when debug logging is enabled.

# Examples and local testing

The `scripts/examples` directory includes two examples.

- `jev_classification_routing` demonstrates how to use JEV from Typesafe AI for classification and semantic model routing.
- `reasoning_compaction` calls an LLM for each reasoning or thinking string in the input to compact or shorten it and reduce input tokens.

`scripts/script_test.js` lets administrators test each kind of role script independently of the gateway request flow. The `scripts/test_data_in` directory provides sample test data. Request files captured by the gateway's debug logging can also be used as input.
