# Koa: `TracingChannel` Proposal

> **Status:** Draft — awaiting issue creation

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Koa, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly — the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

Additionally, **`@opentelemetry/instrumentation-koa` is currently marked as "Unmaintained"** in the OpenTelemetry JS contrib repository. The existing monkey-patching instrumentation is not being actively maintained, which means Koa users relying on OTel for observability are in a precarious position. Native TracingChannel support would give OTel (and all other APM tools) a stable, first-party surface to subscribe to without needing external monkey-patching instrumentation.

If Koa emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Tracing Channel

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `koa:request` | Individual middleware and route handler executions within the request | `type`, `name`, `ctx` |

A single channel with a `type` field (rather than separate channels per middleware) because:

1. **It mirrors h3's and Elysia's pattern** — h3 uses one `h3.request` channel with `type: "middleware" | "route"`. Elysia uses one `elysia:request` channel with `lifecycle` and `type` fields. Consistency across frameworks means APM tools can share subscriber logic.
2. **APMs subscribe once** — a single subscription captures the full request middleware tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **Koa's middleware cascade is a continuum** — unlike database operations (query vs connect) which are semantically distinct, middleware functions are stages of the same request. One channel reflects this.

### Context Properties

The context object passed to each `tracePromise` call:

| Field | Source | Purpose |
|---|---|---|
| `type` | `"middleware"` or `"router"` | Distinguishes regular middleware from router-matched handlers — mirrors h3's `"middleware"` / `"route"` and OTel Koa's `KoaLayerType` enum |
| `name` | `fn.name` (middleware function name) or route path for router middleware | Identifies the specific function being executed (e.g., `"bodyParser"`, `"GET /users/:id"`) |
| `ctx` | The Koa context object | Carries the full request context. APMs extract HTTP attributes from this. |

### What APMs extract from `ctx`

The Koa context object provides everything APMs need to construct HTTP semantic convention attributes:

| Extracted from `ctx` | OTel attribute it enables |
|---|---|
| `ctx.method` | `http.request.method` |
| `ctx.url` / `ctx.originalUrl` | `url.full`, `url.path` |
| `ctx.request.headers` | W3C trace context propagation (`traceparent`, `tracestate`), `user_agent.original` |
| `ctx.status` | `http.response.status_code` |
| `ctx.response.headers` | `http.response.header.*` |
| `ctx.state` | Application-level state |
| `ctx._matchedRoute` | `http.route` (set by `@koa/router`, e.g., `/users/:id`) |
| `ctx.params` | Route parameters (from `@koa/router`) |
| `ctx.query` | `url.query` |
| `ctx.ip` | `client.address` |
| `ctx.host` | `server.address` |

### Error Handling

When a middleware throws, TracingChannel's `error` sub-channel fires automatically with the error object. APMs can:
- Set span status to ERROR
- Record `error.type` (constructor name) and `error.stack`
- Resolve status code from the error or from `ctx.status`

Koa's built-in error handling (`app.on('error')`) continues to work unchanged — TracingChannel observes errors as they propagate through the middleware stack, before Koa's own error handler runs.

---

## How APM Tools Use This

### Today: Monkey-Patching `koa.prototype.use` + Router Dispatch

`@opentelemetry/instrumentation-koa` patches Koa at three levels:

```js
// Simplified from @opentelemetry/instrumentation-koa

// 1. Patch koa.prototype.use — intercept all middleware registration
shimmer.wrap(koa.prototype, 'use', original => function patchedUse(middleware) {
  // Check if middleware has .router property → it's router middleware
  if (middleware.router) {
    return original.call(this, patchRouterDispatch(middleware));
  }
  return original.call(this, patchLayer(middleware, 'middleware'));
});

// 2. Patch router dispatch — iterate through @koa/router's stack
//    to patch each matched route handler individually
function patchRouterDispatch(routerMiddleware) {
  return async function(ctx, next) {
    // After router runs, iterate its matched layers
    for (const layer of ctx.router?.stack || []) {
      for (const handler of layer.stack) {
        if (!handler[kLayerPatched]) {
          patchLayer(handler, 'router', layer.path);
        }
      }
    }
    return routerMiddleware(ctx, next);
  };
}

// 3. Wrap each middleware as an async function with span creation
function patchLayer(middlewareFn, layerType, path) {
  const patched = async function(ctx, next) {
    // Only create span if parent span exists
    const parentSpan = trace.getSpan(context.active());
    if (!parentSpan) return middlewareFn(ctx, next);

    const spanName = layerType === 'router'
      ? `router - ${path}`
      : `middleware - ${middlewareFn.name || 'anonymous'}`;

    const span = tracer.startSpan(spanName, {
      attributes: {
        'koa.type': layerType,
        'koa.name': middlewareFn.name || path,
      },
    });

    // Execute requestHook if configured
    if (config.requestHook) {
      config.requestHook(span, { context: ctx, middlewareLayer: middlewareFn, layerType });
    }

    // Update RPC metadata for route tracking
    if (layerType === 'router') {
      rpcMetadata.route = path;
      span.setAttribute('http.route', path);
    }

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        return await middlewareFn(ctx, next);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
  patched[kLayerPatched] = true;
  return patched;
}
```

This approach has several problems:
- **Wraps every middleware at registration time** — even middleware that never matches the current request gets a patched wrapper
- **Symbol-based deduplication** — uses `kLayerPatched` symbol to avoid double-wrapping, which is fragile across module instances
- **Router detection heuristic** — relies on the middleware function having a `.router` property, which couples to `@koa/router`'s internal implementation
- **Orphan span prevention** — must check for parent span existence to avoid creating disconnected traces, adding branching logic to every middleware invocation

### With TracingChannel: Subscribe to Structured Events

```js
const dc = require('node:diagnostics_channel');

dc.tracingChannel('koa:request').subscribe({
  start(ctx) {
    const spanName = ctx.type === 'router'
      ? `router - ${ctx.name}`
      : `middleware - ${ctx.name}`;

    ctx.span = tracer.startSpan(spanName, {
      kind: ctx.type === 'router' ? SpanKind.SERVER : SpanKind.INTERNAL,
      attributes: {
        'koa.type': ctx.type,
        'koa.name': ctx.name,
        'http.request.method': ctx.ctx.method,
        ...(ctx.type === 'router' && { 'http.route': ctx.ctx._matchedRoute }),
      },
    });
    // TracingChannel automatically propagates this span as the active context —
    // middleware cascade nests naturally via async context, no manual wrapping needed
  },
  asyncEnd(ctx) {
    if (ctx.type === 'router') {
      ctx.span?.setAttribute('http.response.status_code', ctx.ctx.status);
    }
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});
```

**What changes for APM vendors:**

