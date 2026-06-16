# @tanstack/start: `TracingChannel` Proposal

> **Discussion:** [TanStack/router#7604](https://github.com/TanStack/router/discussions/7604)
> **Status:** 💬 Discussion open

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to TanStack Start, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API over `diagnostics_channel`, built for tracing async operations. It exposes structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and propagates async context correctly — the piece that makes monkey-patching fragile in real-world async code.

Today, APM instrumentation monkey-patches framework internals via IITM (ESM) and RITM (CJS). This is fragile in several ways:

- **Runtime lock-in:** both rely on Node-specific module loader internals (`Module._resolveFilename`, `module.register()`) and don't work on Bun, Deno, or Cloudflare Workers.
- **ESM fragility:** IITM rides on Node's still-evolving module hooks, a persistent source of breakage in the OTel JS ecosystem.
- **Init ordering:** instrumentation must load before the framework is first imported; get it wrong and tracing silently does nothing — painful to debug in production.
- **Bundling:** users must externalize instrumented modules, increasingly hard to guarantee as frameworks bundle server code.

TanStack Start shows these problems acutely. There's no `@opentelemetry/instrumentation-tanstackstart`; the only option is `@sentry/tanstackstart-react`, which needs **three coordinated mechanisms**:

1. A **Vite build plugin** that regex-transforms middleware arrays in `createStart()`, `createFileRoute()`, and `createServerFn().middleware()` to inject wrappers — production-only, handles just simple identifier arrays, breaks on formatting.
2. **`wrapFetchWithSentry`**, a `Proxy` on the server entry's `fetch` that intercepts every request, detects server functions by URL pattern (`_serverFn`), and parses HTML response streams to inject trace meta-tags.
3. **`wrapMiddlewaresWithSentry`**, a `Proxy` on each middleware's `next()` for span lifecycle, with symbol-based dedup to avoid double-wrapping.

That's a lot of fragile machinery for basic request tracing, and every APM vendor has to rebuild it from scratch. If TanStack Start emits structured `TracingChannel` events, instrumentation becomes **subscribers, not patches** — each tool listens independently, with no ordering concerns, no clobbering, and no internal-API dependency.

---

## Proposed Tracing Channels

Three narrow channels, each with its own subscriber set:

| TracingChannel | Emitted from | Tracks | Context fields |
|---|---|---|---|
| `@tanstack/start:request` | `@tanstack/start-server-core` | middleware, handler, and server-function executions — the `executeMiddleware()` cascade | `type`, `name`, `request`, `ctx` |
| `@tanstack/start:render` | `@tanstack/start-server-core` | the SSR document render for a page request (`executeRouter()` — route load + dehydrate + render-to-stream) | `request`, `matchedRoutes`, `router` |
| `@tanstack/router:loader` | `@tanstack/router-core` | per-route `beforeLoad` / `loader` execution during a load pass | `type`, `routeId`, `match`, `preload` |

### Why three channels rather than one

`diagnostics_channel` makes per-channel dispatch cheap precisely *because* each channel has its own subscriber set. A single wide channel that multiplexed request middleware, SSR render, and route loaders would force every subscriber to run on every publish and discard the messages it doesn't want — continuous overhead even for ignored events. The cost model favors N narrow channels over one wide channel + N filters.

So the split follows subsystem boundaries, not arbitrary granularity:

- **`:request`** is the server middleware cascade (`executeMiddleware()` in `start-server-core`).
- **`:render`** is the SSR document generation (`executeRouter()` in `start-server-core`), a once-per-page-request operation a request-only subscriber should not be woken for.
- **`:loader`** is the router's data-loading lifecycle (`router-core`), a different subsystem that also runs client-side (see [Loader channel](#loader-channel-tanstackrouterloader)).

The prefix follows the emitting package (`@tanstack/start:*` for `start-server-core`, `@tanstack/router:*` for `router-core`), keeping each channel name globally unique and self-describing.

> **Note — per-component render tracing is deliberately excluded.** Wrapping individual React component renders would be a firehose (hundreds of events per request) and it is React's surface to expose, not TanStack Start's. `:render` traces only the document-level render boundary that Start owns.

### Why a `type` discriminator *within* `:request` and `:loader`

Within a single subsystem, lifecycle phases that a subscriber always consumes together share one channel with a `type` field — they are stages of one operation, not distinct operations a subscriber would filter:

1. **It mirrors the pattern used by h3, Hono, Express, Koa, and Elysia.** h3 uses one `h3.request` channel with `type: "middleware" | "route"`. Hono uses one `hono:request` channel. Consistency across frameworks means APM tools can share subscriber logic.
2. **APMs subscribe once per subsystem.** A single subscription captures that subsystem's full lifecycle tree. The nesting comes from async context propagation, not from multiple channel subscriptions.
3. **The middleware cascade and the load pass are each a continuum.** Request/route/handler/server-function middleware are all stages of one request dispatch; `beforeLoad` and `loader` are both phases of loading one route match.

---

### Request channel: `@tanstack/start:request`

The context object passed to each `tracePromise` call:

| Field | Source | Purpose |
|---|---|---|
| `type` | `"middleware"`, `"handler"`, or `"server_function"` | Distinguishes request/route middleware from route handlers and server function invocations. APMs use this for span naming and categorization. |
| `name` | Middleware function name, route method + path for handlers (e.g., `"GET /users/$id"`), or server function ID for server functions | Identifies the specific function being executed. APMs use this as the span name. |
| `request` | The `Request` object | Carries the HTTP request. APMs extract method, URL, headers from this. |
| `ctx` | The middleware context object (`{ request, pathname, context, params }`) | Carries the full middleware context including route params and merged context from preceding middleware. |

#### What APMs Extract from `request` and `ctx`

| Extracted from | OTel attribute it enables |
|---|---|
| `request.method` | `http.request.method` |
| `request.url` | `url.full`, `url.path`, `url.scheme` |
| `request.headers` | W3C trace context propagation (`traceparent`, `tracestate`), `user_agent.original` |
| `ctx.pathname` | `url.path` (normalized) |
| `ctx.params` | Route parameters (e.g., `{ id: "123" }`) |
| `ctx.context` | Application-level state accumulated through the middleware chain |
| Response status (from resolved `ctx.response`) | `http.response.status_code` |

#### Distinguishing Operation Types

TanStack Start has two distinct request paths that share the same `executeMiddleware()` function:

1. **Server function requests**: detected when `url.pathname.startsWith(SERVER_FN_BASE)`. These execute request-level middleware, then call `handleServerAction()` which resolves the server function by ID, parses the payload, and runs function-level middleware before invoking the handler.

2. **Page/SSR requests**: execute request-level middleware, then route-level middleware from matched routes, then handler-level middleware (if the route has server handlers), then finally SSR via `executeRouter()` (traced separately on `:render`).

The `type` field captures this:
- `"middleware"` for request-level, route-level, and handler-level middleware
- `"handler"` for route server handlers (matched via `handlers[requestMethod]`)
- `"server_function"` for server function invocations via `handleServerAction()`

#### Error Handling

When a middleware or handler throws, TracingChannel's `error` sub-channel fires automatically with the error object. APMs can:
- Set span status to ERROR
- Record `error.type` (constructor name) and `error.stack`
- Resolve status code from the Response if one was thrown

TanStack Start treats thrown `Response` objects and redirects as special flow-control values (via `isSpecialResponse()`). TracingChannel's error channel only fires for actual errors; redirect/Response-based flow control should not trigger the error path.

---

### Render channel: `@tanstack/start:render`

A page (SSR) request flows through the middleware cascade and lands in `executeRouter()`, which does the work that actually dominates server-side latency: resolving the manifest, running `routerInstance.load()` (which fires route loaders), dehydrating router state, and invoking the render-to-stream callback. The `:request` handler span treats all of this as opaque. `:render` wraps it as a single span — the closest thing to a "server render" duration an APM can attach to.

`tracePromise` wraps the whole of `executeRouter()`. One span per page request; loader spans (below) and the eventual response stream nest under it via async context.

| Field | Source | Purpose |
|---|---|---|
| `request` | The `Request` object | Method, URL, headers — and W3C trace context for span linkage. |
| `matchedRoutes` | The matched route array passed to `executeRouter` | Lets APMs name the span by the matched route tree (e.g. `render /users/$id`) rather than the raw URL. |
| `router` | The resolved router instance (available after `getRouter()`) | Exposes `router.state` for redirect detection and `getStartResponseHeaders()` status. APMs read `http.response.status_code` from the resolved `SsrResponse`. |

Server-function requests never reach `executeRouter()`, so `:render` fires only for document requests — no need for a `type` discriminator.

### Loader channel: `@tanstack/router:loader`

Route `beforeLoad` and `loader` functions are where SSR requests spend most of their *application* time (data fetching, auth checks), yet they run inside `router-core`'s load pass — **not** through the server middleware chain — so the `:request` and `:render` channels can't see them individually. A dedicated channel surfaces per-route data-loading spans.

This channel is emitted from `@tanstack/router-core`, which is **isomorphic** — it runs in the browser as well as on the server. Two consequences:

1. **The prefix is `@tanstack/router:`, not `@tanstack/start:`** — it follows the emitting package, and the channel is useful for client-side navigation tracing too, not just SSR.
2. **`diagnostics_channel` must be loaded defensively**, since `router-core` ships to browsers and edge runtimes where the module doesn't exist. Use the cross-runtime guard (`typeof process` check → `process.getBuiltinModule('node:diagnostics_channel')` → `require` fallback → `try/catch`). The publish itself is additionally gated on `shouldTrace(channel)`, so client bundles with no subscriber pay nothing.

| Field | Source | Purpose |
|---|---|---|
| `type` | `"beforeLoad"` or `"loader"` | Distinguishes the two phases of loading a match. Phases of one operation, so one channel with a discriminator. |
| `routeId` | `route.id` | Names the span (e.g. `loader /users/$id`). |
| `match` | The route match (`{ search, params, cause, routeId, ... }`) | Route params, search params, and `cause` (`"preload"` vs navigation) for span attributes. |
| `preload` | `resolvePreload(...)` | Lets APMs flag or down-sample preload-triggered loads distinctly from in-request loads. |

#### Error and flow-control handling

Like the request path, loaders use thrown `redirect()` and `notFound()` as flow control (handled via `handleRedirectAndNotFound` / `isRedirect` / `isNotFound`). The `error` sub-channel must fire only for genuine errors — redirect and not-found throws are normal control flow and should resolve through `asyncEnd`, not `error`.

---

## How APM Tools Use This

### Today: Vite Build Plugin + Proxy Wrappers + URL Heuristics

Sentry's TanStack Start integration (`@sentry/tanstackstart-react`) is the only APM instrumentation available. It requires three coordinated mechanisms:

```ts
// 1. Vite build plugin: regex-transforms middleware arrays at build time
// Converts: requestMiddleware: [authMiddleware, loggingMiddleware]
// Into:     requestMiddleware: wrapMiddlewaresWithSentry({ authMiddleware, loggingMiddleware })
function makeAutoInstrumentMiddlewarePlugin() {
  return {
    name: 'sentry-tanstack-middleware-auto-instrument',
    transform(code, id) {
      // Regex to find middleware arrays in createStart(), createFileRoute(), createServerFn()
      const transformed = code.replace(
        /(requestMiddleware|functionMiddleware)\s*:\s*\[([^\]]*)\]/g,
        (match, key, contents) => {
          // Only works if contents are simple identifiers, not function calls
          return `${key}: wrapMiddlewaresWithSentry(${arrayToObjectShorthand(contents)})`;
        }
      );
      return addSentryImport(transformed);
    },
  };
}

// 2. Manual middleware wrapping: Proxy on next() for span lifecycle
function wrapMiddlewareWithSentry(middleware, options) {
  middleware.options.server = new Proxy(middleware.options.server, {
    apply: (originalServer, thisArg, args) => {
      return startSpanManual(getMiddlewareSpanOptions(options.name), async (span) => {
        const middlewareArgs = args[0];
        // Proxy next() to end the span when called
        middlewareArgs.next = new Proxy(middlewareArgs.next, {
          apply: (originalNext, thisArgNext, argsNext) => {
            span.end();
            return withActiveSpan(prevSpan, () => Reflect.apply(originalNext, thisArgNext, argsNext));
          },
        });
        const result = await originalServer.apply(thisArg, args);
        span.end();
        return result;
      });
    },
  });
}

// 3. Server entry wrapper: Proxy on fetch for request-level tracing
function wrapFetchWithSentry(serverEntry) {
  serverEntry.fetch = new Proxy(serverEntry.fetch, {
    async apply(target, thisArg, args) {
      const request = args[0];
      const url = new URL(request.url);
      // Detect server functions by URL pattern
      if (url.pathname.includes('_serverFn') || url.pathname.includes('createServerFn')) {
        return startSpan({ op: 'function.tanstackstart', name: `${method} ${url.pathname}` }, () =>
          target.apply(thisArg, args)
        );
      }
      // For page requests, inject trace meta-tags into HTML stream
      return injectMetaTagsInResponse(await target.apply(thisArg, args));
    },
  });
}
```

This approach has several problems:
- **Build-time only.** The Vite plugin regex transforms don't run in development mode, so middleware is uninstrumented during dev
- **Regex fragility.** Cannot handle dynamic middleware arrays, function calls, or non-standard formatting. Warns and skips anything it can't parse
- **URL heuristics for server function detection.** Matches `_serverFn` or `createServerFn` in the pathname, which is coupled to TanStack Start's internal URL scheme
- **Proxy-based span lifecycle.** Wrapping `next()` with a Proxy and tracking `nextState.called` to decide when to end spans is complex and fragile
- **Symbol-based double-wrap prevention.** `__SENTRY_WRAPPED__` markers are fragile across module instances
- **Vendor lock-in.** No other APM can reuse any of this; each would need to build equivalent Vite plugins and Proxy wrappers from scratch

### With TracingChannel: Subscribe to Structured Events

```ts
const dc = require('node:diagnostics_channel');

dc.tracingChannel('@tanstack/start:request').subscribe({
  start(ctx) {
    const spanName = ctx.type === 'server_function'
      ? `server fn - ${ctx.name}`
      : ctx.type === 'handler'
      ? `${ctx.request.method} ${ctx.ctx.pathname}`
      : `middleware - ${ctx.name}`;

    ctx.span = tracer.startSpan(spanName, {
      kind: ctx.type === 'handler' ? SpanKind.SERVER : SpanKind.INTERNAL,
      attributes: {
        'http.request.method': ctx.request.method,
        'url.path': ctx.ctx.pathname,
        'tanstack.start.type': ctx.type,
        'tanstack.start.name': ctx.name,
      },
    });
    // TracingChannel automatically propagates this span as the active context.
    // Middleware cascade nests naturally via async context, no manual wrapping needed.
  },
  asyncEnd(ctx) {
    if (ctx.type === 'handler' && ctx.ctx.response) {
      ctx.span?.setAttribute('http.response.status_code', ctx.ctx.response.status);
    }
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});

// Subscribe to the SSR render and per-route loaders the same way.
// All three publish within the same async context, so spans nest into one tree.
dc.tracingChannel('@tanstack/start:render').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`render ${ctx.request.url}`, { kind: SpanKind.INTERNAL });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.recordException(ctx.error); ctx.span?.end(); },
});

dc.tracingChannel('@tanstack/router:loader').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`${ctx.type} ${ctx.routeId}`, {
      attributes: { 'tanstack.router.cause': ctx.match?.cause, 'tanstack.router.preload': ctx.preload },
    });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.recordException(ctx.error); ctx.span?.end(); },
});
```

**What changes for APM vendors:**

| Concern | Current (Sentry-only) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Vite build plugin + manual `wrapFetchWithSentry` in server entry + optional manual `wrapMiddlewaresWithSentry` | Subscribe to `diagnostics_channel` at any time. No build plugins, no server entry changes, no user code changes |
| **Dev mode** | Vite plugin disabled; middleware is uninstrumented during development | Works identically in dev and prod |
| **Middleware wrapping** | Regex AST transform at build time, or Proxy-based manual wrapping | No wrapping. TanStack Start emits events at execution time, subscribers observe |
| **Server function detection** | URL heuristic (`_serverFn` in pathname) | Emitted with `type: "server_function"` and the function ID as `name` |
| **Span lifecycle** | Proxy on `next()` with `nextState.called` tracking | TracingChannel handles start/end/error lifecycle automatically |
| **Multi-vendor** | Only Sentry; each new APM rebuilds everything from scratch | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly remove Vite plugin transforms or Proxy wrappers | `unsubscribe()`, clean and reversible |
| **Maintenance** | External packages must track TanStack Start's internal URL schemes, middleware shapes, and build pipeline | Native, maintained as part of TanStack Start itself |

---

## Implementation Notes

### Insertion Point: `executeMiddleware()`

TanStack Start has a single `executeMiddleware()` function in `createStartHandler.ts` that handles all middleware execution: request-level, route-level, handler-level, and server function middleware. This is the natural TracingChannel insertion point.

```ts
// In createStartHandler.ts — executeMiddleware()
function executeMiddleware(middlewares: Array<TODO>, ctx: TODO): Promise<TODO> {
  let index = -1;

  const next = async (nextCtx?: TODO): Promise<TODO> => {
    // ... context merging ...

    index++;
    const middleware = middlewares[index];
    if (!middleware) return ctx;

    if (shouldTrace(requestChannel)) {
      const traceCtx = {
        type: getMiddlewareType(middleware),
        name: middleware.name || 'anonymous',
        request: ctx.request,
        ctx,
      };
      try {
        const result = await requestChannel.tracePromise(
          async () => middleware({ ...ctx, next }),
          traceCtx,
        );
        // ... normalize result ...
        return ctx;
      } catch (err) {
        if (isSpecialResponse(err)) {
          ctx.response = err;
          return ctx;
        }
        throw err;
      }
    }

    // Original untraced path
    let result;
    try {
      result = await middleware({ ...ctx, next });
    } catch (err) {
      if (isSpecialResponse(err)) {
        ctx.response = err;
        return ctx;
      }
      throw err;
    }

    // ... normalize result ...
    return ctx;
  };

  return next();
}
```

### Server Function Tracing

The server function path in `startRequestResolver` wraps `handleServerAction()` as the final middleware in the chain. The middleware context can be enriched with the server function ID:

```ts
// In startRequestResolver, server function path
const serverFnHandler = async ({ context }: TODO) => {
  return runWithStartContext(/* ... */, () =>
    handleServerAction({ request, context: requestOpts?.context, serverFnId }),
  );
};

// The handler is added as the last middleware, so executeMiddleware traces it
// with type: "server_function" and name: serverFnId
```

For finer-grained tracing within `handleServerAction()` (payload parsing, function-level middleware, response serialization), additional `tracePromise` calls can be added inside that function. This would give APMs visibility into:
- Payload parsing (FormData, JSON, query string)
- The actual server function execution
- Response serialization (JSON vs multiplexed stream)

### Insertion Point: `executeRouter()` (`@tanstack/start:render`)

`executeRouter()` in `createStartHandler.ts` is the SSR document boundary. Wrapping its body in `renderChannel.tracePromise` captures manifest resolution, `routerInstance.load()`, dehydration, and the render-to-stream callback as one span:

```ts
// In createStartHandler.ts — executeRouter()
const executeRouter = async (serverContext, matchedRoutes) => {
  const run = async () => {
    // ... resolve manifest, attach SSR utils ...
    const routerInstance = await getRouter();
    routerInstance.options.additionalContext = { serverContext };
    await routerInstance.load();              // loaders fire here → :loader spans nest under this
    // ... dehydrate ...
    const response = await cb({ request, router: routerInstance, responseHeaders });
    return normalizeSsrResponse(response);
  };

  if (!shouldTrace(renderChannel)) return run();
  return renderChannel.tracePromise(run, { request, matchedRoutes });
};
```

### Insertion Point: route loaders (`@tanstack/router:loader`)

In `router-core`'s `load-matches.ts`, the `loader` invocation (in `runLoader`) and the `beforeLoad` invocation are the two insertion points. Both already run inside the server's async context during SSR (guarded by the existing `isServer` checks), so the spans nest under `:render` automatically.

```ts
// router-core/src/load-matches.ts — runLoader(), around the loader call
const loader = typeof routeLoader === 'function' ? routeLoader : routeLoader?.handler;
const invoke = () => loader?.(getLoaderContext(inner, matchPromises, matchId, index, route));
const loaderResult = shouldTrace(loaderChannel)
  ? loaderChannel.tracePromise(async () => invoke(), { type: 'loader', routeId: route.id, match, preload })
  : invoke();
```

```ts
// router-core/src/load-matches.ts — beforeLoad branch
const run = () => route.options.beforeLoad(beforeLoadFnContext);
beforeLoadContext = shouldTrace(loaderChannel)
  ? loaderChannel.tracePromise(async () => run(), { type: 'beforeLoad', routeId: route.id, match, preload })
  : run();
```

Because `router-core` is isomorphic, load `diagnostics_channel` with the cross-runtime guard rather than a static `node:` import:

```ts
let dc;
try {
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    dc = process.getBuiltinModule('node:diagnostics_channel');
  }
  if (!dc) dc = require('node:diagnostics_channel');
} catch {}
const loaderChannel = dc?.tracingChannel('@tanstack/router:loader');
```

The `getBuiltinModule` path is bundler-invisible (no static import for browser bundlers to choke on), the `require` fallback covers older Node / Bun / Workers, and the `try/catch` makes it a no-op in the browser where `diagnostics_channel` is absent.

### Async Context Propagation

TanStack Start's async/await middleware cascade is a natural fit for `tracePromise`. Each middleware call returns a Promise, and `tracePromise` wraps it to fire `start` before execution, `asyncEnd` when the Promise resolves, and `error` if it rejects.

The cascade pattern means spans across all three channels nest automatically into one tree for a page request:

```
:request  middleware - authMiddleware          (start → asyncEnd)
:request    handler - GET /users/$id           (start → asyncEnd)
:render       render /users/$id                (executeRouter: start → asyncEnd)
:loader         beforeLoad /users/$id          (start → asyncEnd)
:loader         loader /users/$id              (start → asyncEnd)
:request  middleware - authMiddleware          (asyncEnd fires last)
```

Each channel has its own subscriber set, but because all three publish within the same async context, an APM subscribing to all three sees a single correctly-nested span tree — the nesting comes from `AsyncLocalStorage`, not from sharing a channel.

TanStack Start already uses `AsyncLocalStorage` (via `runWithStartContext()` and the H3 event storage), so `TracingChannel`'s async context propagation integrates naturally with the existing context management.

### shouldTrace Helper

```ts
const shouldTrace = (ch) => ch.hasSubscribers !== false;
```

This treats `undefined` (Node 18, where the aggregated `hasSubscribers` is broken) as "trace anyway" and `false` (Node 20+) as "skip". See [Node.js #54470](https://github.com/nodejs/node/issues/54470) for background.

### Redirect and Response Flow Control

TanStack Start uses thrown `Response` objects and redirects as flow control (`isSpecialResponse()` catches `Response` instances and redirects). These are not errors from an observability perspective. The `executeMiddleware` implementation should catch these before they reach TracingChannel's error path:

```ts
try {
  result = await requestChannel.tracePromise(async () => middleware({ ...ctx, next }), traceCtx);
} catch (err) {
  if (isSpecialResponse(err)) {
    ctx.response = err;
    return ctx; // Not an error — TracingChannel's asyncEnd fires normally
  }
  throw err; // Real error — TracingChannel's error channel fires
}
```

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `shouldTrace(channel)` is checked before wrapping anything with `tracePromise`, on all three channels. Silently skipped on runtimes where `TracingChannel` is unavailable.

**`:request` and `:render` (`@tanstack/start-server-core`)** — this is a server-only package that already imports from `node:async_hooks`, so adding `node:diagnostics_channel` introduces no new runtime constraint:

```ts
const dc = require('node:diagnostics_channel');
const requestChannel = dc.tracingChannel('@tanstack/start:request');
const renderChannel = dc.tracingChannel('@tanstack/start:render');
```

TanStack Start targets Node.js 18+, which has `TracingChannel` available (albeit with the `hasSubscribers` quirk on Node 18). Since the package already depends on Node.js built-ins, no `try/catch` or `getBuiltinModule` guard is needed here.

**`:loader` (`@tanstack/router-core`)** — this package is **isomorphic** (ships to browsers and edge runtimes), so it must load `diagnostics_channel` defensively via the cross-runtime guard shown in [the loader insertion point](#insertion-point-route-loaders-tanstackrouterloader). The `getBuiltinModule`-then-`require` pattern is bundler-invisible and the `try/catch` makes it a no-op where the module is absent, so browser bundles are unaffected and pay nothing when no subscriber is attached.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`, traces middleware and route handlers with `type` field) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`nitro`**: [nitrojs/nitro#4001](https://github.com/nitrojs/nitro/pull/4001) ✅ merged
- **`express`**: [pillarjs/router#196](https://github.com/pillarjs/router/pull/196) (`express:request`, traces middleware, handlers, and error handlers with `type` field)
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
- **`mongoose`**: [Automattic/mongoose#16275](https://github.com/Automattic/mongoose/pull/16275) ✅ merged
- **`tedious`**: [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727), issue opened
- **`@prisma/client`**: [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353), issue opened

**Other:**
- **`graphql`**: [graphql/graphql-js#4670](https://github.com/graphql/graphql-js/pull/4670) ✅ merged
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193)
- **`nuxt`**: [nuxt/nuxt#35191](https://github.com/nuxt/nuxt/pull/35191)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
