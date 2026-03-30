# Elysia: `TracingChannel` Proposal

> **Status:** 💬 In discussion
> **Issue:** [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809)

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Elysia, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, and Elysia is **Bun-first**, making this especially relevant since its primary runtime has no support for these hooks at all.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

If Elysia emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Where TracingChannel Fits: Replacing the Foundation Under `.trace()` and `@elysiajs/opentelemetry`

Elysia currently maintains **three separate observability mechanisms**:

1. **`.trace()` API** (316 LOC in `trace.ts` + code-gen wiring in `compose.ts`): a built-in observation system using `Promise.withResolvers()` that hooks into every lifecycle phase with timing data (`begin`, `end`, `elapsed`, `error`). The implementation is deeply coupled to the code-generated request handler: `createReport()` in `compose.ts` injects `performance.now()` calls and resolver invocations directly into generated JavaScript strings.

2. **`.wrap()`**: a higher-order function that wraps Elysia's `fetch` handler, used by the OTel plugin to establish a root span and async context.

3. **`@elysiajs/opentelemetry`** (~900 LOC): a first-party plugin that uses _both_ `.wrap()` (for the root span) and `.trace({ as: 'global' })` (for per-phase child spans), with an `inspect()` helper that iterates over lifecycle hooks via `.onEvent()` and `.onStop()`.

This is a lot of machinery. The `.trace()` system alone requires maintaining a custom Promise-based streaming architecture, code-generated resolver wiring, and careful synchronization between `trace.ts` and `compose.ts`. Any new lifecycle event requires updating both files.

### Proposed Architecture: TracingChannel as the Foundation

Rather than adding TracingChannel as a **fourth** observability layer alongside these, we propose using it as the **foundation** that the existing APIs are rebuilt on top of:

```
TracingChannel (foundation)
  └── emits start/end/error per lifecycle phase and per hook
        │
        ├── .trace() rebuilt as a thin subscriber (~100 LOC)
        │     └── reconstructs current DX: onEvent(), onStop(), timing data
        │
        └── @elysiajs/opentelemetry subscribes directly (~50 LOC)
              └── creates OTel spans from TracingChannel events
```

**What this replaces:**

| Component | Current | With TracingChannel |
|---|---|---|
| `createProcess()` / `createReport()` in `trace.ts` | Custom Promise streaming with `withResolvers()` | Deleted. TracingChannel handles lifecycle events natively |
| Code-gen wiring in `compose.ts` | ~200 LOC of string-built `report`/`resolveChild` fragments | Replaced with `tracePromise()` calls at each lifecycle boundary |
| `.trace()` user-facing API | Powered by custom Promise architecture | Rebuilt as a TracingChannel subscriber that reconstructs the same DX |
| `@elysiajs/opentelemetry` | 900 LOC using `.wrap()` + `.trace()` + `inspect()` | ~50 LOC subscribing directly to TracingChannel |
| `.wrap()` | Manual HOF for root span context | Unnecessary. TracingChannel propagates async context automatically |

**What `.trace()` users see:** Nothing changes. The `.trace()` API continues to expose `onRequest`, `onBeforeHandle`, etc. with `onEvent()`, `onStop()`, timing data, and error access. The difference is entirely internal: instead of a custom Promise streaming system, it subscribes to TracingChannel events and reconstructs the same interface.

**What breaks:** One thing: `.trace()` currently allows **mutating the request context** from `onStop()` callbacks. TracingChannel subscribers are passive observers. This context mutation capability would need to either remain as custom code in the `.trace()` layer, or be reconsidered as a design decision (observability callbacks mutating request state is generally considered an anti-pattern).

### Why This Is Better for Elysia

From a maintainer perspective:

1. **Delete ~500 LOC of complex internals.** The `createProcess`/`createReport` Promise streaming system and the code-gen wiring in `compose.ts` are replaced by standard `tracePromise()` calls.
2. **Decouple observability from code generation.** Currently, any change to lifecycle ordering requires updating both `trace.ts` and `compose.ts`. With TracingChannel, the lifecycle hooks just call `tracePromise()` at each boundary. No string-building, no resolver synchronization.
3. **Simplify `@elysiajs/opentelemetry` from 900 LOC to ~50 LOC.** The plugin no longer needs `.wrap()` for context propagation or `.trace()` for lifecycle events. It subscribes to TracingChannel directly.
4. **Multi-vendor observability for free.** Any APM tool that understands `diagnostics_channel` can instrument Elysia without Elysia-specific code. Today only OTel is supported via the first-party plugin.
5. **Zero-cost when unused.** `hasSubscribers` gating means no overhead when no APM is listening, unlike the current `.trace()` system which always runs its Promise machinery.

---

## Proposed Tracing Channel

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `elysia:request` | Individual lifecycle hook and handler executions within the request | `lifecycle`, `type`, `name`, `event` |

A single channel with a `lifecycle` field (rather than separate channels per phase) because:

1. **It mirrors h3's pattern.** h3 uses one `h3.request` channel with `type: "middleware" | "route"` to distinguish executions.
2. **APMs subscribe once.** A single subscription captures the full request lifecycle tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **Elysia's lifecycle phases are a continuum.** Unlike database operations (query vs connect) which are semantically distinct, lifecycle phases are stages of the same request. One channel reflects this.

### Context Properties

The context object passed to each `tracePromise` call:

| Field | Source | Purpose |
|---|---|---|
| `lifecycle` | The lifecycle phase: `onRequest`, `onParse`, `onTransform`, `onBeforeHandle`, `handle`, `onAfterHandle`, `mapResponse`, `onAfterResponse`, `onError` | Identifies which phase is being traced. APMs use this as the span name (e.g., `"onBeforeHandle: authCheck"`) |
| `type` | `"hook"` or `"handler"` | Distinguishes lifecycle hooks from the main route handler. Mirrors h3's `"middleware"` / `"route"` pattern |
| `name` | Hook or handler function name (`fn.name`) | Identifies the specific function being executed (e.g., `"rateLimiter"`, `"getUser"`) |
| `event` | The Elysia context object | Carries the full request context: `request`, `set`, `store`, `params`, `query`, `route`, `headers`, etc. APMs extract HTTP attributes from this. |

### What APMs Extract from `event`

The `event` context object provides everything APMs need to construct HTTP semantic convention attributes:

| Extracted from `event` | OTel attribute it enables |
|---|---|
| `event.request.method` | `http.request.method` |
| `event.request.url` | `url.full`, `url.path`, `url.scheme` |
| `event.route` | `http.route` (e.g., `/users/:id`) |
| `event.request.headers` | W3C trace context propagation (`traceparent`, `tracestate`), `user_agent.original` |
| `event.params` | Application-level route parameters |
| `event.query` | `url.query` |
| `event.set.status` | `http.response.status_code` |
| `event.set.headers` | `http.response.header.*` |
| `event.store` | Application-level state |

### Error Handling

When a lifecycle hook or handler throws, TracingChannel's `error` sub-channel fires automatically with the error object. APMs can:
- Set span status to ERROR
- Record `error.type` (constructor name) and `error.stack`
- Resolve status code from the error (e.g., Elysia's `NotFoundError` -> 404)

The `onError` lifecycle phase is also traced as its own execution, so APMs see both the error event on the originating span and the error handler execution as a separate span.

---

## How APM Tools Use This

### Today: First-Party Plugin with `.wrap()` + `.trace()` (~900 LOC)

Elysia has no standard OTel instrumentation. Instead, the first-party `@elysiajs/opentelemetry` plugin uses Elysia's own APIs:

```ts
// Simplified from @elysiajs/opentelemetry (~900 LOC)

const app = new Elysia()
  // 1. .wrap() intercepts the entire request handler to create a root span
  //    and establish OTel async context for the full request lifecycle
  .wrap(async (next, ctx) => {
    const span = tracer.startSpan(`${ctx.request.method} ${ctx.route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': ctx.request.method,
        'http.route': ctx.route,
        'url.full': ctx.request.url,
      },
    });
    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await next(ctx);
        span.setAttribute('http.response.status_code', ctx.set.status);
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw err;
      }
    });
  })
  // 2. .trace({ as: 'global' }) creates child spans for EVERY lifecycle phase
  //    using an inspect() helper that iterates over hook functions
  .trace({ as: 'global' }, (ctx) => {
    inspect(ctx.onRequest, 'onRequest');
    inspect(ctx.onParse, 'onParse');
    inspect(ctx.onBeforeHandle, 'onBeforeHandle');
    inspect(ctx.handle, 'handle');
    inspect(ctx.onAfterHandle, 'onAfterHandle');
    inspect(ctx.onAfterResponse, 'onAfterResponse');
    inspect(ctx.onError, 'onError');
  });

