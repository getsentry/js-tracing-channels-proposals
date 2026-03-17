# mongoose: `TracingChannel` Proposal

> **Issue:** [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105)
> **Status:** 💬 Issue opened

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `mongoose`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

### Why Mongoose-level instrumentation matters (even with driver-level TracingChannel)

As TracingChannel support is [proposed for the MongoDB Node.js driver](https://jira.mongodb.org/browse/NODE-7472), a natural question arises: does Mongoose need its own channels if the underlying driver will eventually emit them?

**Yes — Mongoose is the only layer that can provide several critical pieces of information:**

1. **Structured operation metadata without command parsing.** Mongoose knows the operation type (`find`, `updateOne`, `deleteMany`, `aggregate`), the target collection, and the query filter — all as structured data from the Query and Aggregate objects. Without Mongoose-level instrumentation, APM tools must parse raw MongoDB wire protocol commands to extract this, which is error-prone and loses the semantic intent of the operation.

2. **Model-level context.** Mongoose operations carry model metadata (model name, schema) that the driver layer has no knowledge of. APM tools currently extract this via monkey-patching to produce span names like `find users` rather than opaque `find` commands.

3. **Document lifecycle visibility.** Operations like `Model.prototype.save()` involve validation, middleware execution, and conditional insert-or-update logic that the driver sees as a single `insertOne` or `replaceOne` command. Mongoose-level instrumentation captures the full semantic operation.

4. **Bulk operation semantics.** `Model.insertMany()` and `Model.bulkWrite()` are Mongoose-level operations with validation, middleware, and error handling that the driver sees as raw `insertMany`/`bulkWrite` commands.

### Why TracingChannel over the existing hook system

Mongoose has a powerful pre/post middleware (hook) system via [kareem](https://github.com/vkarpov15/kareem) that covers document, query, aggregate, and model operations. However, APM instrumentation libraries **cannot use these hooks** for span-based tracing today. Instead, they resort to monkey-patching `Query.prototype.exec`, `Aggregate.prototype.exec`, `Model.prototype.save`, and 12+ other methods via IITM/RITM. Here's why:

1. **No async context propagation.** Mongoose hooks run in the middleware chain's execution context — not the caller's `AsyncLocalStorage` context. This is a documented pain point: [#10020](https://github.com/Automattic/mongoose/issues/10020) reported post-hooks not working with `AsyncLocalStorage`, and [#10478](https://github.com/Automattic/mongoose/issues/10478) identified the root cause as an underlying library issue where async context is lost across the hook chain. While these issues have been resolved, they illustrate that async context propagation through the middleware system has been a persistent challenge — and it's exactly the problem `TracingChannel` was designed to solve at the platform level.

2. **Per-schema registration.** Hooks must be registered on each schema individually. APM tools need global instrumentation that covers all models without requiring user configuration. There's no single attachment point for cross-cutting tracing concerns.

3. **No lifecycle correlation.** Pre and post hooks are separate middleware functions. To build a span, APM tools would need to correlate the pre-hook (span start) with the post-hook (span end) and manage span storage manually. `TracingChannel` provides a unified lifecycle for the operation, so correlation is built-in.

Beyond these APM-specific gaps, the current monkey-patching approach has broader ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `mongoose` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing — very hard to debug in production.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code into single executables or deployment files.

`TracingChannel` solves all of these. It provides structured lifecycle events (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) with built-in async context propagation, zero-cost when no subscribers are attached, and a standardized subscription model that requires no monkey-patching.

Mongoose's existing hook system remains valuable for application-level middleware, validation, and domain logic. `TracingChannel` is not a replacement — it's a complement that fills the specific gaps APM tools need for span-based distributed tracing.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `mongoose:query` | All `Query.exec()` operations — find, update, delete, count, distinct, etc. | `operation`, `collection`, `query`, `fields`, `options`, `database`, `serverAddress`, `serverPort` |
| `mongoose:aggregate` | `Aggregate.exec()` pipeline execution | `pipeline`, `collection`, `options`, `database`, `serverAddress`, `serverPort` |
| `mongoose:save` | `Model.prototype.save()` — document insert or update | `operation`, `collection`, `database`, `serverAddress`, `serverPort` |
| `mongoose:model` | Model-level statics — `insertMany`, `bulkWrite` | `operation`, `collection`, `database`, `serverAddress`, `serverPort` |

### Why These Channels

- **`mongoose:query`** is the primary channel. All query operations flow through `Query.prototype.exec()` — this is exactly the method OTel monkey-patches today. The channel provides structured `operation` and `collection` fields that eliminate the need to parse MongoDB commands.
- **`mongoose:aggregate`** gets its own channel because aggregation pipelines have a fundamentally different payload shape (pipeline stages array vs query filter/projection) and different span naming considerations.
- **`mongoose:save`** covers `Model.prototype.save()`, which the OTel instrumentation patches separately from `Query.exec()`. Save involves conditional insert-or-update logic that the driver can't distinguish.
- **`mongoose:model`** covers `Model.insertMany()` and `Model.bulkWrite()` with an `operation` discriminator field. These share the same payload shape and span naming strategy (`{operation} {collection}`).

### Context Properties

The payload maps to what OTEL currently extracts via monkey-patching in [`@opentelemetry/instrumentation-mongoose`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-mongoose), making migration straightforward:

#### Query Channel (`mongoose:query`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `operation` | `query.op` (e.g. `find`, `findOne`, `updateOne`, `deleteMany`, `countDocuments`, `distinct`) | `db.operation.name` |
| `collection` | `query.mongooseCollection.name` | `db.collection.name` |
| `query` | Query filter/conditions object (APM serializes/sanitizes) | `db.query.text` |
| `fields` | Projection fields | Query reconstruction |
| `options` | Query options (sort, limit, skip, etc.) | Query reconstruction |
| `database` | Connection database name | `db.namespace` |
| `serverAddress` | Connection host | `server.address` |
| `serverPort` | Connection port | `server.port` |

#### Aggregate Channel (`mongoose:aggregate`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `pipeline` | `aggregate._pipeline` (array of pipeline stages, APM serializes/sanitizes) | `db.query.text` |
| `collection` | `aggregate._model.collection.name` | `db.collection.name` |
| `options` | Aggregation options | Query reconstruction |
| `database` | Connection database name | `db.namespace` |
| `serverAddress` | Connection host | `server.address` |
| `serverPort` | Connection port | `server.port` |

#### Save Channel (`mongoose:save`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `operation` | `save` (always — distinguishes from query operations at the APM level) | `db.operation.name` |
| `collection` | `doc.constructor.collection.name` | `db.collection.name` |
| `database` | Connection database name | `db.namespace` |
| `serverAddress` | Connection host | `server.address` |
| `serverPort` | Connection port | `server.port` |

#### Model Channel (`mongoose:model`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `operation` | `insertMany` or `bulkWrite` | `db.operation.name` |
| `collection` | `Model.collection.name` | `db.collection.name` |
| `database` | Connection database name | `db.namespace` |
| `serverAddress` | Connection host | `server.address` |
| `serverPort` | Connection port | `server.port` |

---

## How APM Tools Use This

### Today: Monkey-Patching 15+ Methods

To instrument Mongoose today, `@opentelemetry/instrumentation-mongoose` uses IITM/RITM to intercept the module and patch prototypes:

```js
// Simplified from @opentelemetry/instrumentation-mongoose (500+ LOC)

// 1. Patch the core execution path
wrap(Query.prototype, 'exec', original => function patchedExec() {
  const span = tracer.startSpan(`${this.op} ${this.mongooseCollection.name}`);
  span.setAttribute('db.operation.name', this.op);
  span.setAttribute('db.collection.name', this.mongooseCollection.name);
  span.setAttribute('db.namespace', this.db?.name);
  // ... more attributes ...
  return context.with(trace.setSpan(context.active(), span), () => {
    return original.apply(this, arguments)
      .then(result => { span.end(); return result; })
      .catch(err => { span.setStatus({ code: SpanStatusCode.ERROR }); span.end(); throw err; });
  });
});

// 2. Patch 12+ Query methods JUST for context capture (not span creation)
//    because await query.find() loses the parent span context
for (const method of ['find', 'findOne', 'updateOne', 'deleteMany', 'countDocuments', ...]) {
  wrap(Query.prototype, method, original => function patched() {
    this[STORED_PARENT_SPAN] = trace.getSpan(context.active());
    return original.apply(this, arguments);
  });
}

// 3. Patch Model.prototype.save and $save (must re-alias after patching)
wrap(Model.prototype, 'save', original => function patchedSave() { /* span logic */ });
Model.prototype.$save = Model.prototype.save; // re-alias

// 4. Patch Model.prototype.updateOne/deleteOne (mongoose >=8.21.0 only)
wrap(Model.prototype, 'updateOne', original => function patched() { /* span + dedup logic */ });
wrap(Model.prototype, 'deleteOne', original => function patched() { /* span + dedup logic */ });

// 5. Patch Model statics
wrap(Model, 'aggregate', original => function patched() { /* context capture */ });
wrap(Model, 'insertMany', original => function patched() { /* span logic */ });
wrap(Model, 'bulkWrite', original => function patched() { /* span logic */ });

// 6. Deduplication: prevent double-spans when doc.updateOne() creates a Query
//    that also flows through the patched exec()
const ALREADY_INSTRUMENTED = Symbol('already_instrumented');
```

This approach requires version-specific branching (v5/v6 patch `remove` and `count`, v7 drops them, v8+ adds `updateOne`/`deleteOne`), re-aliasing `$save` after patching, and a deduplication symbol to prevent double-spanning. It breaks if Mongoose renames or refactors any of these internal methods.

### With TracingChannel: Subscribe to Structured Events

With native TracingChannel support, the same APM tool becomes a **subscriber** instead of a **patcher**:

```js
const dc = require('node:diagnostics_channel');

// Subscribe to query operations — covers ALL find/update/delete/count variants
dc.tracingChannel('mongoose:query').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`${ctx.operation} ${ctx.collection}`, {
      attributes: {
        'db.system': 'mongodb',
        'db.operation.name': ctx.operation,
        'db.collection.name': ctx.collection,
        'db.query.text': sanitize(ctx.query),
        'db.namespace': ctx.database,
        'server.address': ctx.serverAddress,
        'server.port': ctx.serverPort,
      },
    });
    // TracingChannel automatically propagates this span as the active context
    // through the entire async operation — no manual context.with() needed
  },
  asyncEnd(ctx) {
    // asyncEnd fires after the promise resolves — this is where the span ends
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});

// Subscribe to aggregation — same pattern, different payload
dc.tracingChannel('mongoose:aggregate').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`aggregate ${ctx.collection}`, {
      attributes: {
        'db.system': 'mongodb',
        'db.operation.name': 'aggregate',
        'db.collection.name': ctx.collection,
        'db.query.text': sanitize(ctx.pipeline),
        'db.namespace': ctx.database,
        'server.address': ctx.serverAddress,
        'server.port': ctx.serverPort,
      },
    });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});

// Subscribe to save and model operations — same pattern
dc.tracingChannel('mongoose:save').subscribe({ /* start, asyncEnd, error */ });
dc.tracingChannel('mongoose:model').subscribe({ /* start, asyncEnd, error */ });
```

**What changes for APM vendors:**

| Concern | Monkey-patching (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Must intercept module load via IITM/RITM before first `require('mongoose')` | Subscribe to `diagnostics_channel` at any time — no ordering constraint |
| **Scope** | Patch 15+ methods across Query, Model, Aggregate prototypes | Subscribe to 4 channels |
| **Context propagation** | Manual `context.with()` wrapping + `STORED_PARENT_SPAN` symbol hack | Built-in — TracingChannel propagates `AsyncLocalStorage` context automatically |
| **Version coupling** | Version-specific branches (v5/v6/v7/v8+), breaks on internal refactors | Stable channel contract — Mongoose can refactor internals freely |
| **Deduplication** | `ALREADY_INSTRUMENTED` symbol to prevent double-spans from doc→query flow | Not needed — Mongoose emits from the right place, once |
| **Runtime support** | Node.js only (IITM/RITM don't work on Bun/Deno) | Any runtime with `diagnostics_channel` support |

---

## Implementation Notes

### Insertion Points

Based on Mongoose's query execution flow:

1. **`mongoose:query`** — wrap `Query.prototype.exec()` in `lib/query.js`. This is the single point through which all query operations flow, and where the operation name, collection, filter, and connection are all available. This is exactly the method `@opentelemetry/instrumentation-mongoose` patches today.

2. **`mongoose:aggregate`** — wrap `Aggregate.prototype.exec()` in `lib/aggregate.js`. Same pattern — single execution entry point for all aggregation pipelines.

3. **`mongoose:save`** — wrap `Model.prototype.save()` in `lib/model.js`. The OTel instrumentation patches both `save` and `$save` (which is an alias); wrapping at the implementation level avoids needing to patch both.

4. **`mongoose:model`** — wrap `Model.insertMany()` and `Model.bulkWrite()` in `lib/model.js`.

### Async Context Propagation

Mongoose operations are promise-based — `Query.exec()`, `Aggregate.exec()`, and `Model.save()` all return Promises. `TracingChannel.tracePromise` is the appropriate wrapper:

```js
// Conceptual — wrapping Query.exec()
if (shouldTrace(queryChannel)) {
  return queryChannel.tracePromise(originalExec, {
    operation: this.op,
    collection: this.mongooseCollection.name,
    query: this.getFilter(),
    fields: this._fields,
    options: this._mongooseOptions,
    database: this.db?.name,
    serverAddress: this.db?.host,
    serverPort: this.db?.port,
  });
}
```

### Avoiding Double-Instrumentation

The OTel instrumentation uses an `_ALREADY_INSTRUMENTED` symbol to prevent double-spanning when document-level `updateOne()`/`deleteOne()` creates a Query that also calls `exec()`. The TracingChannel implementation should use the same approach — or better, emit only from `Query.exec()` and let document-level methods flow through naturally.

### Relationship to Existing Hook System

TracingChannel events and Mongoose's pre/post hooks serve different purposes and coexist:

| Concern | Pre/post hooks (middleware) | TracingChannel |
|---|---|---|
| **Use case** | Application logic, validation, data transformation | APM span-based distributed tracing |
| **Async context** | Historically problematic ([#10020](https://github.com/Automattic/mongoose/issues/10020), [#10478](https://github.com/Automattic/mongoose/issues/10478)) | Automatically propagated by design |
| **Registration** | Per-schema, must be configured by application code | Global `diagnostics_channel` subscription |
| **Lifecycle model** | Separate pre/post functions | Unified lifecycle wrapping the full async operation |
| **Activation** | Always runs when registered | Zero-cost when no subscribers |

### Relationship to Driver-Level TracingChannel

When both Mongoose and the MongoDB driver emit TracingChannel events, APM tools get a layered view:

```
mongoose:query      →  (operation: "find", collection: "users", query: { age: { $gt: 18 } })
  mongodb:command   →  (commandName: "find", command: { find: "users", filter: { age: { $gt: 18 } } })
mongoose:query end
```

APM tools can choose to:
- Subscribe to **both layers** for maximum detail (Mongoose spans as parents, driver spans as children)
- Subscribe to **Mongoose only** for application-level observability with structured metadata
- Subscribe to **driver only** for raw database-level tracing without the Mongoose abstraction

---

## Backward Compatibility

Zero-cost when no subscribers are registered — `hasSubscribers` is checked before constructing any context objects. Silently skipped on Node.js versions where `TracingChannel` is unavailable.

```ts
const dc = ('getBuiltinModule' in process)
  ? process.getBuiltinModule('node:diagnostics_channel')
  : require('node:diagnostics_channel');
```

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other major libraries:

- **`undici`** (Node.js core) — ships `TracingChannel` support since Node 20.12: [`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels)
- **`node-redis`** — [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`)
- **`ioredis`** — [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)
- **`pg` / `pg-pool`** — [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)
- **`mysql2`** — [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`mongodb`** — [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) — proposal under discussion (`mongodb:command`, `mongodb:connect`, `mongodb:pool:checkout`)
- **`tedious`** — [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727) — proposal under discussion
- **`knex`** — [knex/knex#6394](https://github.com/knex/knex/issues/6394) — issue opened (`knex:query`, `knex:transaction`, `knex:pool:acquire`)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
