# dataloader: `TracingChannel` Proposal

> **Issue:** [graphql/dataloader#393](https://github.com/graphql/dataloader/issues/393)
> **Status:** 💬 Issue opened

---

I'd like to propose first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support in `dataloader`, following [`undici`](https://github.com/nodejs/undici) in Node.js core and its sibling in the GraphQL org, [`graphql-js`](https://github.com/graphql/graphql-js/pull/4670).

`TracingChannel` is built on `diagnostics_channel` for tracing async operations. It exposes structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and propagates async context correctly, which is what makes monkey-patching fragile in real-world async code.

## Motivation

DataLoader is on the hot path of nearly every GraphQL server, and it has no built-in instrumentation. So every APM monkey-patches it: `@opentelemetry/instrumentation-dataloader` patches `load`, `loadMany`, `prime`, `clear`, and `clearAll` on the prototype, plus wraps the `DataLoader` constructor to intercept the user's `batchLoadFn` and trace batch dispatch. Datadog and Sentry do the same. The usual fragility applies:

- **Runtime lock-in:** RITM/IITM rely on Node.js module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno.
- **ESM fragility:** IITM depends on Node's evolving module hooks, a persistent source of breakage in OTEL JS.
- **Initialization ordering:** patching must happen before `dataloader` is first imported, or instrumentation silently no-ops.
- **Bundling:** instrumented modules must stay externalized, which is hard when frameworks bundle server code into single files.

There's a DataLoader-specific cost too. Batching decouples `load(key)` from the eventual `batchLoadFn([...keys])` across an async boundary, so the OTel patch wraps the user's `batchLoadFn`, stashes per-key span contexts on the internal `_batch`, and rebuilds the load-to-batch link graph by hand. Native emission removes all of it: the engine knows exactly when a batch is scheduled, which keys it holds, and when the promise settles.

With `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**: independent, order-free, and with no dependency on internals like `_batch`.

---

## Proposed Tracing Channels

Async operations use [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) (`start`, `end`, `asyncStart`, `asyncEnd`, `error`). Synchronous cache operations use plain `diagnostics_channel` point events.

### Async operations (`TracingChannel`, `tracePromise`)

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `dataloader:load` | `load(key)` to per-key resolution/error | `name`, `key` |
| `dataloader:loadMany` | `loadMany(keys)` to settled array | `name`, `keys` |
| `dataloader:batch` | `batchLoadFn(keys)` dispatch until its promise settles | `name`, `keys`, `batchSize` |

### Cache operations (plain point events)

Synchronous and fire-and-forget. Included for parity with the spans OTel emits today.

| Channel | Tracks | Context fields |
|---|---|---|
| `dataloader:prime` | `prime(key, value)` | `name`, `key` |
| `dataloader:clear` | `clear(key)` | `name`, `key` |
| `dataloader:clearAll` | `clearAll()` | `name` |

### Why these channels

- **`dataloader:batch`** is primary: it wraps the actual backend I/O, and `batchSize` exposes coalescing efficiency (all-1 batches usually signal a batching bug).
- **`dataloader:load`** is the user-facing entry point and a distinct lifecycle (a cache hit resolves without a batch). It's the noisiest channel; subscribers filter on their side.
- **`dataloader:loadMany`** has a distinct payload (`keys` vs `key`) and span name. It delegates to N `load()` calls, so `dataloader:load` events nest under it, parented automatically by async context.
- **`prime` / `clear` / `clearAll`** are low-cost point events for OTel parity.

### Context Properties

DataLoader isn't a database client, so there's no DB semantic-convention mapping. OTel sets no semconv attributes either; it derives everything from span name, status, and load-to-batch links. The context below covers at least what OTel extracts.

| Field | Source | What it enables |
|---|---|---|
| `name` | `name` constructor option | Span naming, e.g. `dataloader.load userById`. DataLoader documents `name` as "for monitoring/tracing tools." |
| `key` | Key passed to `load()` / `prime()` / `clear()` | Per-key detail (APM serializes/sanitizes) |
| `keys` | `loadMany()` keys, or the batch's accumulated keys | Batch contents (APM serializes/sanitizes) |
| `batchSize` | `keys.length` on the dispatched batch | Batching efficiency |

The loader instance is the natural `thisArg`, so subscribers can read extra state (`maxBatchSize`, `batch`/`cache` flags) without pre-extracting it into every context.

---

## How APM Tools Use This

### Today: patch 5 prototype methods + wrap the user's `batchLoadFn`

```js
// Simplified from @opentelemetry/instrumentation-dataloader
wrap(DataLoader.prototype, 'constructor', /* intercept the user batchLoadFn */);
wrap(DataLoader.prototype, 'load', original => function patchedLoad(key) {
  const span = tracer.startSpan(getSpanName(this, 'load'));
  // push spanContext into this._batch.spanLinks so the batch span can link back
  return context.with(/* ... */, () => original.call(this, key));
});
wrap(DataLoader.prototype, 'loadMany', /* ... */);
wrap(DataLoader.prototype, 'prime', /* ... */);
wrap(DataLoader.prototype, 'clear', /* ... */);
wrap(DataLoader.prototype, 'clearAll', /* ... */);
// batch span created inside the wrapped batchLoadFn, links rebuilt from captured contexts
```

Depends on prototype shapes, the internal `_batch`, and the constructor signature, and must install before first import.

### With TracingChannel: subscribe to structured events

```js
const dc = require('node:diagnostics_channel');

dc.tracingChannel('dataloader:batch').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(
      ctx.name ? `dataloader.batch ${ctx.name}` : 'dataloader.batch',
      { attributes: { 'dataloader.batch.size': ctx.batchSize } },
    );
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});

