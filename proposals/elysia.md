# Elysia: `TracingChannel` Proposal

> **Status:** Draft — awaiting issue creation

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Elysia, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251) and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly — the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno — and Elysia is **Bun-first**, making this especially relevant since its primary runtime has no support for these hooks at all.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

If Elysia emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Where TracingChannel Fits: Relationship to `.trace()` and `@elysiajs/opentelemetry`

Elysia already has two observability mechanisms:

1. **`.trace()` API** — a built-in observation mechanism that hooks into every lifecycle phase (onRequest, onParse, onTransform, onBeforeHandle, handle, onAfterHandle, mapResponse, onError, onAfterResponse) with timing data (`begin`, `end`, `elapsed`, `error`). This is read-only and Elysia-specific.

2. **`@elysiajs/opentelemetry`** — a first-party plugin (~900 LOC) that creates OTel spans. It uses two mechanisms:
   - `.wrap()` to create a root `SpanKind.SERVER` span and establish OTel async context for the entire request
   - `.trace({ as: 'global' })` to create child spans for each lifecycle phase

We evaluated three architectural options for where `TracingChannel` should sit relative to these:

| Option | Approach | Verdict |
|---|---|---|
| **A: TracingChannel powers `.trace()`** | Rebuild `.trace()` as a TracingChannel subscriber | ❌ Forced fit — `.trace()` has user-facing semantics (`.onEvent()`, `.onStop()`, timing data) that don't map to TracingChannel's start/asyncEnd model |
| **B: `.trace()` triggers TracingChannel** | Emit TracingChannel events from inside `.trace()` callbacks | ❌ Fragile — couples TracingChannel to `.trace()` internals, only works if `.trace()` is wired up |
| **C: Tandem with lifecycle tracing** | TracingChannel emits independently in the core request path, tracing both the full request and individual lifecycle hook executions | ✅ Standard, portable, and complete |

### Recommended architecture (Option C):

TracingChannel traces each lifecycle hook execution individually using a single `elysia:request` channel with a `lifecycle` field — the same pattern h3 uses with its `type: "middleware" | "route"` field. Each `tracePromise` call creates its own start/asyncEnd pair, and they nest naturally via async context propagation:

```
Request arrives
  tracePromise({ lifecycle: 'onRequest', type: 'hook', name: 'rateLimiter' })
    tracePromise({ lifecycle: 'onParse', type: 'hook', name: 'jsonParser' })
      tracePromise({ lifecycle: 'onBeforeHandle', type: 'hook', name: 'authCheck' })
        tracePromise({ lifecycle: 'handle', type: 'handler', name: 'getUser' })
      tracePromise({ lifecycle: 'onAfterHandle', type: 'hook', name: 'addCors' })
        tracePromise({ lifecycle: 'onAfterResponse', type: 'hook', name: 'logger' })
```

**Why this is the right approach:**

- **Full lifecycle visibility via a standard API** — APMs get per-phase spans without needing Elysia-specific `.trace()` or `.wrap()` code. Any tool that understands `diagnostics_channel` can instrument Elysia.
- **Follows established framework precedent** — h3 uses a single `h3.request` channel and calls `tracePromise` per middleware and per route handler. Elysia extends this to its richer lifecycle.
- **`.trace()` remains unchanged** — it continues to serve its purpose as Elysia's user-facing observability API with timing data, function iteration, and stop callbacks. TracingChannel is the lower-level primitive that APMs subscribe to.
- **The OTel plugin can be fully rebuilt on TracingChannel** — both `.wrap()` (root span) and `.trace({ as: 'global' })` (child spans) can be replaced by TracingChannel subscriptions, dramatically simplifying the plugin.

---

## Proposed Tracing Channel

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `elysia:request` | Individual lifecycle hook and handler executions within the request | `lifecycle`, `type`, `name`, `event` |

A single channel with a `lifecycle` field (rather than separate channels per phase) because:

1. **It mirrors h3's pattern** — h3 uses one `h3.request` channel with `type: "middleware" | "route"` to distinguish executions
2. **APMs subscribe once** — a single subscription captures the full request lifecycle tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **Elysia's lifecycle phases are a continuum** — unlike database operations (query vs connect) which are semantically distinct, lifecycle phases are stages of the same request. One channel reflects this.

### Context Properties

The context object passed to each `tracePromise` call:

| Field | Source | Purpose |
|---|---|---|
| `lifecycle` | The lifecycle phase: `onRequest`, `onParse`, `onTransform`, `onBeforeHandle`, `handle`, `onAfterHandle`, `mapResponse`, `onAfterResponse`, `onError` | Identifies which phase is being traced — APMs use this as the span name (e.g., `"onBeforeHandle: authCheck"`) |
| `type` | `"hook"` or `"handler"` | Distinguishes lifecycle hooks from the main route handler — mirrors h3's `"middleware"` / `"route"` pattern |
| `name` | Hook or handler function name (`fn.name`) | Identifies the specific function being executed (e.g., `"rateLimiter"`, `"getUser"`) |
| `event` | The Elysia context object | Carries the full request context: `request`, `set`, `store`, `params`, `query`, `route`, `headers`, etc. APMs extract HTTP attributes from this. |

### What APMs extract from `event`

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
- Resolve status code from the error (e.g., Elysia's `NotFoundError` → 404)

The `onError` lifecycle phase is also traced as its own execution, so APMs see both the error event on the originating span and the error handler execution as a separate span.

---

## How `@elysiajs/opentelemetry` Would Migrate

The first-party OTel plugin currently uses two mechanisms:

```
Current:
  .wrap()                    → Root span + async context propagation
  .trace({ as: 'global' })  → Lifecycle child spans (via inspect() helper)

After TracingChannel:
  subscribe('elysia:request') → Root span, lifecycle child spans, async context
                                 — all from a single subscription
```

The subscriber creates spans based on the context fields:

```ts
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

channel.subscribe({
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
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
  asyncEnd(ctx) {
    if (ctx.type === 'handler') {
      ctx.span?.setAttribute('http.response.status_code', ctx.event.set.status);
    }
    ctx.span?.end();
  },
});
```

This replaces ~900 LOC of `.wrap()` + `.trace()` + `inspect()` + manual context threading with a single TracingChannel subscription. The plugin becomes dramatically simpler while gaining standard async context propagation for free.

---

## Backward Compatibility

Zero-cost when no subscribers are registered — `hasSubscribers` is checked before wrapping any hook or handler with `tracePromise`. Silently skipped on runtimes where `TracingChannel` is unavailable.

```ts
let requestChannel;
try {
  const dc = ('getBuiltinModule' in process)
    ? process.getBuiltinModule('node:diagnostics_channel')
    : require('node:diagnostics_channel');
  requestChannel = dc.tracingChannel('elysia:request');
} catch {
  // TracingChannel not available — no-op
}
```

Since Elysia is Bun-first: Bun has [initial `diagnostics_channel` support](https://bun.sh/docs/runtime/nodejs-apis) and is actively expanding it. TracingChannel support in Bun would unlock native instrumentation for Elysia's primary runtime — a significant advantage over the current monkey-patching approach which cannot work on Bun at all.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core) — ships `TracingChannel` support since Node 20.12: [`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels)
- **`h3`** — [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request` — traces middleware and route handlers individually with `type` field) ✅ merged
- **`srvx`** — [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged

**Databases:**
- **`mysql2`** — [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`node-redis`** — [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`)
- **`ioredis`** — [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)
- **`pg` / `pg-pool`** — [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)

**Storage:**
- **`unstorage`** — [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`** — [unjs/db0#193](https://github.com/unjs/db0/pull/193)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
