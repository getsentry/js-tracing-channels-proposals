# knex: `TracingChannel` Proposal

> **Issue:** [knex/knex#6394](https://github.com/knex/knex/issues/6394)
> **Status:** 💬 Issue opened

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `knex`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

### Why Knex-level instrumentation matters (even with driver-level TracingChannel)

As TracingChannel support rolls out across database drivers (`mysql2` ✅ merged, `pg` and others in progress), a natural question arises: does Knex need its own channels if the underlying drivers already emit them?

**Yes — Knex is the only layer that can provide several critical pieces of information:**

1. **Async context bridging.** Knex manages its own connection pool via [tarn.js](https://github.com/vincit/tarn.js). When a query builder is created in one async context but executed after pool acquisition in a *different* async context, driver-level instrumentation loses the parent span. Knex is the only layer that can capture the caller's context at builder creation time and carry it through to execution. This is exactly the problem OTel's `@opentelemetry/instrumentation-knex` solves today via monkey-patching — and the reason it exists alongside driver-level instrumentation.

2. **Structured query metadata without SQL parsing.** Knex knows the operation type (`select`, `insert`, `update`, `del`), the target table, and the query builder method — all as structured data from `builder._method` and `builder._single.table`. Without Knex-level instrumentation, APM tools must parse raw SQL to extract this, which is error-prone and expensive.

3. **Transaction boundaries.** Knex coordinates `BEGIN`/`COMMIT`/`ROLLBACK` sequences and assigns transaction IDs (`__knexTxId`). Driver-level instrumentation sees individual SQL statements with no knowledge that they belong to the same transaction.

4. **Pool-level observability.** Knex's tarn.js pool is invisible to database drivers. Pool acquire time, pool exhaustion, and connection lifecycle are Knex-level concerns that directly impact application performance.

5. **Schema migration context.** Knex's `Migrator` runs migration functions wrapped in transactions. The migration context (which file, batch number, up/down direction) is only available at the Knex level.

### Why TracingChannel over the existing event system

Knex already emits `query`, `query-response`, and `query-error` events via `EventEmitter`. However, APM instrumentation libraries **cannot use these events** for span-based tracing today. Instead, they resort to monkey-patching `Client.prototype.queryBuilder`, `Client.prototype.schemaBuilder`, `Client.prototype.raw`, and `Runner.prototype.query` via IITM/RITM. Here's why:

1. **No async context propagation.** EventEmitter listeners run in the emitter's execution context — not the caller's `AsyncLocalStorage` context. This is explicitly identified as a limitation in [knex#6270](https://github.com/knex/knex/issues/6270): *"Async context is lost in current events, breaking correlation for tracing."*

2. **Split lifecycle.** `query` and `query-response`/`query-error` are separate EventEmitter events. To build a span, APM tools must correlate them via `__knexUid` and manage span storage manually. TracingChannel provides a unified lifecycle for the operation, so correlation is built-in.

3. **No pool visibility.** The existing events cover query execution but not connection pool acquisition, which is often the dominant source of latency in high-traffic applications.

Beyond these APM-specific gaps, the current monkey-patching approach has broader ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `knex` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing — very hard to debug in production.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code into single executables or deployment files.

`TracingChannel` solves all of these. It provides structured lifecycle events (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) with built-in async context propagation, zero-cost when no subscribers are attached, and a standardized subscription model that requires no monkey-patching.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `knex:query` | Query execution — from `Runner.query()` invocation to result/error | `query`, `bindings`, `method`, `table`, `database`, `serverAddress`, `serverPort` |
| `knex:transaction` | Transaction lifecycle — from `BEGIN` to `COMMIT`/`ROLLBACK` | `transactionId`, `database`, `serverAddress`, `serverPort` |
| `knex:pool:acquire` | Pool connection acquisition — from request to acquired connection | `database`, `serverAddress`, `serverPort` |

Plain `diagnostics_channel` (fire-and-forget, no async lifecycle):

| Channel | Tracks | Context fields |
|---|---|---|
| `knex:pool:release` | Connection returned to pool | `database`, `serverAddress`, `serverPort` |

### Why These Channels

- **`knex:query`** is the primary channel. It wraps the full query lifecycle from `Runner.query()` through driver execution to post-processing. This is where Knex adds the most value: structured `method` and `table` fields that driver-level instrumentation cannot provide.
- **`knex:transaction`** wraps the transaction lifecycle. APM tools currently have no way to correlate individual queries into a transaction boundary without Knex-level instrumentation. The `transactionId` maps to Knex's internal `__knexTxId`.
- **`knex:pool:acquire`** tracks connection acquisition from tarn.js. Pool wait time is a critical performance metric — if all connections are in use, queries block here. This is invisible to driver-level instrumentation.
- **`knex:pool:release`** is a plain channel (fire-and-forget) since releasing a connection back to the pool is a synchronous, non-async operation.

### Context Properties

#### Query Channel (`knex:query`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `query` | `obj.sql` — compiled SQL text | `db.query.text` |
| `bindings` | `obj.bindings` — bind parameters (APM serializes/sanitizes) | Parameterized query reconstruction |
| `method` | `builder._method` (`select`, `insert`, `update`, `del`, `raw`, `schema`) | `db.operation.name` |
| `table` | `builder._single.table` | `db.collection.name` |
| `database` | Connection config `database` / `connection.database` | `db.namespace` |
| `serverAddress` | Connection config `host` / `connection.host` | `server.address` |
| `serverPort` | Connection config `port` / `connection.port` | `server.port` |

#### Transaction Channel (`knex:transaction`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `transactionId` | `trx.txid` (Knex's `__knexTxId`) | Transaction correlation |
| `database` | Connection config `database` | `db.namespace` |
| `serverAddress` | Connection config `host` | `server.address` |
| `serverPort` | Connection config `port` | `server.port` |

#### Pool Channels (`knex:pool:acquire`, `knex:pool:release`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `database` | Client config `database` | `db.namespace` |
| `serverAddress` | Client config `host` | `server.address` |
| `serverPort` | Client config `port` | `server.port` |

---

## Implementation Notes

### Insertion Points

Based on Knex's query execution flow:

1. **`knex:query`** — wrap `Runner.prototype.query()` in `lib/execution/runner.js`. This is the single point through which all query execution flows, and where the compiled SQL, bindings, builder metadata, and connection are all available.

2. **`knex:transaction`** — wrap the transaction lifecycle in `lib/execution/transaction.js`. The `start` event fires when `BEGIN` is issued, and `end` fires on `COMMIT`/`ROLLBACK`.

3. **`knex:pool:acquire`** / **`knex:pool:release`** — instrument `Client.prototype.acquireConnection()` and `Client.prototype.releaseConnection()` in `lib/client.js`. These are the pool entry/exit points that delegate to tarn.js.

### Async Context Propagation

The key challenge Knex solves for APM tools is carrying the caller's async context through pool acquisition. The `knex:query` TracingChannel should capture context at the point `Runner.query()` is invoked (after the connection has been acquired), but the *parent* context should be from the original builder creation site. This matches OTel's current approach of storing `api.context.active()` on the builder.

The recommended approach: emit `knex:pool:acquire` when `ensureConnection()` starts (capturing the caller's context), then emit `knex:query` within the pool-acquired callback. TracingChannel's built-in async context propagation will correctly link the query span to the caller's context via the pool acquisition span.

### Relationship to Existing Events

TracingChannel events and existing EventEmitter events serve different purposes and coexist:

| Concern | EventEmitter events (`query`, `query-response`, `query-error`) | TracingChannel |
|---|---|---|
| **Use case** | Application-level monitoring, logging, debugging | APM span-based distributed tracing |
| **Async context** | Not propagated | Automatically propagated |
| **Lifecycle model** | Separate events correlated by `__knexUid` | Unified lifecycle wrapping the full async operation |
| **Pool visibility** | None | `knex:pool:acquire` / `knex:pool:release` |
| **Activation** | Always fires | Zero-cost when no subscribers |

### Relationship to Driver-Level TracingChannel

When both Knex and the underlying driver emit TracingChannel events, APM tools get a layered view:

```
knex:pool:acquire  →  (connection acquired)
  knex:query       →  (method: "select", table: "users")
    pg:query       →  (raw SQL execution on the wire)
  knex:query end
knex:pool:release
```

APM tools can choose to:
- Subscribe to **both layers** for maximum detail (Knex spans as parents, driver spans as children)
- Subscribe to **Knex only** for application-level observability with structured metadata
- Subscribe to **driver only** for raw database-level tracing without the Knex abstraction

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

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
