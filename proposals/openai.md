# openai: `TracingChannel` Proposal

> **Issue:** [openai/openai-node#1819](https://github.com/openai/openai-node/issues/1819)
> **Status:** 💬 Issue opened

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to the OpenAI Node.js SDK, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted across the npm ecosystem.

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch SDK internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals. The OpenAI SDK explicitly supports Node.js, Deno, and Bun, making monkey-patching especially inadequate.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the SDK is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code into single executables, binaries, or deployment files.

The current instrumentation landscape for the OpenAI SDK illustrates this problem well. There is no official `@opentelemetry/instrumentation-openai`. Instead, APM vendors have independently built their own solutions:

- **Sentry** uses IITM to intercept `require('openai')`, wraps the `OpenAI` constructor, and creates a **deep recursive Proxy** around the client instance to intercept method calls at arbitrary nesting depth (`client.chat.completions.create`, `client.responses.create`, etc.). This only works on Node.js.
- **Traceloop's OpenLLMetry** similarly patches the constructor and wraps API methods.
- **Elastic, Datadog, and others** each implement their own monkey-patching approaches.

Every vendor independently replicates the same logic: intercept construction, proxy method calls, extract model/token attributes, handle streaming chunk accumulation. With native TracingChannel support, all of this becomes a single subscription.

If the OpenAI SDK emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `openai:chat` | Chat completion and response generation, from request to full response (or stream completion) | `method`, `model`, `stream`, `params` |
| `openai:embeddings` | Embedding generation | `model`, `params` |

Two channels rather than one because chat and embeddings have fundamentally different context shapes (messages, tools, and streaming for chat vs. input text and dimensions for embeddings). A `method` discriminator on the chat channel distinguishes between the Chat Completions API and the Responses API.

### `openai:chat` Context Properties

| Field | Source | OTel attribute it enables |
|---|---|---|
| `method` | API method path: `'chat.completions.create'`, `'responses.create'` | Distinguishes API surface. APMs use this to select the correct response parser |
| `model` | `params.model` | `gen_ai.request.model` |
| `stream` | `!!params.stream` | `gen_ai.request.stream`. Signals that the span should cover the full streaming lifecycle |
| `params` | Raw request parameters object | APMs extract: `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.request.available_tools` |
| `result` | Raw response object (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.text`, `gen_ai.response.tool_calls` |

### `openai:embeddings` Context Properties

| Field | Source | OTel attribute it enables |
|---|---|---|
| `model` | `params.model` | `gen_ai.request.model` |
| `params` | Raw request parameters object | APMs extract: `gen_ai.request.encoding_format`, `gen_ai.request.dimensions`, `gen_ai.embeddings.input` |
| `result` | Raw response object (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.total_tokens` |

### Why Raw Params and Response

The context passes raw `params` and the auto-set `result` (the API response) rather than pre-extracting individual attributes. This follows the pattern established by framework TracingChannel proposals (h3, Hono, Elysia) where raw objects are passed and APMs extract what they need. Benefits:

1. **Forward-compatible.** New API parameters and response fields are automatically available to subscribers without SDK changes.
2. **No duplication.** Extracted fields like `model` are convenience accessors for the most common attributes. Everything else comes from the raw objects.
3. **Privacy is the subscriber's concern.** The SDK emits what it has. APMs decide what to record based on their own `recordInputs`/`recordOutputs` policies.

---

## Streaming

For non-streaming requests, `tracePromise` wraps the full operation: `start` fires before the request, `asyncEnd` fires when the response promise resolves.

For streaming (`stream: true`), the SDK returns a stream object immediately, but the work continues until all chunks arrive. The TracingChannel lifecycle should cover the full duration, from request initiation to stream completion. The `result` is populated with accumulated data (token usage, finish reasons, response ID) when the stream ends. This ensures APM spans reflect total generation time, not just time to first chunk.

The exact streaming implementation is flexible. The key contract: subscribers see a single span covering the full streaming lifecycle, with the final accumulated result available on `asyncEnd`.

## Example: What the SDK Emits

A simplified sketch of what the instrumentation looks like inside the SDK:

```ts
import dc from 'node:diagnostics_channel';
const chatChannel = dc.tracingChannel('openai:chat');

// Inside chat.completions.create / responses.create
async function create(params) {
  if (chatChannel.hasSubscribers === false) {
    return this._makeRequest(params);
  }

  const context = { method: 'chat.completions.create', model: params.model, stream: !!params.stream, params };
  return chatChannel.tracePromise(() => this._makeRequest(params), context);
}
```

Fewer than 15 lines of code in the SDK. No Proxy, no constructor wrapping, no stream accumulation logic pushed onto consumers.

---

## How APM Tools Use This

### Today: Deep Proxy on the Client Constructor

Taking Sentry as an example, their OpenAI instrumentation uses IITM to intercept `require('openai')`, replaces the `OpenAI` constructor, and creates a deep recursive Proxy on the resulting client instance to intercept method calls at arbitrary nesting depth. This spans **~1,200 lines across 6 files**:

- [instrumentation.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/node/src/integrations/tracing/openai/instrumentation.ts) (125 lines): IITM module patching, constructor wrapping
- [core/index.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/openai/index.ts) (269 lines): deep Proxy creation, method interception, span lifecycle
- [streaming.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/openai/streaming.ts) (236 lines): async iterable wrapping, chunk accumulation, stream error handling
- [utils.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/openai/utils.ts) (194 lines): attribute extraction from requests and responses
- [constants.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/openai/constants.ts) (31 lines): method registry mapping API paths to operation types
- [types.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/openai/types.ts) (366 lines): type definitions for responses, streaming events, options

This approach has several problems:
- **Replaces the `OpenAI` constructor**, wrapping every client instance even if no APM is listening
- **Deep recursive Proxy on every property access.** Every `client.chat.completions.create()` call goes through 3 levels of Proxy `get` traps
- **IITM dependency.** Only works on Node.js, not on Deno or Bun where the SDK also runs
- **Stream wrapping is fragile.** Each vendor independently implements async iterable wrapping with chunk accumulation and error handling
- **Each APM vendor builds their own.** Sentry, Traceloop, Elastic, Datadog all independently replicate the same deep-proxy pattern

### With TracingChannel: Subscribe to Structured Events

```ts
import dc from 'node:diagnostics_channel';

dc.tracingChannel('openai:chat').subscribe({
  start(ctx) {
    // ctx.method, ctx.model, ctx.stream, ctx.params available
    ctx.span = tracer.startSpan(`chat ${ctx.model}`);
  },
  asyncEnd(ctx) {
    // ctx.result is auto-set by TracingChannel with the API response
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.recordException(ctx.error);
  },
});
```

**What changes for APM vendors:**

| Concern | Monkey-patching (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | IITM intercepts `require('openai')` before first import | Subscribe to `diagnostics_channel` at any time. No ordering constraint |
| **Scope** | Replace constructor + deep Proxy on every client instance | Two channel subscriptions |
| **Method interception** | Recursive Proxy intercepts every property access on the client, even non-traced methods | No proxying. SDK emits events at execution time, subscribers observe |
| **Streaming** | Each vendor independently wraps async iterables, accumulates chunks, handles errors | SDK handles accumulation internally; subscribers see a single span with the final response |
| **Multi-vendor** | Each vendor builds their own deep-proxy + stream accumulation logic | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly remove a recursive Proxy from a constructor replacement | `unsubscribe()`, clean and reversible |
| **Runtime support** | IITM: Node.js only. SDK runs on Node.js, Deno, and Bun | Any runtime with `diagnostics_channel` |
| **Maintenance** | External packages must track SDK internal structure changes across Stainless regenerations | Native, maintained as part of the SDK |

---

## Implementation Notes

### Insertion Points

The OpenAI SDK is generated by [Stainless](https://www.stainless.com/). TracingChannel instrumentation should be added at the resource method level, where each API method (`chat.completions.create`, `responses.create`, `embeddings.create`) calls into the core HTTP client. This is where the operation type, model, and parameters are known.

Stainless supports custom code that persists across regeneration. TracingChannel support could be added as:
1. **A core middleware in the HTTP client pipeline**, triggered for specific resource methods
2. **Custom method wrappers** at the resource class level, configured through Stainless

The exact integration point is an implementation detail. The key requirement is that events are emitted at the right lifecycle moments with the right context.

### Async Model

All SDK methods return Promises. `tracePromise` is the correct wrapper for non-streaming operations. Streaming operations need manual lifecycle management (see the Streaming section above).

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

### Zero-Cost Guarantee

Context objects should only be constructed inside a `hasSubscribers` guard:

```ts
if (shouldTrace(chatChannel)) {
  const context = { method, model: params.model, stream: !!params.stream, params };
  return chatChannel.tracePromise(fn, context);
} else {
  return fn();
}
```

When no APM subscribes, the overhead is a single boolean check per API call.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before constructing any context objects. Silently skipped on runtimes where `TracingChannel` is unavailable.

Since the OpenAI SDK supports Node.js, Deno, and Bun, the cross-runtime loading pattern is needed:

```ts
let dc;
try {
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    dc = process.getBuiltinModule('node:diagnostics_channel');
  }
  if (!dc) {
    dc = require('node:diagnostics_channel');
  }
} catch {
  // diagnostics_channel not available on this runtime, no-op
}
```

- `typeof process` guard: safe in browsers and edge runtimes where `process` doesn't exist
- `getBuiltinModule` path: bundler-invisible (no static import to resolve), works in Node 22.3+, Deno, and Bun 1.2.7+
- `require` fallback: covers older Node, Bun, and Cloudflare Workers (with `nodejs_compat`)
- `try/catch`: swallows the error in browsers or any runtime without `diagnostics_channel`

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) ✅ merged
- **`elysia`**: [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809), in discussion
- **`hono`**: [honojs/hono#4842](https://github.com/honojs/hono/issues/4842), issue opened
- **`koa`**: proposal drafted

**Databases:**
- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) ✅ merged
- **`node-redis`**: [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) ✅ merged
- **`ioredis`**: [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) ✅ merged
- **`pg` / `pg-pool`**: [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650), PR open
- **`knex`**: [knex/knex#6410](https://github.com/knex/knex/pull/6410), PR open
- **`mongodb`**: [NODE-7472](https://jira.mongodb.org/browse/NODE-7472), issue opened
- **`mongoose`**: [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105), issue opened
- **`tedious`**: [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727), issue opened
- **`@prisma/client`**: [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353), issue opened

**Other:**
- **`graphql`**: [graphql/graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629), issue opened
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193), PR open

---

## Related

- [openai/openai-node#1563](https://github.com/openai/openai-node/issues/1563): existing request for OpenTelemetry observability support. TracingChannel addresses this at a lower level, enabling any APM tool (not just OTel) to subscribe without monkey-patching.

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