dc.tracingChannel('dataloader:load').subscribe({
  start(ctx) { ctx.span = tracer.startSpan(ctx.name ? `dataloader.load ${ctx.name}` : 'dataloader.load'); },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});

dc.channel('dataloader:clearAll').subscribe(ctx => { /* counter / annotate active span */ });
```

| Concern | Monkey-patching | TracingChannel |
|---|---|---|
| **Setup** | Intercept module load before first `require('dataloader')` | Subscribe any time, no ordering |
| **Scope** | 5 prototype methods + constructor + user `batchLoadFn` | Subscribe to channels |
| **Load → batch linkage** | Capture per-key context on `_batch`, rebuild links by hand | Async context handles parenting |
| **Internal coupling** | Depends on `_batch` + constructor signature | Stable channel contract |
| **Teardown** | Re-wrap/unwrap prototype | `unsubscribe()` |
| **Runtime** | Node.js only | Any runtime with `diagnostics_channel` |

---

## Implementation Notes

- **`dataloader:batch`** wraps `loader._batchLoadFn(batch.keys)` in `dispatchBatch()`. DataLoader already does `Promise.resolve(...)` on the return, so `tracePromise` wraps a native promise and won't break a non-native thenable. The dispatch is fire-and-forget (results route to per-key callbacks; nobody awaits it), so the traced wrapper needs `.catch(noop)` to avoid an unhandled rejection under `--unhandled-rejections=throw`. Per-key errors still propagate to each `load()` caller.
- **`dataloader:load`** wraps the `load(key)` promise. A cache hit settles without a batch: the load span just has no child batch span.
- **`dataloader:loadMany`** wraps `loadMany(keys)`; nested `dataloader:load` events are expected and parented automatically.
- **Cache events** (`prime`, `clear`, `clearAll`) use `channel.publish(...)` since they're synchronous.
- **Zero cost:** gate every emission on `hasSubscribers` (a `shouldTrace` helper) before building context, so the hot `load()` path allocates nothing when no APM listens. The aggregated `hasSubscribers` is `undefined` on Node 18; treat `undefined` as "trace anyway" and skip only on explicit `false`.

---

## Backward Compatibility

Fully backward compatible and zero-cost with no subscribers. DataLoader is isomorphic (runs in browsers, falling back from `process.nextTick` to `setImmediate`/`setTimeout`) with zero dependencies. The acquisition snippet preserves that: no static Node import, and `try/catch` swallows failure in browsers or any runtime without `diagnostics_channel`. When `dc` is undefined, every emission site short-circuits.

```js
let dc;
try {
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    dc = process.getBuiltinModule('node:diagnostics_channel');
  }
  if (!dc) {
    dc = require('node:diagnostics_channel');
  }
} catch {}
```

- `typeof process` guard: safe in browsers and edge runtimes.
- `getBuiltinModule`: bundler-invisible, works in Node 22.3+, Deno, Bun 1.2.7+, Cloudflare Workers.
- `require` fallback: older Node, Bun, Workers (`nodejs_compat`).
- `try/catch`: swallows the error where `diagnostics_channel` is absent.

`TracingChannel` paths are skipped where `dc.tracingChannel` is unavailable (Node 16); plain `dc.channel()` point events work on Node 16+.

---

## Prior Art

This follows the pattern adopted or in progress across the ecosystem:

**Frameworks:**
- **`undici`** (Node.js core): `TracingChannel` since Node 20.12 ([`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels))
- **`fastify`**: native (`tracing:fastify.request.handler`)
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) ✅ merged
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) ✅ merged
- **`nitro`**: [nitrojs/nitro#4001](https://github.com/nitrojs/nitro/pull/4001) ✅ merged
- **`express`**: [pillarjs/router#196](https://github.com/pillarjs/router/pull/196)
- **`elysia`**: [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809)
- **`hono`**: [honojs/hono#4842](https://github.com/honojs/hono/issues/4842)
- **`koa`**: proposal drafted
- **`@tanstack/start`**: [TanStack/router#7604](https://github.com/TanStack/router/discussions/7604)

**Databases:**
- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) ✅ merged
- **`node-redis`**: [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) ✅ merged
- **`ioredis`**: [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) ✅ merged
- **`pg` / `pg-pool`**: [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650)
- **`knex`**: [knex/knex#6410](https://github.com/knex/knex/pull/6410)
- **`mongodb`**: [NODE-7472](https://jira.mongodb.org/browse/NODE-7472), under discussion
- **`mongoose`**: [Automattic/mongoose#16275](https://github.com/Automattic/mongoose/pull/16275) ✅ merged
- **`tedious`**: [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727)
- **`@prisma/client`**: [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353)

**Other:**
- **`graphql`**: [graphql/graphql-js#4670](https://github.com/graphql/graphql-js/pull/4670) ✅ merged (sibling project in the GraphQL org)
- **`unstorage`**: [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`**: [unjs/db0#193](https://github.com/unjs/db0/pull/193)
- **`nuxt`**: [nuxt/nuxt#35191](https://github.com/nuxt/nuxt/pull/35191)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
