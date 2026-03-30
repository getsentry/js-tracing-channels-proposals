# Hono: `TracingChannel` Proposal

> **Issue:** [honojs/hono#4842](https://github.com/honojs/hono/issues/4842)
> **Status:** 💬 Issue opened

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Hono, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun, Deno, or Cloudflare Workers. Hono is designed to run on **all of these runtimes**, making monkey-patching especially inadequate.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

The current instrumentation landscape for Hono illustrates this problem well. There is no `@opentelemetry/instrumentation-hono`. Instead, APM vendors have independently built their own solutions:

- **Sentry's classic integration** (`@sentry/node`) uses IITM to intercept `require('hono')`, replaces the `Hono` constructor with a subclass, and wraps **9 methods** (`.get`, `.post`, `.put`, `.delete`, `.options`, `.patch`, `.all`, `.on`, `.use`) on every instance, all to create per-handler spans. **This only works on Node.js.** IITM cannot intercept module imports on Cloudflare Workers, Bun, or Deno at all.
- **Sentry's new `@sentry/hono`** (alpha) abandons IITM entirely because of this. Instead, it requires users to add a middleware and uses a `Proxy` on `app.use` to intercept middleware registration. On Cloudflare Workers specifically, it wraps the entire app as an `ExportedHandler` via `withSentry()` and then Proxies `app.use`, a creative workaround for the fact that module-level patching is impossible on Workers. But this still requires user code changes, vendor-specific setup, and two completely different code paths for Node vs Cloudflare.
- **`@hono/otel`** is the official OTel middleware. It also requires explicit `app.use()` and only creates a single root span with no per-middleware breakdown.

The Sentry case is particularly instructive: a single APM vendor had to build **two completely separate instrumentation approaches** for the same framework: one for Node.js (IITM-based) and one for Cloudflare Workers (Proxy + middleware-based). It explicitly filters out the Node integration when running on Workers to avoid double-instrumentation. This is the kind of complexity that native TracingChannel support eliminates entirely.

With TracingChannel, a single `diagnostics_channel` subscription works identically across Node.js, Cloudflare Workers, and any other runtime that supports the API. No IITM, no Proxy hacks, no per-runtime code paths, no user code changes.

If Hono emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Where TracingChannel Fits: Relationship to `@hono/otel` and Built-in Middleware

Hono has two existing observability mechanisms:

1. **`hono/timing`**: a middleware that adds `Server-Timing` headers with `setMetric`, `startTime`, `endTime`. Useful for browser DevTools but not for APM/distributed tracing.

2. **`@hono/otel`**: the official OTel middleware in `honojs/middleware`. It uses `@opentelemetry/api` directly (`tracer.startActiveSpan()`) to create a root server span and record request metrics. It is a standard Hono middleware, not framework-level instrumentation.

Neither mechanism provides what TracingChannel adds:

| Concern | `hono/timing` | `@hono/otel` | TracingChannel (proposed) |
|---|---|---|---|
| **Activation** | User must add middleware | User must add middleware | Automatic; subscribers attach externally |
| **Scope** | Timing metrics only | Root request span + metrics | Per-middleware and per-handler spans with full async lifecycle |
| **Async context** | N/A | Manual `context.with()` in middleware | Built-in. TracingChannel propagates `AsyncLocalStorage` context through the middleware cascade |
| **Multi-vendor** | N/A | OTel-only | Any `diagnostics_channel` subscriber (OTel, Datadog, Sentry, custom) |
| **Middleware visibility** | Only what user explicitly measures | Single root span, no per-middleware breakdown | Each middleware and handler traced individually |

TracingChannel complements both. `hono/timing` continues to serve its purpose for HTTP header-based timing, and `@hono/otel` can be simplified to a thin TracingChannel subscriber instead of managing its own span lifecycle.

---

## Proposed Tracing Channel

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `hono:request` | Individual middleware and route handler executions within the request | `type`, `name`, `c` |

A single channel with a `type` field (rather than separate channels per middleware) because:

1. **It mirrors h3's and Elysia's pattern.** h3 uses one `h3.request` channel with `type: "middleware" | "route"`. Elysia uses one `elysia:request` channel with `lifecycle` and `type` fields. Consistency across frameworks means APM tools can share subscriber logic.
2. **APMs subscribe once.** A single subscription captures the full request middleware tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **Hono's middleware cascade is a continuum.** Unlike database operations (query vs connect) which are semantically distinct, middleware functions are stages of the same request. One channel reflects this.

### Context Properties

The context object passed to each `tracePromise` call:

| Field | Source | Purpose |
|---|---|---|
| `type` | `"middleware"` or `"handler"` | Distinguishes middleware registered via `app.use()` from route handlers registered via `app.get()`, `app.post()`, etc. |
| `name` | `fn.name` (middleware function name) or `"GET /users/:id"` for route handlers | Identifies the specific function being executed. APMs use this as the span name. |
| `ctx` | The Hono `Context` object | Carries the full request context. APMs extract HTTP attributes from this. |

### What APMs Extract from `c`

The Hono Context object provides everything APMs need to construct HTTP semantic convention attributes:

| Extracted from `c` | OTel attribute it enables |
|---|---|
| `c.req.method` | `http.request.method` |
| `c.req.url` / `c.req.path` | `url.full`, `url.path` |
| `c.req.header('traceparent')` | W3C trace context propagation |
| `c.req.header('user-agent')` | `user_agent.original` |
| `c.res.status` | `http.response.status_code` |
| `c.req.routePath` | `http.route` (e.g., `/users/:id`) |
| `c.req.param()` | Route parameters |
| `c.req.query()` | `url.query` |

### Error Handling

When a middleware throws, TracingChannel's `error` sub-channel fires automatically with the error object. APMs can:
- Set span status to ERROR
- Record `error.type` (constructor name) and `error.stack`
- Resolve status code from the error or from `c.res.status`

Hono's built-in error handling (`app.onError()`) continues to work unchanged. TracingChannel observes errors as they propagate through the middleware stack, before Hono's own error handler runs.

---

## How APM Tools Use This

### Today: Monkey-Patching the Hono Constructor + 9 Instance Methods

Sentry's classic Hono integration (via `@sentry/node`) uses IITM to intercept the `hono` module, replaces the `Hono` constructor with a subclass, and wraps every route/middleware registration method:

```ts
// Simplified from @sentry/node packages/node/src/integrations/tracing/hono/instrumentation.ts

class HonoInstrumentation extends InstrumentationBase {
  init() {
    return new InstrumentationNodeModuleDefinition('hono', ['>=4.0.0 <5'], (moduleExports) => {
      const OriginalHono = moduleExports.Hono;

      // Replace the Hono constructor entirely
      moduleExports.Hono = class WrappedHono extends OriginalHono {
        constructor(...args) {
          super(...args);
          // Wrap 9 methods on every new Hono() instance:
          // .get, .post, .put, .delete, .options, .patch, .all (route handlers)
          for (const method of ['get', 'post', 'put', 'delete', 'options', 'patch', 'all']) {
            this[method] = this._patchHandler(this[method]);
          }
          // .on (dynamic route registration)
          this.on = this._patchOnHandler(this.on);
          // .use (middleware registration)
          this.use = this._patchMiddlewareHandler(this.use);
        }
      };
    });
  }

  // Each handler wrapper intercepts the callback to create OTel spans
  _patchHandler(original) {
    return function(...args) {
      const wrappedHandlers = args.map(arg => {
        if (typeof arg !== 'function') return arg;
        return async function tracedHandler(c, next) {
          return tracer.startActiveSpan(`request_handler.hono`, {
            attributes: {
              'hono.type': 'request_handler',
              'hono.name': c.req.routePath,
              'http.route': c.req.routePath,
              'http.request.method': c.req.method,
            },
          }, async (span) => {
            try {
              return await arg(c, next);
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          });
        };
      });
      return original.apply(this, wrappedHandlers);
    };
  }

  // Middleware wrapper (same pattern, different span attributes)
  _patchMiddlewareHandler(original) {
    return function(...args) {
      const wrappedMiddleware = args.map(arg => {
        if (typeof arg !== 'function') return arg;
        return async function tracedMiddleware(c, next) {
          return tracer.startActiveSpan(`middleware.hono`, {
            attributes: {
              'hono.type': 'middleware',
              'hono.name': arg.name || 'anonymous',
            },
          }, async (span) => {
            try {
              return await arg(c, next);
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          });
        };
      });
      return original.apply(this, wrappedMiddleware);
    };
  }
}
```

This approach has several problems:
- **Replaces the `Hono` constructor**, wrapping every instance at construction time, even if no APM is listening
- **Wraps 9 methods on every instance:** `.get`, `.post`, `.put`, `.delete`, `.options`, `.patch`, `.all`, `.on`, `.use` all get shimmer wrappers
- **IITM dependency.** Only works on Node.js, not on Cloudflare Workers, Bun, or Deno where Hono commonly runs
- **Wraps at registration time, not execution time.** Every handler gets a wrapper regardless of whether the route is ever matched
- **Each APM vendor builds their own.** Sentry's newer `@sentry/hono` (alpha) already abandoned this for a `Proxy`-based approach, but still requires user code changes and vendor-specific setup

### With TracingChannel: Subscribe to Structured Events

```ts
const dc = require('node:diagnostics_channel');

dc.tracingChannel('hono:request').subscribe({
  start(ctx) {
    const spanName = ctx.type === 'handler'
      ? `${ctx.c.req.method} ${ctx.c.req.routePath}`
      : `middleware - ${ctx.name}`;

    ctx.span = tracer.startSpan(spanName, {
      kind: ctx.type === 'handler' ? SpanKind.SERVER : SpanKind.INTERNAL,
      attributes: {
        'http.request.method': ctx.c.req.method,
        'http.route': ctx.c.req.routePath,
        'hono.type': ctx.type,
        'hono.name': ctx.name,
      },
    });
    // TracingChannel automatically propagates this span as the active context.
    // Middleware cascade nests naturally via async context, no manual wrapping needed.
  },
  asyncEnd(ctx) {
    if (ctx.type === 'handler') {
      ctx.span?.setAttribute('http.response.status_code', ctx.c.res.status);
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
| **Setup** | IITM intercepts `require('hono')` before first import, or user must add vendor middleware | Subscribe to `diagnostics_channel` at any time. No ordering constraint, no user code changes |
| **Scope** | Replace `Hono` constructor + wrap 9 methods on every instance | Single channel subscription |
| **Handler wrapping** | Every handler/middleware gets wrapped at registration time, even if never matched | No wrapping. Hono emits events at execution time, subscribers observe |
| **Multi-vendor** | Each vendor builds their own instrumentation (Sentry has two, `@hono/otel` is a third) | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly unwrap constructor replacement or shimmer patches | `unsubscribe()`, clean and reversible |
| **Runtime support** | IITM: Node.js only. Userland middleware: works on Workers but needs separate code paths (Sentry maintains two) | Any runtime with `diagnostics_channel`. One subscription works on Node.js, Cloudflare Workers, and expanding |
| **Maintenance** | External packages must track Hono's internal API changes | Native, maintained as part of Hono itself |

---

## Implementation Notes

### Insertion Point

Hono's middleware cascade makes TracingChannel integration straightforward. The compose function in `src/compose.ts`, explicitly based on `koa-compose`, is the single chokepoint where all middleware and route handlers execute.

**Hono core:** wrap each handler execution in the compose/dispatch function:

```ts
// In src/compose.ts dispatch function
async function dispatch(i) {
  let handler = middleware[i]?.[0][0] || /* ... */;
  if (handler) {
    if (shouldTrace(requestChannel)) {
      const isHandler = /* determine if this is a route handler vs middleware */;
      res = await requestChannel.tracePromise(
        handler,
        {
          type: isHandler ? 'handler' : 'middleware',
          name: isHandler ? `${context.req.method} ${context.req.routePath}` : (handler.name || 'anonymous'),
          c: context,
        },
        context,
        () => dispatch(i + 1)
      );
    } else {
      res = await handler(context, () => dispatch(i + 1));
    }
  }
}
```

### Distinguishing Middleware from Handlers

In Hono's router, the `matchResult` structure encodes whether a matched handler was registered via `app.use()` (middleware) or `app.get()`/`app.post()` (route handler). The compose function receives this information through `matchResult[0]`, where each entry includes handler metadata. This metadata can be used to set the `type` field.

### Async Context Propagation

Hono's async/await cascade model is a natural fit for `tracePromise`. Each middleware call returns a Promise, and `tracePromise` wraps it to fire `start` before execution, `asyncEnd` when the Promise resolves, and `error` if it rejects.

The cascade pattern means middleware spans nest automatically:

```
middleware - logger         (start → asyncEnd)
  middleware - auth         (start → asyncEnd)
    handler - GET /users    (start → asyncEnd)
  middleware - auth         (asyncEnd fires after downstream completes)
middleware - logger         (asyncEnd fires last)
```

This gives APM tools a waterfall view of the full request lifecycle through standard APIs.

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

### Multi-Runtime Considerations

Hono is runtime-agnostic, and `diagnostics_channel` is available across Node.js, Cloudflare Workers, and is expanding to other runtimes. The standard compatibility pattern handles any runtime gracefully:

```ts
let requestChannel;
try {
  const dc = ('getBuiltinModule' in process)
    ? process.getBuiltinModule('node:diagnostics_channel')
    : require('node:diagnostics_channel');
  requestChannel = dc.tracingChannel('hono:request');
} catch {
  // diagnostics_channel not available on this runtime, no-op
}
```

The `try/catch` is a safety net for runtimes that haven't added `diagnostics_channel` yet. When no channel is available, the compose function runs without tracing overhead. The `shouldTrace` check short-circuits immediately.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before wrapping any handler with `tracePromise`. Silently skipped on runtimes where `TracingChannel` is unavailable.

Hono's `@hono/node-server` requires Node.js 18.14.1+, which has `TracingChannel` available (albeit with the `hasSubscribers` quirk on Node 18). The `try/catch` wrapper provides additional safety for edge runtimes.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`, traces middleware and route handlers with `type` field) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`elysia`**: [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809) (`elysia:request`, traces lifecycle phases with discriminator field)
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

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