| Concern | Monkey-patching (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Must intercept module load via IITM/RITM before `require('koa')` | Subscribe to `diagnostics_channel` at any time — no ordering constraint |
| **Scope** | Patch `koa.prototype.use`, iterate router stacks, wrap each middleware | Single channel subscription |
| **Middleware wrapping** | Every middleware gets a shimmer wrapper at registration time | No wrapping — Koa emits events, subscribers observe |
| **Multi-vendor** | Stacked middleware wrappers call each other (Sentry wrapping Datadog wrapping OTel) | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly unwrap shimmer patches once applied | `unsubscribe()` — clean, reversible |
| **Router coupling** | Relies on `middleware.router` property existing on `@koa/router` internals | Koa/router emits `type: "router"` — subscribers don't need to know how routing works |
| **Runtime support** | Node.js only (IITM/RITM don't work on Bun/Deno) | Any runtime with `diagnostics_channel` support |
| **Maintenance** | `@opentelemetry/instrumentation-koa` is currently **Unmaintained** | Native — maintained as part of Koa itself |

---

## Implementation Notes

### Insertion Points

Koa's middleware cascade makes TracingChannel integration straightforward. The key insertion point is in the middleware dispatch loop.

**Koa core** — wrap each middleware execution in the compose/dispatch function:

```js
// In koa-compose or Koa's internal dispatch
function dispatch(i) {
  const fn = middleware[i];
  // ...
  if (shouldTrace(requestChannel)) {
    return requestChannel.tracePromise(
      fn,                                    // the async middleware function
      { type: 'middleware', name: fn.name || 'anonymous', ctx },
      ctx,                                   // first arg to fn
      () => dispatch(i + 1)                  // next()
    );
  }
  return fn(ctx, () => dispatch(i + 1));
}
```

**`@koa/router`** — when a route matches, emit with `type: "router"` and the matched route path as `name`:

```js
// In @koa/router's layer dispatch
if (shouldTrace(requestChannel)) {
  return requestChannel.tracePromise(
    handler,
    { type: 'router', name: `${ctx.method} ${layer.path}`, ctx },
    ctx,
    next
  );
}
```

### Async Context Propagation

Koa's async/await cascade model is a natural fit for `tracePromise`. Each middleware call returns a Promise, and `tracePromise` wraps it to fire `start` before execution, `asyncEnd` when the Promise resolves, and `error` if it rejects.

The cascade pattern means middleware spans nest automatically:

```
middleware - bodyParser        (start → asyncEnd)
  middleware - authCheck       (start → asyncEnd)
    router - GET /users/:id   (start → asyncEnd)
  middleware - authCheck       (asyncEnd fires after downstream completes)
middleware - bodyParser        (asyncEnd fires last)
```

This gives APM tools the same waterfall view they get today with shimmer wrapping, but through a standard API.

### Relationship to `@koa/router`

Koa core and `@koa/router` are separate packages. Two implementation approaches:

1. **Koa core only** — trace all middleware via `koa:request` with `type: "middleware"`. Router middleware appears as just another middleware entry. This is the minimal viable implementation.

2. **Koa core + router** — `@koa/router` additionally emits `koa:request` with `type: "router"` and route-specific metadata (`ctx._matchedRoute`, `ctx.params`). This gives APMs the route path for span naming.

Both approaches use the same `koa:request` channel. Option 2 is recommended since route information is what APMs value most, but it can be done as a follow-up PR to `@koa/router`.

### shouldTrace Helper

```js
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

---

## Backward Compatibility

Zero-cost when no subscribers are registered — `hasSubscribers` is checked before wrapping any middleware with `tracePromise`. Silently skipped on runtimes where `TracingChannel` is unavailable.

```ts
let requestChannel;
try {
  const dc = ('getBuiltinModule' in process)
    ? process.getBuiltinModule('node:diagnostics_channel')
    : require('node:diagnostics_channel');
  requestChannel = dc.tracingChannel('koa:request');
} catch {
  // TracingChannel not available — no-op
}
```

Koa requires Node.js v18+, which has `TracingChannel` available (albeit with the `hasSubscribers` quirk). The `try/catch` wrapper provides safety for alternative runtimes that may not yet support `diagnostics_channel`.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core) — ships `TracingChannel` support since Node 20.12: [`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels)
- **`fastify`** — ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`** — [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request` — traces middleware and route handlers with `type` field) ✅ merged
- **`srvx`** — [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`elysia`** — [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809) (`elysia:request` — traces lifecycle phases with discriminator field)

**Databases:**
- **`mysql2`** — [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`node-redis`** — [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`) — approved, pending merge
- **`ioredis`** — [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)
- **`pg` / `pg-pool`** — [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)
- **`mongodb`** — [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) — proposal under discussion
- **`mongoose`** — [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) — issue opened
- **`knex`** — [knex/knex#6394](https://github.com/knex/knex/issues/6394) — issue opened
- **`tedious`** — [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727) — issue opened
- **`@prisma/client`** — [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353) — issue opened

**Other:**
- **`graphql`** — [graphql/graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629) — issue opened
- **`unstorage`** — [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`** — [unjs/db0#193](https://github.com/unjs/db0/pull/193)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
