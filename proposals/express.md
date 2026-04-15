# Express: `TracingChannel` Proposal

> **Status:** 🟡 PR open
> **Tracking issue:** [expressjs/express#6353](https://github.com/expressjs/express/issues/6353)
> **PR:** [pillarjs/router#196](https://github.com/pillarjs/router/pull/196)

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Express, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Current APM instrumentations use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

Express is the most widely used Node.js framework by a significant margin. Having native TracingChannel support here sends a strong signal to the broader ecosystem and gives APM tools a stable, first-party surface to subscribe to. This is especially important because the existing `@opentelemetry/instrumentation-express` has a **critical known limitation**: it reports incorrect timing for async middleware and handlers. The OTel docs explicitly state that "the time you'll see reported for asynchronous middlewares and request handlers still only represent the synchronous execution time, and not any asynchronous work." TracingChannel fixes this structurally by wrapping the full async lifecycle.

If Express emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Tracing Channel

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `express:request` | Individual middleware and route handler executions within the request | `type`, `name`, `req`, `res` |

A single channel with a `type` field (rather than separate channels per middleware type) because:

1. **It mirrors h3's, Hono's, and Koa's pattern.** h3 uses one `h3.request` channel with `type: "middleware" | "route"`. Hono uses one `hono:request` channel with `type: "middleware" | "handler"`. Koa uses one `koa:request` channel with `type: "middleware" | "router"`. Consistency across frameworks means APM tools can share subscriber logic.
2. **APMs subscribe once.** A single subscription captures the full request middleware tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **Express's middleware cascade is a continuum.** Unlike database operations (query vs connect) which are semantically distinct, middleware functions, route handlers, and error handlers are all stages of the same request. One channel reflects this.

### Context Properties

The context object passed to each `tracePromise` / `traceCallback` call:

| Field | Source | Purpose |
|---|---|---|
| `type` | `"middleware"`, `"request_handler"`, or `"error_handler"` | Distinguishes regular middleware from route handlers and error handlers. Matches OTel's `ExpressLayerType` values for seamless migration. |
| `name` | `fn.name` (middleware function name) or route path for handlers (e.g., `"GET /users/:id"`) | Identifies the specific function being executed. APMs use this as the span name. |
| `req` | The Express request object | Carries the full request context. APMs extract HTTP attributes from this. |
| `res` | The Express response object | Carries the response. APMs extract status codes and response headers from this. |

### What APMs Extract from `req` and `res`

| Extracted from | OTel attribute it enables |
|---|---|
| `req.method` | `http.request.method` |
| `req.url` / `req.originalUrl` | `url.full`, `url.path` |
| `req.headers` | W3C trace context propagation (`traceparent`, `tracestate`), `user_agent.original` |
| `req.ip` / `req.ips` | `client.address` |
| `req.hostname` | `server.address` |
| `req.route.path` | `http.route` (e.g., `/users/:id`) |
| `req.params` | Route parameters |
| `req.query` | `url.query` |
| `res.statusCode` | `http.response.status_code` |
| `res.getHeaders()` | `http.response.header.*` |

### Error Handling

When a middleware or handler throws (or calls `next(err)`), TracingChannel's `error` sub-channel fires automatically. APMs can:
- Set span status to ERROR
- Record `error.type` (constructor name) and `error.stack`
- Resolve status code from `res.statusCode`

Express's error-handling middleware (`(err, req, res, next)`) continues to work unchanged. TracingChannel observes errors as they propagate through the stack. When an error handler is reached, it emits its own traced event with `type: "error_handler"`, giving APMs visibility into error recovery that the current OTel instrumentation completely skips.

---

## How APM Tools Use This

### Today: Monkey-Patching `Router.use`, `Router.route`, and `Application.use`

Both `@opentelemetry/instrumentation-express` and `@sentry/node` use the same fundamental approach: intercept middleware/route registration methods and wrap each handler function to create spans.

```js
// Simplified from @opentelemetry/instrumentation-express

// 1. Patch Application.prototype.use — intercept all app-level middleware
shimmer.wrap(express.application, 'use', original => function patchedUse(...args) {
  const result = original.apply(this, args);
  // After registration, find the new layers and patch their handle functions
  for (const layer of this._router.stack) {
    if (!layer[kLayerPatched]) {
      wrapLayerHandle(layer);
      layer[kLayerPatched] = true;
    }
  }
  return result;
});

// 2. Patch Router.prototype.use — intercept router-level middleware
shimmer.wrap(express.Router, 'use', original => function patchedUse(...args) {
  const result = original.apply(this, args);
  for (const layer of this.stack) {
    if (!layer[kLayerPatched]) {
      wrapLayerHandle(layer);
      layer[kLayerPatched] = true;
    }
  }
  return result;
});

// 3. Patch Router.prototype.route — intercept route definitions
shimmer.wrap(express.Router, 'route', original => function patchedRoute(path) {
  const route = original.call(this, path);
  // Wrap all handler stacks within the route
  for (const layer of route.stack) {
    wrapLayerHandle(layer);
  }
  return route;
});

// 4. Wrap each layer's handle function
function wrapLayerHandle(layer) {
  const original = layer.handle;
  layer.handle = function tracedHandle(req, res, next) {
    const spanName = getLayerType(layer) === 'request_handler'
      ? `request handler - ${req.route?.path || layer.name}`
      : `middleware - ${layer.name}`;

    // Track layer paths for route reconstruction
    storeLayerPath(req, layer.path);

    const span = tracer.startSpan(spanName, {
      attributes: {
        'express.type': getLayerType(layer),
        'express.name': layer.name,
        'http.route': getConstructedRoute(req),
      },
    });

    try {
      return original.call(this, req, res, function tracedNext(err) {
        span.end();
        next(err);
      });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err);
      span.end();
      throw err;
    }
  };
}
```

This approach has several problems:
- **Wraps every handler at registration time.** Even middleware that never matches the current request has a patched `layer.handle`
- **Symbol-based deduplication** (`kLayerPatched`) is fragile across module instances
- **Async timing is fundamentally broken.** The span ends when `next()` is called, not when the handler's async work completes. This is a known, documented limitation that cannot be fixed without TracingChannel
- **Error handlers are completely skipped.** The OTel instrumentation has a `TODO: instrument error handlers` comment that has never been addressed
- **Route reconstruction is fragile.** Both OTel and Sentry maintain a `WeakMap`/array of layer paths on the request object (`req.__ot_middlewares`) and reconstruct the route by joining them. This breaks when sub-apps modify the URL path
- **Three separate patch points** across two packages (`express` and the internal router) that must stay in sync

### With TracingChannel: Subscribe to Structured Events

```js
const dc = require('node:diagnostics_channel');

dc.tracingChannel('express:request').subscribe({
  start(ctx) {
    const spanName = ctx.type === 'request_handler'
      ? `request handler - ${ctx.name}`
      : ctx.type === 'error_handler'
      ? `error handler - ${ctx.name}`
      : `middleware - ${ctx.name}`;

    ctx.span = tracer.startSpan(spanName, {
      kind: ctx.type === 'request_handler' ? SpanKind.SERVER : SpanKind.INTERNAL,
      attributes: {
        'express.type': ctx.type,
        'express.name': ctx.name,
        'http.request.method': ctx.req.method,
        ...(ctx.req.route && { 'http.route': ctx.req.route.path }),
      },
    });
    // TracingChannel automatically propagates this span as the active context.
    // Middleware cascade nests naturally via async context, no manual wrapping needed.
  },
  asyncEnd(ctx) {
    if (ctx.type === 'request_handler') {
      ctx.span?.setAttribute('http.response.status_code', ctx.res.statusCode);
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
| **Setup** | Must intercept module load via IITM/RITM before `require('express')` | Subscribe to `diagnostics_channel` at any time. No ordering constraint |
| **Scope** | Patch 3 methods (`Application.use`, `Router.use`, `Router.route`), wrap every layer's handle function | Single channel subscription |
| **Async timing** | **Broken.** Spans end at `next()` call, not at async completion. Documented, unfixable limitation | **Correct.** `tracePromise` wraps the full async lifecycle; `asyncEnd` fires when the Promise resolves |
| **Error handlers** | Completely skipped (TODO in OTel source for 3+ years) | Traced with `type: "error_handler"`. Full visibility into error recovery |
| **Route tracking** | Fragile `WeakMap`/array reconstruction across nested routers | Express provides `req.route.path` directly in the context |
| **Multi-vendor** | Stacked shimmer wrappers interfere with each other | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly unwrap shimmer patches once applied | `unsubscribe()`, clean and reversible |
| **Maintenance** | Must track Express internal API changes across major versions (v4 → v5 required Sentry to maintain two code paths) | Native. Maintained as part of Express itself |

---

## Implementation Notes

### Where the Code Lives

Express 5 externalizes its router to [`pillarjs/router`](https://github.com/pillarjs/router) v2.x. The core insertion point is in `pillarjs/router`, specifically in `lib/layer.js` where every middleware and handler actually executes.

This is the same conclusion reached in [pillarjs/router#96](https://github.com/pillarjs/router/pull/96) (Qard's original proof-of-concept from 2020). The difference is that TracingChannel provides the structured lifecycle that plain `diagnostics_channel` channels lack.

### Insertion Points

**`pillarjs/router` `lib/layer.js`:** This is the single chokepoint. Every middleware, route handler, and error handler flows through either `Layer.prototype.handleRequest` (3-arg) or `Layer.prototype.handleError` (4-arg).

```js
// In lib/layer.js — Layer.prototype.handleRequest
Layer.prototype.handleRequest = function handleRequest(req, res, next) {
  var fn = this.handle;

  if (fn.length > 3) {
    // not a standard request handler — skip
    return next();
  }

  if (shouldTrace(requestChannel)) {
    var ctx = {
      type: this.route ? 'request_handler' : 'middleware',
      name: this.route
        ? req.method + ' ' + this.route.path
        : (fn.name || 'anonymous'),
      req: req,
      res: res,
    };

    // Express 5 handlers can return promises
    var ret = fn.call(this, req, res, next);
    if (isPromise(ret)) {
      return requestChannel.tracePromise(function() { return ret; }, ctx);
    }
    // For callback-only handlers, use traceCallback
    return requestChannel.traceCallback(
      function(cb) { fn.call(this, req, res, cb); },
      0, // callback position
      ctx,
      this, req, res, next
    );
  }

  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

// In lib/layer.js — Layer.prototype.handleError
Layer.prototype.handleError = function handleError(error, req, res, next) {
  var fn = this.handle;

  if (fn.length !== 4) {
    // not an error handler — skip
    return next(error);
  }

  if (shouldTrace(requestChannel)) {
    var ctx = {
      type: 'error_handler',
      name: fn.name || 'anonymous',
      req: req,
      res: res,
    };
    // Same promise/callback branching as handleRequest
  }

  try {
    fn(error, req, res, next);
  } catch (err) {
    next(err);
  }
};
```

**Important design note on callback vs promise tracing:**

Express 5 supports both patterns. When a handler returns a Promise, `tracePromise` wraps it correctly. For callback-only handlers (the common Express 4 pattern still supported in v5), `next()` signals completion, which maps to `traceCallback`. The implementation should detect the return value: if it's a promise, use `tracePromise`; otherwise, use `traceCallback` with `next` as the callback.

This branching is necessary because `tracePromise` on a non-promise path would create a resolved promise that ends the trace immediately, and `traceCallback` on a promise path would miss async completion entirely.

### Distinguishing Layer Types

Express already classifies layers internally:
- **Middleware:** registered via `app.use()` or `router.use()`. `layer.route` is `undefined`.
- **Route handlers:** registered via `app.get()`, `app.post()`, etc. `layer.route` is a `Route` object.
- **Error handlers:** any function with exactly 4 parameters (`fn.length === 4`). Only reached via `layer.handleError`.

The `type` field maps directly to these: `layer.route ? 'request_handler' : 'middleware'` for normal handlers, `'error_handler'` for 4-arg functions. This matches the `ExpressLayerType` enum used by OTel and Sentry, ensuring a seamless migration path.

### Async Context Propagation

Express 5's async error handling (`pillarjs/router` v2.x catches rejected promises and forwards them to `next(err)`) is a natural fit for `tracePromise`. Each handler call returns a Promise (or can be wrapped in one), and `tracePromise` wraps it to fire `start` before execution, `asyncEnd` when the Promise resolves, and `error` if it rejects.

The middleware cascade means spans nest automatically:

```
middleware - bodyParser        (start → asyncEnd)
  middleware - authCheck       (start → asyncEnd)
    request_handler - GET /users/:id   (start → asyncEnd)
  middleware - authCheck       (asyncEnd fires after downstream completes)
middleware - bodyParser        (asyncEnd fires last)
```

This gives APM tools the correct waterfall view with accurate async timing, solving the fundamental limitation of the current OTel instrumentation.

### Sub-Applications

Express sub-apps (`app.use('/api', subApp)`) are handled naturally. The `mounted_app` wrapper in `lib/application.js` delegates to `subApp.handle()`, which calls into `subApp.router.handle()`, which dispatches through the same `Layer.handleRequest` path. Each layer in the sub-app's router stack emits its own traced event with the correct `req.route` context. TracingChannel's async context propagation ensures the sub-app's spans are children of the parent app's middleware span.

### shouldTrace Helper

```js
const shouldTrace = (ch) => ch.start.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

---

## Relationship to Existing PRs

There are several open PRs attempting to add diagnostics support to Express:

- **[pillarjs/router#96](https://github.com/pillarjs/router/pull/96)** (Qard, 2020): The original proof-of-concept using plain `diagnostics_channel`. Targets the right location (`lib/layer.js`) but predates `TracingChannel`, so it lacks async lifecycle support.
- **[express#6959](https://github.com/expressjs/express/pull/6959)**: Defines 7 separate channels (`express.request.start`, `express.middleware.start`, etc.). This over-channels the design and duplicates what `TracingChannel` provides structurally via its `start`/`end`/`error` sub-channels.
- **[express#7041](https://github.com/expressjs/express/pull/7041)**: Adds only `express.initialization`, with route-level tracing deferred to `pillarjs/router`.
- **[express#7171](https://github.com/expressjs/express/pull/7171)**: Adds `express.request.start`/`finish`/`error` using plain `diagnostics_channel`. Closer to the right shape but lacks `TracingChannel` lifecycle support.

This proposal builds on Qard's insight (instrument at the layer level in `pillarjs/router`) while using `TracingChannel` for proper async lifecycle tracking. A single `express:request` TracingChannel replaces the multiple plain channels proposed in the other PRs, with the `type` discriminator field providing the middleware/handler/error classification that APMs need.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before wrapping any handler with `tracePromise`. Silently skipped on runtimes where `TracingChannel` is unavailable.

```js
let requestChannel;
try {
  const dc = ('getBuiltinModule' in process)
    ? process.getBuiltinModule('node:diagnostics_channel')
    : require('node:diagnostics_channel');
  requestChannel = dc.tracingChannel('express:request');
} catch {
  // TracingChannel not available — no-op
}
```

Express 5 requires Node.js 18+, which has `TracingChannel` available (albeit with the `hasSubscribers` quirk). The `try/catch` wrapper provides safety for alternative runtimes.

For Express 4, which supports older Node.js versions, the same pattern works: `TracingChannel` is simply unavailable on Node 16 and below, and the `try/catch` makes this a no-op.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`, traces middleware and route handlers with `type` field) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`nitro`**: [nitrojs/nitro#4001](https://github.com/nitrojs/nitro/pull/4001) ✅ merged
- **`elysia`**: [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809) (`elysia:request`, traces lifecycle phases with discriminator field)
- **`hono`**: [honojs/hono#4842](https://github.com/honojs/hono/issues/4842) (`hono:request`, traces middleware and handlers with `type` field)
- **`koa`**: proposal drafted (`koa:request`, traces middleware and router handlers with `type` field)

**Databases:**
- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`node-redis`**: [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`) ✅ merged
- **`ioredis`**: [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`) ✅ merged
- **`pg` / `pg-pool`**: [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650) (`pg:query`, `pg:connection`, `pg:pool:connect`)
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

## Caveats for APM Subscribers

### Error handler spans and double error capture

Express error handlers (`(err, req, res, next)`) are traced like any other layer. This means when a middleware or route handler throws, two things happen in sequence:

1. The TracingChannel `error` sub-channel fires on the throwing layer's span (with the error object).
2. Express routes the error to the next error handler, which gets its own traced span via `handleError`.

APM subscribers need to be careful not to capture the same error twice. The recommended approach: capture the error on the `error` phase for span status/recording, but do not report it as an unhandled exception there. Let the application's error handler (or a dedicated error-reporting middleware like Sentry's `setupExpressErrorHandler()`) handle exception reporting, since it has the final response status and knows whether the error was actually recovered.

### Route dispatch wrapper layers are excluded

Layers created internally by `Router.prototype.route()` (the glue function that calls `route.dispatch()`) are not traced. These have `layer.route` set but their `fn` is an internal wrapper, not user code. The actual user-registered handlers inside the route are traced individually. This avoids duplicate spans for the same route.

### Middleware cascade produces nested spans

Express's onion model means each middleware's `tracePromise` wraps the entire downstream `next()` chain. This produces nested spans:

```
middleware - jsonParser
  middleware - authCheck
    GET /users/:id
```

This accurately represents Express's execution model, where each middleware encompasses the downstream work. APM subscribers that prefer flat sibling spans can achieve this by managing parent span context manually in their subscriber rather than relying on TracingChannel's automatic async context propagation.

### Multiple handlers on a single route

When a route has multiple handlers (`app.get('/path', validate, load, respond)`), all handlers inside the route share the same `req.route`. The subscriber can distinguish them by `layer.name` (the function name) and by execution order. Only the final handler typically sets `res.statusCode`, so subscribers should read response attributes on `asyncEnd` rather than `start`.

---

Would love to hear your thoughts on the channel design and context shape. Happy to put together a PR targeting `pillarjs/router` with the implementation.
