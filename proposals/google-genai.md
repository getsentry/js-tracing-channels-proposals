# @google/genai (Google Gen AI SDK): `TracingChannel` Proposal

> **Issue:** TBD
> **Status:** 📝 Proposal drafted

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to the Google Gen AI JavaScript SDK (`@google/genai`), following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted across the npm ecosystem.

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch SDK internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals. `@google/genai` ships a web build and explicitly targets browsers and edge runtimes in addition to Node.js, making monkey-patching especially inadequate.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the SDK is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code into single executables, binaries, or deployment files.

There is no official `@opentelemetry/instrumentation-google-genai`. Instead, APM vendors have independently built their own solutions:

- **Sentry** uses IITM/RITM to intercept `require('@google/genai')`, wraps the `GoogleGenAI` constructor, and instruments the resulting client instance to intercept method calls (`models.generateContent`, `chats.create` → `chat.sendMessage`, etc.). Because `@google/genai` re-exports its concrete implementation from a nested `dist/node/index.cjs` file, Sentry needs an **additional file-level patch** on that inner module so the wrapping isn't silently missed or overwritten when the real implementation loads. This only works on Node.js.
- **Traceloop's OpenLLMetry**, **Elastic**, **Datadog**, and others each implement their own monkey-patching approaches.

Every vendor independently replicates the same logic: intercept construction, wrap method calls, extract model/token attributes, handle streaming chunk accumulation. With native TracingChannel support, all of this becomes a single subscription.

If the Gen AI SDK emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically. The channel design aims to support the [OpenTelemetry Semantic Conventions for Generative AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/), enabling APM vendors to produce standard `gen_ai.*` spans and attributes from the emitted events.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `@google/genai:models.generateContent` | Non-streaming content generation (`models.generateContent`) | `model`, `params` |
| `@google/genai:models.generateContentStream` | Streaming content generation (`models.generateContentStream`), from request initiation to stream completion | `model`, `params` |
| `@google/genai:models.embedContent` | Embedding generation (`models.embedContent`) | `model`, `params` |
| `@google/genai:chats.sendMessage` | Non-streaming multi-turn chat turn (`chat.sendMessage` on a chat created via `ai.chats.create()`) | `model`, `params` |
| `@google/genai:chats.sendMessageStream` | Streaming chat turn (`chat.sendMessageStream`), from request initiation to stream completion | `model`, `params` |

### Why Separate Channels

Each API method gets its own `TracingChannel`. This follows the `diagnostics_channel` design philosophy: many purpose-focused channels with their own subscriber sets, so dispatch is extremely cheap. Subscribers listen only to the operations they care about rather than filtering a firehose channel, which would add continuous overhead on every published message. It also eliminates the need for a `method`/`stream` discriminator field in the context — the channel name itself identifies the operation and whether it streams.

`ai.chats.create()` is intentionally **not** a channel. It is a local factory that returns a `Chat` object; it performs no network request. The traceable work happens when `chat.sendMessage()` / `chat.sendMessageStream()` is called on that object, which is where the channels fire.

Administrative/utility calls (e.g. `models.list`, `models.get`, `models.countTokens`, file and cache management) don't represent AI inference operations. APMs generally don't create GenAI spans for these, so they are excluded to keep the channels focused on the operations that matter for tracing.

### Context Properties

Shared across the generation and chat channels:

| Field | Source | OTel attribute it enables |
|---|---|---|
| `model` | `params.model`, or the `Chat` instance for chat turns (see note below) | `gen_ai.request.model` |
| `params` | Raw request parameters object | APMs extract: `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.top_k`, `gen_ai.request.max_tokens`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.request.available_tools` |
| `result` | Raw response object (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.text`, `gen_ai.response.tool_calls` |

For the `models.embedContent` channel:

| Field | Source | OTel attribute it enables |
|---|---|---|
| `model` | `params.model` | `gen_ai.request.model` |
| `params` | Raw request parameters object | APMs extract: `gen_ai.embeddings.input` (from `params.contents`) |
| `result` | Raw response object (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.usage.input_tokens`, `gen_ai.usage.total_tokens` |

### Two SDK specifics worth calling out

These are the details that make Google's SDK differ from OpenAI's / Anthropic's, and they're exactly where independent monkey-patchers get things subtly wrong:

1. **Model lives on the `Chat` instance for chat turns.** For `models.generateContent`, the model is on `params.model`. For `chat.sendMessage`, the params carry only the message — the model is a property of the `Chat` object (`model` in older versions, `modelVersion` in newer ones). Emitting `model` as a resolved context field means subscribers don't have to reach into chat internals or guess.
2. **Generation config is nested under `params.config`.** Unlike the flat parameter bags in other SDKs, Google nests `temperature`, `topP`, `topK`, `maxOutputTokens`, `frequencyPenalty`, `presencePenalty`, `tools`, and `systemInstruction` under `params.config`. Passing raw `params` keeps this structure intact so subscribers read it directly; the OTel mapping above already accounts for the nesting.

### Why Raw Params and Response

The context passes raw `params` and the auto-set `result` (the API response) rather than pre-extracting individual attributes. This follows the pattern established by framework TracingChannel proposals (h3, Hono, Elysia) where raw objects are passed and APMs extract what they need. Benefits:

1. **Forward-compatible.** New request parameters and response fields (new modalities, thinking/reasoning output, grounding metadata) are automatically available to subscribers without SDK changes.
2. **No duplication.** `model` is a convenience accessor for the most common attribute (and it resolves the chat-instance quirk). Everything else comes from the raw objects.
3. **Privacy is the subscriber's concern.** The SDK emits what it has. APMs decide what to record based on their own `recordInputs`/`recordOutputs` policies.

---

## Streaming

For non-streaming requests (`generateContent`, `embedContent`, `chat.sendMessage`), `tracePromise` wraps the full operation: `start` fires before the request, `asyncEnd` fires when the response promise resolves.

For streaming (`generateContentStream`, `chat.sendMessageStream`), the SDK returns an async generator immediately, but the work continues until all chunks arrive. The TracingChannel lifecycle should cover the full duration, from request initiation to stream completion. The `result` is populated with the final accumulated data (aggregated text, token usage from the terminal chunk's `usageMetadata`, finish reasons, response model) when the stream ends. This ensures APM spans reflect total generation time, not just time to first chunk.

Today, every APM vendor independently implements this streaming accumulation over Google's chunk sequence. With TracingChannel, the SDK handles it internally and exposes the final accumulated result on `asyncEnd`.

---

## Example: What the SDK Emits

A simplified sketch of what the instrumentation looks like inside the SDK:

```ts
import dc from 'node:diagnostics_channel';

const generateChannel = dc.tracingChannel('@google/genai:models.generateContent');
const generateStreamChannel = dc.tracingChannel('@google/genai:models.generateContentStream');

// Inside models.generateContent (non-streaming)
async function generateContent(params) {
  if (generateChannel.hasSubscribers === false) {
    return this._generateContent(params);
  }

  const context = { model: params.model, params };
  return generateChannel.tracePromise(() => this._generateContent(params), context);
}
```

Fewer than 15 lines per method. No Proxy, no constructor wrapping, no CJS re-export chasing, no stream accumulation logic pushed onto consumers.

---

## How APM Tools Use This

### Today: Constructor patching + client wrapping (~1,000 lines)

Taking Sentry as an example, their Google GenAI instrumentation uses IITM/RITM to intercept `require('@google/genai')`, replaces the `GoogleGenAI` constructor, and wraps the resulting client to intercept method calls. It also carries a second file-level patch for the nested `@google/genai/dist/node/index.cjs` re-export, because patching only the root module misses the real implementation. This spans **~1,000 lines across 7 files**:

- [node/.../google-genai/instrumentation.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/tracing/google-genai/instrumentation.ts) (98 lines): IITM/RITM module patching, constructor wrapping, the extra CJS re-export file patch
- [node/.../google-genai/index.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/tracing/google-genai/index.ts) (74 lines): integration setup
- [core/.../google-genai/index.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/tracing/google-genai/index.ts) (431 lines): client instrumentation, method interception, span lifecycle, request/response attribute extraction
- [core/.../google-genai/streaming.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/tracing/google-genai/streaming.ts) (132 lines): async generator wrapping, chunk accumulation, stream error handling
- [core/.../google-genai/types.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/tracing/google-genai/types.ts) (199 lines): type definitions for requests, responses, streaming
- [core/.../google-genai/utils.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/tracing/google-genai/utils.ts) (44 lines): content/message conversion helpers
- [core/.../google-genai/constants.ts](https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/tracing/google-genai/constants.ts) (19 lines): method registry mapping method paths to operation types

This approach has several problems:
- **Replaces the `GoogleGenAI` constructor**, wrapping every client instance even when no APM is listening
- **Chases the SDK's module shape.** The nested CJS re-export requires a second patch target; a packaging change upstream can silently break instrumentation
- **IITM/RITM dependency.** Only works on Node.js, not on the browsers, Deno, Bun, or edge runtimes the SDK also targets
- **Stream wrapping is fragile.** Each vendor independently wraps Google's async generators, accumulates chunks, and handles errors
- **Each APM vendor builds their own.** Sentry, Traceloop, Elastic, Datadog all independently replicate the same pattern

### With TracingChannel: Subscribe to Structured Events

```ts
import dc from 'node:diagnostics_channel';

dc.tracingChannel('@google/genai:models.generateContent').subscribe({
  start(ctx) {
    // ctx.model, ctx.params available
    ctx.span = tracer.startSpan(`generate_content ${ctx.model}`);
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
| **Setup** | IITM/RITM intercepts `require('@google/genai')` before first import | Subscribe to `diagnostics_channel` at any time. No ordering constraint |
| **Scope** | Replace constructor + wrap every client instance + patch nested CJS re-export | Per-operation channel subscriptions |
| **Method interception** | Wrap client methods, tracking the SDK's internal module/object shape | No wrapping. SDK emits events at execution time, subscribers observe |
| **Streaming** | Each vendor independently wraps async generators and accumulates chunks | SDK handles accumulation internally; subscribers see a single span with the final response |
| **Multi-vendor** | Each vendor builds their own patching + stream accumulation logic | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly remove a constructor replacement | `unsubscribe()`, clean and reversible |
| **Runtime support** | IITM/RITM: Node.js only. SDK runs in browsers, Deno, Bun, and edge too | Any runtime with `diagnostics_channel` |
| **Maintenance** | External packages must track SDK internals across regenerations | Native, maintained as part of the SDK |

---

## Implementation Notes

### Insertion Points

Each inference method is a natural insertion point, where the operation type, model, and parameters are known:

- `models.generateContent` / `models.generateContentStream`
- `models.embedContent`
- `Chat.sendMessage` / `Chat.sendMessageStream` (the model is read from the `Chat` instance)

The TracingChannel wraps the core execution, emitting events with the parameters and result. `ai.chats.create()` stays uninstrumented (no network work).

### Async Model

Non-streaming methods return Promises — `tracePromise` is the correct wrapper. Streaming methods return async generators and need manual lifecycle management so the span covers the full stream (see the Streaming section above).

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

### Zero-Cost Guarantee

Context objects should only be constructed inside a `hasSubscribers` guard:

```ts
if (shouldTrace(generateChannel)) {
  const context = { model: params.model, params };
  return generateChannel.tracePromise(fn, context);
} else {
  return fn();
}
```

When no APM subscribes, the overhead is a single boolean check per call.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before constructing any context objects. Silently skipped on runtimes where `TracingChannel` is unavailable.

Since `@google/genai` runs in Node.js, browsers, Deno, Bun, and edge runtimes, the cross-runtime loading pattern is needed:

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

**AI / ML:**
- **`ai`** (Vercel AI SDK): [vercel/ai#15660](https://github.com/vercel/ai/pull/15660) ✅ merged & released (v7.0.0), ships the `ai:telemetry` TracingChannel
- **`openai`**: [openai/openai-node#1819](https://github.com/openai/openai-node/issues/1819), issue opened
- **`@anthropic-ai/sdk`**: [anthropics/anthropic-sdk-typescript#1036](https://github.com/anthropics/anthropic-sdk-typescript/issues/1036), issue opened

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
- **`mongoose`**: [Automattic/mongoose#16275](https://github.com/Automattic/mongoose/pull/16275) ✅ merged & released (v9.7.0)
- **`pg` / `pg-pool`**: [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650), PR open
- **`knex`**: [knex/knex#6410](https://github.com/knex/knex/pull/6410), PR open
- **`mongodb`**: [NODE-7472](https://jira.mongodb.org/browse/NODE-7472), issue opened
- **`tedious`**: [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727), issue opened
- **`@prisma/client`**: [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353), issue opened

**Other:**
- **`graphql`**: [graphql/graphql-js#4670](https://github.com/graphql/graphql-js/pull/4670) ✅ merged & released (v17.0.0-rc.0)
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193), PR open

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
