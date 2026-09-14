# Remix: `TracingChannel` Proposal

> **Issue:** TBD
> **Status:** 📝 Proposal drafted
> **Target package:** `remix` (v3: `remix/fetch-router`, `remix/ui/server`, `remix/assets`)

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Remix 3, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core and adopted by framework peers like [`h3`](https://github.com/h3js/h3/pull/1251), [`fastify`](https://github.com/fastify/fastify), and [`srvx`](https://github.com/h3js/srvx/pull/141).

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly. This is the missing piece that makes monkey-patching approaches fragile in real-world async applications.

Remix 3 is a ground-up rewrite with a new Fetch API-native architecture. There is no existing APM instrumentation for it. This is a rare opportunity to ship TracingChannel support from day one, so APM tools never need to build monkey-patching infrastructure for this framework at all.

Current APM instrumentations for older frameworks use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch framework internals. This has several fragility concerns:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before the framework is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code.

Remix 3 is ESM-only and uses Fetch API primitives throughout. Its architecture is designed to be runtime-agnostic. Monkey-patching this framework would be especially fragile because the router is a pure function composition with no prototype chain to intercept.

If Remix emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Remix 3 Architecture Overview

Remix 3 is a complete rewrite from Remix 2. The framework is built around the Fetch API (`Request`/`Response`) with three subsystems that handle different request types:

### 1. Routing and Middleware (`fetch-router`)

The core routing engine. Creates routers via `createRouter()`, dispatches requests through a koa-compose style middleware cascade, and matches routes to handlers.

- **`RequestContext`**: a mutable context object that carries the request, URL, params, and a typed key-value store through the entire request lifecycle
- **`runMiddleware()`**: the compose function where every middleware and handler executes, structurally identical to koa-compose
- **Controllers/Actions**: user code grouped into typed route handler objects. A controller maps named routes to action handlers, with optional controller-level and per-action middleware.

### 2. Server-Side Rendering (`ui/server`)

A custom component model (not React) that renders to streaming HTML.

- **`renderToStream()`**: walks a component tree, produces a `ReadableStream<Uint8Array>` of HTML
- **Frames**: server-rendered UI segments with a `src` attribute. During SSR, each Frame triggers `resolveFrame()` which calls back into `router.fetch()`, creating nested sub-requests. A single page render can trigger multiple internal router dispatches.
- **Components**: use a function-returning-function pattern. Rendered via `createComponent()` + `handle.render(props)`.

### 3. Asset Serving (`assets`)

An on-demand compilation server for TypeScript/JavaScript and CSS.

- **`createAssetServer()`**: creates an asset server with configurable file mapping, access policies, and compilation options
- **`assetServer.fetch(request)`**: compiles scripts (TS/JS bundling, source maps) and styles (CSS processing) on demand
- Handles fingerprinting, ETag-based caching, 304 responses, and file watching

### End-to-End Request Flow

```
HTTP Request (TCP)
  -> uWebSockets.js (node-serve)
    -> user's server.ts handler
      -> router.fetch(request)
        -> middleware chain (router-level)
        -> route matching
          |
          |-- /assets/* -> handler -> assets.fetch(request)
          |     -> parse pathname, resolve file
          |     -> scriptCompiler.getScript() or styleCompiler.getStyle()
          |     -> compile TS/CSS on demand
          |     -> Response (with ETag, Cache-Control)
          |
          |-- / or /auth -> handler
                -> render(<Component/>, request)
                  -> renderToStream(node, { resolveFrame })
                    -> buildSegment() -- walks component tree
                    -> resolveFrame() -> router.fetch() (sub-request!)
                    -> serialize HTML
                    -> stream pending frames
                  -> Response (HTML stream)
```

---

## Proposed Tracing Channels

Three channels, one per subsystem. Each has a distinct context shape and span-naming strategy.

| TracingChannel | Subsystem | Tracks | Context fields |
|---|---|---|---|
| `remix:request` | fetch-router | Middleware and route handler executions | `type`, `name`, `context` |
| `remix:render` | ui/server | Server-side rendering of component trees | `context` |
| `remix:asset` | assets | On-demand script/style compilation | `filePath`, `assetType` |

### Why Three Channels

Per the convention established across TracingChannel proposals: separate channels when the span-naming strategy or payload shape differs. These three subsystems have fundamentally different contexts:

- **`remix:request`**: HTTP semantics (method, route pattern, middleware names)
- **`remix:render`**: rendering semantics (component tree, frame resolution)
- **`remix:asset`**: compilation semantics (file paths, script vs style)

APMs subscribe to the channels they care about. A minimal integration subscribes only to `remix:request`. A full-featured integration adds `remix:render` and `remix:asset` for deeper performance visibility.

---

## Channel 1: `remix:request`

### Context Properties

| Field | Source | Purpose |
|---|---|---|
| `type` | `"middleware"` or `"handler"` | Distinguishes middleware from matched route handlers |
| `name` | `fn.name` for middleware, or `"GET /users/:id"` for handlers | Span name for APMs |
| `context` | The Remix `RequestContext` object | Full request context |

### What APMs Extract from `context`

| Extracted from `context` | OTel attribute it enables |
|---|---|
| `context.method` | `http.request.method` |
| `context.url.pathname` | `url.path` |
| `context.url.href` | `url.full` |
| `context.url.host` | `server.address` |
| `context.request.headers` | W3C trace context propagation (`traceparent`, `tracestate`), `user_agent.original` |
| `context.params` | Route parameters |
| `context.url.searchParams` | `url.query` |

Response status is extracted from the `Response` returned by the handler on `asyncEnd`.

### Insertion Points

**`runMiddleware()` in `lib/middleware.ts`**: wraps each middleware call with `tracePromise`.

**`dispatchMatches()` in `lib/router.ts`**: wraps matched route handler calls with `tracePromise`, using the matched route pattern for the span name.

### APM Subscriber Example

```js
import dc from 'node:diagnostics_channel';

dc.tracingChannel('remix:request').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(
      ctx.type === 'handler'
        ? `${ctx.context.method} ${ctx.name}`
        : `middleware - ${ctx.name}`,
      {
        kind: ctx.type === 'handler' ? SpanKind.SERVER : SpanKind.INTERNAL,
        attributes: {
          'http.request.method': ctx.context.method,
          'url.path': ctx.context.url.pathname,
          'remix.type': ctx.type,
        },
      },
    );
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});
```

---

## Channel 2: `remix:render`

### Context Properties

| Field | Source | Purpose |
|---|---|---|
| `context` | The `RequestContext` from the handler that initiated rendering | Links the render span to its parent request |

### Insertion Point

**`renderToStream()` in `ui/server/stream.ts`**: wraps the entire render operation. Frame resolution sub-requests naturally appear as nested `remix:request` spans because `resolveFrame()` calls `router.fetch()`.

### Span Nesting

```
remix:request (type: handler) -- GET /
  remix:render                 -- renderToStream
    remix:request (type: handler) -- GET / (frame sub-request)
```

---

## Channel 3: `remix:asset`

### Context Properties

| Field | Source | Purpose |
|---|---|---|
| `filePath` | Resolved file path from URL | Identifies what is being compiled |
| `assetType` | `"script"` or `"style"` | Distinguishes TS/JS compilation from CSS processing |

### Insertion Point

**`assetServer.fetch()` in `lib/asset-server.ts`**: wraps the compilation path. ETag/304 short-circuits happen before the traced section (no compilation work to trace).

---

## Async Context Propagation

Remix 3's async/await cascade is a natural fit for `tracePromise`. The middleware cascade means spans nest automatically:

```
middleware - logger          (start -> asyncEnd)
  middleware - auth          (start -> asyncEnd)
    handler - GET /          (start -> asyncEnd)
      render                 (start -> asyncEnd)
        handler - GET / (frame sub-request, start -> asyncEnd)
  middleware - auth          (asyncEnd fires after downstream completes)
middleware - logger          (asyncEnd fires last)
```

Frame resolution sub-requests go through `router.fetch()`, which dispatches through the full middleware + routing path. TracingChannel's async context propagation ensures these appear as nested child spans.

---

## shouldTrace Helper

```ts
const shouldTrace = (ch: { hasSubscribers?: boolean }) => ch.hasSubscribers !== false
```

`hasSubscribers` is `undefined` on Node 18, where the aggregated getter is missing, so every proposal in this series compares against `false` rather than testing truthiness. Remix 3 requires Node 24, where the getter works, but keeping the same helper shape means the code reads identically to the other implementations and stays correct if Remix ever widens its runtime support.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `shouldTrace(channel)` is checked before constructing context objects or wrapping with `tracePromise`, on all three channels.

These are server-only modules on an ESM-only package that already requires Node 24, where `node:diagnostics_channel` and `TracingChannel` are both stable. So the acquisition is a plain static import, with none of the `getBuiltinModule`/`require` guarding that cross-runtime or Node 18 libraries need:

```ts
import dc from 'node:diagnostics_channel';

const requestChannel = dc.tracingChannel('remix:request');
const renderChannel = dc.tracingChannel('remix:render');
const assetChannel = dc.tracingChannel('remix:asset');
```

If Remix later targets a runtime without `diagnostics_channel`, the guarded pattern used by cross-runtime proposals (`getBuiltinModule` then `require`, wrapped in `try`/`catch`) drops in without changing any emission site.

---

## What Makes Remix 3 Unique for This Proposal

1. **Greenfield opportunity.** No existing APM instrumentation. TracingChannel can be the only observability surface from day one.

2. **Three distinct subsystems.** Unlike Express or Koa (routing only), Remix 3 includes routing, SSR, and asset compilation. Each benefits from tracing independently.

3. **Sub-request architecture.** Frame resolution during SSR creates nested `router.fetch()` calls. TracingChannel's async context propagation makes these visible as child spans automatically.

4. **Closure-based router.** No prototype chain to monkey-patch. External instrumentation without TracingChannel would require proxying closures.

5. **On-demand compilation.** Asset requests involve TypeScript/CSS compilation. Tracing this separately from routing gives APMs visibility into compilation performance.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other libraries:

**Frameworks:**
- **`undici`** (Node.js core): ships `TracingChannel` support since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`, traces middleware and route handlers with a `type` field) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`, `srvx.middleware`) ✅ merged
- **`nitro`**: [nitrojs/nitro#4001](https://github.com/nitrojs/nitro/pull/4001) ✅ merged
- **`nuxt`**: [nuxt/nuxt#35191](https://github.com/nuxt/nuxt/pull/35191) (`nuxt.render`, `nuxt.island`, `nuxt.data`, `nuxt.plugin`) ✅ merged & released (v4.5.0)
- **`express`**: [pillarjs/router#196](https://github.com/pillarjs/router/pull/196) (`express:request`, traces middleware, handlers, and error handlers with a `type` field), PR open
- **`hono`**: [honojs/hono#4842](https://github.com/honojs/hono/issues/4842), issue opened
- **`elysia`**: [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809), in discussion
- **`@tanstack/start`**: [TanStack/router#7604](https://github.com/TanStack/router/discussions/7604), discussion open
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
- **`ai`** (Vercel AI SDK): [vercel/ai#15660](https://github.com/vercel/ai/pull/15660) ✅ merged & released (v7.0.0), ships the `ai:telemetry` TracingChannel
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193) ✅ merged & released (v0.4.0)
- **`pino`**: [pinojs/pino#2281](https://github.com/pinojs/pino/pull/2281) ✅ merged & released (v9.10.0)

---

Would love to hear your thoughts on the channel design and context shape. Happy to put together a PR with the implementation.
