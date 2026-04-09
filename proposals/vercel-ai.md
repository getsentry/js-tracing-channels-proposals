# ai (Vercel AI SDK): `TracingChannel` Proposal

> **Issue:** TBD
> **Status:** 📝 Proposal drafted

---

I'd like to propose adding [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to the Vercel AI SDK as the native observability primitive, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted across the npm ecosystem.

The AI SDK already has excellent built-in telemetry via `@opentelemetry/api`. This proposal isn't about adding observability from scratch. It's about fixing how that observability gets activated and making it work reliably across all runtimes.

### The problem today

The SDK's telemetry requires per-call opt-in:

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello',
  experimental_telemetry: { isEnabled: true }, // required on every call
});
```

APM tools like Sentry work around this by using IITM (import-in-the-middle) to intercept `require('ai')` and auto-enable telemetry on every call. This has several problems:

- **Runtime lock-in:** IITM relies on Node.js-specific module loader internals. It doesn't work on Cloudflare Workers, Deno, or Bun. The AI SDK is designed to run on **all of these runtimes**, making IITM especially inadequate.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** IITM requires instrumentation to be set up before the SDK is first imported. Get the order wrong and instrumentation silently does nothing.
- **Bundling and Externalization:** Users have to ensure `ai` is externalized from their bundle, which is increasingly difficult with frameworks that bundle server-side code.

The result: on Cloudflare Workers, users must manually add `experimental_telemetry: { isEnabled: true }` to every AI call. Forget one and that call is invisible to your APM. Sentry maintains [two completely separate integration paths](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/cloudflare/src/integrations/tracing/vercelai.ts) for Node vs Cloudflare because of this.

### What TracingChannel changes

With `diagnostics_channel`, the SDK emits structured lifecycle events automatically, gated by `hasSubscribers` (zero cost when nobody is listening). APM tools become subscribers, not patches. No IITM, no per-call opt-in, no per-runtime code paths.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `ai:generate` | Text and object generation (`generateText`, `streamText`, `generateObject`, `streamObject`), from request to full response or stream completion | `method`, `model`, `stream`, `params` |
| `ai:embed` | Embedding generation (`embed`, `embedMany`) | `method`, `model`, `params` |

Two channels because generation and embedding have fundamentally different context shapes and OTel semantic convention mappings. A `method` discriminator on each channel distinguishes the specific function called.

### `ai:generate` Context Properties

| Field | Source | OTel attribute it enables |
|---|---|---|
| `method` | Function name: `'generateText'`, `'streamText'`, `'generateObject'`, `'streamObject'` | Distinguishes streaming from non-streaming, text from structured output |
| `model` | `params.model` (the provider model instance) | `gen_ai.request.model` (via `model.modelId`) |
| `stream` | `true` for `streamText`/`streamObject` | Signals that the span covers the full streaming lifecycle |
| `params` | Raw function parameters | APMs extract: `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.max_tokens`, `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.request.available_tools` |
| `result` | Raw result (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.text`, `gen_ai.response.tool_calls` |

### `ai:embed` Context Properties

| Field | Source | OTel attribute it enables |
|---|---|---|
| `method` | `'embed'` or `'embedMany'` | Distinguishes single vs batch embedding |
| `model` | `params.model` (the provider embedding model) | `gen_ai.request.model` |
| `params` | Raw function parameters | APMs extract: `gen_ai.embeddings.input` |
| `result` | Raw result (auto-set by TracingChannel on completion) | APMs extract: `gen_ai.usage.input_tokens`, `gen_ai.usage.total_tokens` |

### Why Raw Params and Response

The context passes raw `params` and the auto-set `result` rather than pre-extracting individual attributes. This follows the same pattern used in framework TracingChannel proposals (h3, Hono, Elysia):

1. **Forward-compatible.** New parameters and response fields are automatically available to subscribers without SDK changes.
2. **Provider-agnostic.** The AI SDK wraps multiple providers (OpenAI, Anthropic, Google, etc.). Each provider may return different metadata. Passing the raw result lets APMs extract provider-specific fields.
3. **Privacy is the subscriber's concern.** The SDK emits what it has. APMs decide what to record.

---

## Streaming

For non-streaming calls (`generateText`, `generateObject`), `tracePromise` wraps the full operation: `start` fires before the request, `asyncEnd` fires when the response resolves.

For streaming calls (`streamText`, `streamObject`), the TracingChannel lifecycle covers the full duration from request initiation to stream completion. The `result` is populated with the final accumulated data (token usage, finish reasons, generated text) when the stream ends.

---

## Where TracingChannel Fits: Relationship to `experimental_telemetry`

The SDK currently ships its own telemetry via direct `@opentelemetry/api` usage. TracingChannel complements this by providing a lower-level primitive:

| Concern | `experimental_telemetry` (current) | TracingChannel (proposed) |
|---|---|---|
| **Activation** | Per-call opt-in, or IITM auto-enable (Node only) | Automatic. Subscribers attach externally, zero user code changes |
| **Runtime support** | IITM auto-enable: Node only. Manual: all runtimes | Any runtime with `diagnostics_channel` (Node, Cloudflare Workers, Deno, Bun) |
| **Dependencies** | Requires `@opentelemetry/api` | Built into the runtime, zero deps |
| **Multi-vendor** | OTel-only (other APMs build adapters) | Any `diagnostics_channel` subscriber |
| **Span hierarchy** | SDK manages parent/child spans internally | Subscribers control their own span hierarchy |
| **Zero-cost** | Opt-in, so disabled calls have no cost | `hasSubscribers` gating, zero cost when no APM subscribes |

Both can coexist. `experimental_telemetry` continues to serve users who want OTel-native spans with the SDK managing the span hierarchy. TracingChannel serves APM vendors who want raw lifecycle events without IITM or per-call opt-in.

---

## How APM Tools Use This

### Today: IITM + Span Processors (~2,400 lines)

Taking Sentry as an example, their Vercel AI instrumentation uses IITM to auto-enable telemetry and adds span processors to normalize the SDK's OTel spans. This spans **~2,400 lines across 10 files**, split across two separate runtime targets:

**Node (IITM patching):**
- [instrumentation.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/node/src/integrations/tracing/vercelai/instrumentation.ts) (304 lines): patches 7 functions via IITM to auto-enable telemetry
- [index.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/node/src/integrations/tracing/vercelai/index.ts) (78 lines): integration setup and processor registration

**Cloudflare (no patching possible):**
- [vercelai.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/cloudflare/src/integrations/tracing/vercelai.ts) (51 lines): stripped-down version that can only add processors, cannot auto-enable telemetry

**Core (span post-processing, shared):**
- [index.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/vercel-ai/index.ts) (534 lines): span start listener + event processor for attribute normalization
- [utils.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/vercel-ai/utils.ts) (313 lines): token accumulation, message parsing, tool description extraction
- [vercel-ai-attributes.ts](https://github.com/getsentry/sentry-javascript/blob/7c193254674cebba2b6241cc0abd94b60c4a0235/packages/core/src/tracing/vercel-ai/vercel-ai-attributes.ts) (1,051 lines): attribute constants for all telemetry fields

The Node integration exists primarily to flip `isEnabled: true` on every call. 304 lines of IITM patching to set a boolean.

### With TracingChannel: Subscribe to Structured Events

```ts
import dc from 'node:diagnostics_channel';

dc.tracingChannel('ai:generate').subscribe({
  start(ctx) {
    // ctx.method, ctx.model, ctx.stream, ctx.params available
    ctx.span = tracer.startSpan(`${ctx.method} ${ctx.model.modelId}`);
  },
  asyncEnd(ctx) {
    // ctx.result is auto-set by TracingChannel with the function result
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.recordException(ctx.error);
  },
});
```

**What changes for APM vendors:**

| Concern | IITM + span processors (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | IITM intercepts `require('ai')` before first import, patches 7 functions | Subscribe to `diagnostics_channel` at any time. No ordering constraint |
| **Auto-enablement** | 304 lines of IITM code to flip `isEnabled: true` | Not needed. Events emit when subscribers exist |
| **Runtime parity** | Two separate integrations: Node (IITM) and Cloudflare (manual only) | One subscription works identically everywhere |
| **Span processing** | Post-process SDK's OTel spans to normalize 50+ attributes | Subscribe to raw events, build spans directly |
| **Teardown** | Cannot cleanly remove IITM patches | `unsubscribe()`, clean and reversible |

---

## Example: What the SDK Emits

A simplified sketch of what the instrumentation looks like inside the SDK:

```ts
import dc from 'node:diagnostics_channel';

const generateChannel = dc.tracingChannel('ai:generate');

// Inside generateText / streamText / generateObject / streamObject
async function generateText(params) {
  if (generateChannel.start.hasSubscribers === false) {
    return this._generate(params);
  }

  const context = { method: 'generateText', model: params.model, stream: false, params };
  return generateChannel.tracePromise(() => this._generate(params), context);
}
```

Fewer than 15 lines per function. No IITM, no Proxy, no span processors, no per-runtime code paths.

---

## Implementation Notes

### Insertion Points

Each top-level function (`generateText`, `streamText`, `generateObject`, `streamObject`, `embed`, `embedMany`) is a natural insertion point. The TracingChannel wraps the core execution, emitting events with the function parameters and result.

### Coexistence with `experimental_telemetry`

TracingChannel and `experimental_telemetry` can coexist:
- `experimental_telemetry` continues to create OTel spans for users who want the SDK's built-in span hierarchy
- TracingChannel emits lifecycle events for APM vendors who want to build their own spans
- Over time, `experimental_telemetry` could be re-implemented on top of TracingChannel internally, simplifying the SDK's telemetry architecture

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

### Zero-Cost Guarantee

Context objects should only be constructed inside a `hasSubscribers` guard. When no APM subscribes, the overhead is a single boolean check per call.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before constructing any context objects. Silently skipped on runtimes where `TracingChannel` is unavailable.

Since the AI SDK supports Node.js, Cloudflare Workers, Deno, and Bun, the cross-runtime loading pattern is needed:

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

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**AI / ML:**
- **`openai`**: [openai/openai-node#1819](https://github.com/openai/openai-node/issues/1819), issue opened

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

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