// The inspect() helper (~100 LOC) iterates over each hook in a phase,
// creates a child span, and manually tracks begin/end/elapsed via
// .onEvent() and .onStop() callbacks.
function inspect(phase, name) {
  for (const fn of phase) {
    fn.onEvent(({ begin }) => {
      const span = tracer.startSpan(`${name}: ${fn.name}`);
      fn[SPAN_SYMBOL] = span;
    });
    fn.onStop(({ end, error }) => {
      const span = fn[SPAN_SYMBOL];
      if (error) span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.end();
    });
  }
}
```

This approach requires both `.wrap()` (for root span + async context) and `.trace()` (for per-phase child spans), with manual span storage via symbols and an `inspect()` helper that iterates over lifecycle hooks. It's tightly coupled to Elysia's `.trace()` internals and cannot work on any other framework.

### With TracingChannel: Subscribe to Structured Events

```ts
const dc = require('node:diagnostics_channel');

dc.tracingChannel('elysia:request').subscribe({
  start(ctx) {
    const tracer = trace.getTracer('elysia');
    const spanName = ctx.type === 'handler'
      ? `${ctx.event.request.method} ${ctx.event.route}`
      : `${ctx.lifecycle}: ${ctx.name}`;

    ctx.span = tracer.startSpan(spanName, {
      kind: ctx.type === 'handler' ? SpanKind.SERVER : SpanKind.INTERNAL,
      attributes: {
        'http.request.method': ctx.event.request.method,
        'http.route': ctx.event.route,
        'elysia.lifecycle': ctx.lifecycle,
      },
    });
    // TracingChannel automatically propagates this span as the active context.
    // Lifecycle phases nest naturally via async context, no manual .wrap() needed.
  },
  asyncEnd(ctx) {
    if (ctx.type === 'handler') {
      ctx.span?.setAttribute('http.response.status_code', ctx.event.set.status);
    }
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});
```

This replaces ~900 LOC of `.wrap()` + `.trace()` + `inspect()` + manual context threading with a single TracingChannel subscription.

**What changes for APM vendors:**

| Concern | `@elysiajs/opentelemetry` (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Must use Elysia-specific `.wrap()` + `.trace({ as: 'global' })` APIs | Subscribe to `diagnostics_channel`, a standard API |
| **Scope** | ~900 LOC plugin with `inspect()` helper iterating lifecycle hooks | Single channel subscription |
| **Context propagation** | Manual `context.with()` in `.wrap()` to establish root span context | Built-in. TracingChannel propagates `AsyncLocalStorage` context through lifecycle phases automatically |
| **Span nesting** | Must manually correlate root span (`.wrap()`) with child spans (`.trace()`) | Automatic. Each `tracePromise` call nests via async context |
| **Portability** | Elysia-only code, cannot be reused for h3, Express, Fastify | Standard pattern. Same subscriber shape works across any framework with TracingChannel |
| **Runtime support** | Works on Bun (Elysia-native) but not via standard OTel auto-instrumentation | Works on any runtime with `diagnostics_channel`, including Bun once it adds support |

---

## Implementation Notes

### Replacing the Code-Gen Trace Wiring

The key change is in `compose.ts`. Currently, `createReport()` generates JavaScript string fragments like:

```js
// Current code-gen output (simplified)
report0 = trace0.request({
  id, event: 'request', name: 'anonymous', begin: performance.now(), total: 0
})
// ... execute lifecycle hooks ...
report0.resolve()
```

With TracingChannel, this becomes direct `tracePromise()` calls:

```ts
// Replace code-gen with direct calls
if (shouldTrace(requestChannel)) {
  await requestChannel.tracePromise(
    hookFn,
    { lifecycle: 'onBeforeHandle', type: 'hook', name: hookFn.name || 'anonymous', event: ctx },
    ctx
  );
} else {
  await hookFn(ctx);
}
```

No string building, no `createProcess`, no `createReport`, no `resolveChild` wiring.

### Rebuilding `.trace()` as a Subscriber

The `.trace()` API can be preserved as a thin layer that subscribes to TracingChannel and reconstructs its current DX:

```ts
// .trace() becomes a subscriber factory (~100 LOC)
app.trace(handler) {
  dc.tracingChannel('elysia:request').subscribe({
    start(ctx) {
      // Build the onEvent/onStop/timing interface from TracingChannel events
      const process = {
        begin: performance.now(),
        onStop: (cb) => { /* stored, called on end/error */ },
      };
      // Call the user's handler with the familiar API shape
      handler[ctx.lifecycle]?.(process);
    },
    asyncEnd(ctx) { /* call stored onStop callbacks with elapsed */ },
    error(ctx) { /* call stored onStop callbacks with error */ },
  });
}
```

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before wrapping any hook or handler with `tracePromise`. Silently skipped on runtimes where `TracingChannel` is unavailable.

```ts
let requestChannel;
try {
  const dc = ('getBuiltinModule' in process)
    ? process.getBuiltinModule('node:diagnostics_channel')
    : require('node:diagnostics_channel');
  requestChannel = dc.tracingChannel('elysia:request');
} catch {
  // TracingChannel not available, no-op
}
```

Since Elysia is Bun-first: Bun has [initial `diagnostics_channel` support](https://bun.sh/docs/runtime/nodejs-apis) and is actively expanding it. TracingChannel support in Bun would unlock native instrumentation for Elysia's primary runtime, a significant advantage over the current approach which cannot work via standard auto-instrumentation on Bun at all.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`, traces middleware and route handlers with `type` field) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`hono`**: [honojs/hono#4842](https://github.com/honojs/hono/issues/4842) (`hono:request`, traces middleware and handlers with `type` field)
- **`koa`**: proposal drafted (`koa:request`, traces middleware and router handlers with `type` field)

**Databases:**
- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`node-redis`**: [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`), approved, pending merge
- **`ioredis`**: [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)
- **`pg` / `pg-pool`**: [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)
- **`knex`**: [knex/knex#6410](https://github.com/knex/knex/pull/6410) (`knex:query`, `knex:transaction`, `knex:pool:acquire`)
- **`mongodb`**: [NODE-7472](https://jira.mongodb.org/browse/NODE-7472), proposal under discussion
- **`mongoose`**: [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105), issue opened
- **`tedious`**: [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727), issue opened
- **`@prisma/client`**: [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353), issue opened

**Other:**
- **`graphql`**: [graphql/graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629), issue opened
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193)

---

## Runtime Compatibility

TracingChannel is available on all runtimes Elysia targets. No fallbacks are needed in `.trace()`.

| Runtime | Elysia min version | TracingChannel available? | Notes |
|---|---|---|---|
| **Node.js** | >= 20.16.0 (via srvx) | Yes | Available since 18.19.0. Well above the floor. |
| **Deno** | Not specified | Yes | Documented as fully compatible with `node:diagnostics_channel` including `TracingChannel`. |
| **Bun** | >= 1.2.0 | Yes, with a known quirk | `TracingChannel` exists but `hasSubscribers` is `undefined` ([oven-sh/bun#27805](https://github.com/oven-sh/bun/issues/27805)). Fix is in progress. |

The Bun quirk is the same issue Node 18 had, and the `shouldTrace` helper already handles it:

```ts
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

When `hasSubscribers` is `undefined` (Bun today), this evaluates to `true`, meaning tracing runs even when no subscriber is attached. This is a small overhead, not a correctness issue. Once Bun ships the fix, `hasSubscribers` will return `false` when nobody is listening, and the zero-cost guarantee kicks in automatically. No code changes needed on Elysia's side.

This means `.trace()` rebuilt on TracingChannel would work correctly on Bun, Node, and Deno from day one, with zero-cost optimization arriving on Bun as a free upgrade.

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
