# tedious: `TracingChannel` Proposal

> **Status:** Draft (not yet submitted)

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `tedious`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

The tedious driver already provides operational visibility through a rich `EventEmitter` API — `Connection` emits `connect`, `end`, `error`, `databaseChange`, and `debug` events, while `Request` emits `row`, `done`, `doneInProc`, `doneProc`, and `requestCompleted`. However, APM instrumentation libraries (OpenTelemetry, Datadog, Sentry) **cannot use these events** for span-based tracing today. Instead, they resort to monkey-patching `Connection.prototype.execSql`, `Connection.prototype.callProcedure`, and other methods via IITM/RITM. Here's why:

1. **No async context propagation.** EventEmitter listeners run in the emitter's execution context — not the caller's `AsyncLocalStorage` context. APM tools need to create child spans of the caller's span, which requires capturing the async context at the call site. EventEmitter listeners lose this context.

2. **Split lifecycle.** The `Request` callback and its `done`/`doneProc`/`error` events are separate. To build a span, APM tools must wrap the original callback and attach additional event listeners to count statements and procedures. TracingChannel provides a unified lifecycle for the operation, so correlation is built-in.

3. **Multiple interception points.** OTel currently patches 6 separate methods on `Connection.prototype` (`execSql`, `execSqlBatch`, `callProcedure`, `execBulkLoad`, `prepare`, `execute`) plus the `connect` method for database name tracking. Each patch must independently handle callback wrapping, context propagation, and error handling. Native TracingChannel support consolidates this into structured event emission at the source.

Beyond these APM-specific gaps, the current monkey-patching approach has broader ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `tedious` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing — very hard to debug in production.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code into single executables or deployment files.

`TracingChannel` solves all of these. It provides structured lifecycle events (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) with built-in async context propagation, zero-cost when no subscribers are attached, and a standardized subscription model that requires no monkey-patching.

The driver's existing EventEmitter events remain valuable for operational monitoring, row streaming, and debugging. `TracingChannel` is not a replacement — it's a complement that fills the specific gaps APM tools need for span-based distributed tracing.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `tedious:query` | `execSql()` and `execSqlBatch()` — standard SQL execution | `query`, `database`, `serverAddress`, `serverPort` |
| `tedious:callProcedure` | `callProcedure()` — stored procedure execution | `procedure`, `database`, `serverAddress`, `serverPort` |
| `tedious:bulkLoad` | `execBulkLoad()` — bulk insert operations | `table`, `database`, `serverAddress`, `serverPort` |
| `tedious:prepare` | `prepare()` — prepared statement creation | `query`, `database`, `serverAddress`, `serverPort` |
| `tedious:execute` | `execute()` — prepared statement execution | `query`, `values`, `database`, `serverAddress`, `serverPort` |
| `tedious:connect` | Connection establishment lifecycle | `database`, `serverAddress`, `serverPort`, `user` |

### Why Separate Channels for Query Operations

Unlike MySQL2 which has two execution methods (`query` and `execute`), tedious has five distinct operations with meaningfully different semantics:

- **`execSql` / `execSqlBatch`** are grouped into `tedious:query` — both execute SQL text, the difference is only in parameterization support. APM tools treat them identically.
- **`callProcedure`** gets its own channel because stored procedures have a procedure name rather than SQL text, and the span naming strategy differs (procedure name is low-cardinality and safe to include in span names).
- **`execBulkLoad`** gets its own channel because it operates on a table name with no SQL text, and has unique semantics (streaming rows into the server).
- **`prepare` / `execute`** are separated because they represent two distinct phases of the prepared statement lifecycle — creation (which has the SQL text) and execution (which has the parameter values).

### Context Properties

The payload maps to what OTEL currently extracts via monkey-patching in [`@opentelemetry/instrumentation-tedious`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-tedious), making migration straightforward:

#### Query Channel (`tedious:query`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `query` | `request.sqlTextOrProcedure` | `db.query.text` |
| `database` | Current database (tracked via `databaseChange` event) | `db.namespace` |
| `serverAddress` | `config.server` | `server.address` |
| `serverPort` | `config.options.port` | `server.port` |

#### Stored Procedure Channel (`tedious:callProcedure`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `procedure` | `request.sqlTextOrProcedure` (procedure name) | `db.operation.name` |
| `database` | Current database | `db.namespace` |
| `serverAddress` | `config.server` | `server.address` |
| `serverPort` | `config.options.port` | `server.port` |

#### Bulk Load Channel (`tedious:bulkLoad`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `table` | `bulkLoad.table` | `db.collection.name` |
| `database` | Current database | `db.namespace` |
| `serverAddress` | `config.server` | `server.address` |
| `serverPort` | `config.options.port` | `server.port` |

#### Prepared Statement Channels (`tedious:prepare`, `tedious:execute`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `query` | SQL text from `prepare()` call / `parametersByName.stmt.value` | `db.query.text` |
| `values` | Parameter values (execute only, APM serializes/sanitizes) | Parameterized query reconstruction |
| `database` | Current database | `db.namespace` |
| `serverAddress` | `config.server` | `server.address` |
| `serverPort` | `config.options.port` | `server.port` |

#### Connect Channel (`tedious:connect`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `database` | `config.options.database` | `db.namespace` |
| `serverAddress` | `config.server` | `server.address` |
| `serverPort` | `config.options.port` | `server.port` |
| `user` | `config.authentication.options.userName` | `db.user` |

---

## Implementation Notes

### Callback-Based Async Model

Tedious uses a callback-based async model with single-request-per-connection semantics. All query operations flow through the internal `makeRequest()` method. `TracingChannel.traceCallback` is the appropriate wrapper:

```js
// Conceptual — wrapping at the makeRequest() level
const tracedMakeRequest = queryChannel.traceCallback(originalMakeRequest, position, context, thisArg);
```

Alternatively, each public method (`execSql`, `callProcedure`, etc.) can be individually wrapped to provide operation-specific context.

### Database Name Tracking

The current database can change mid-connection via `USE <database>` statements. Tedious already emits a `databaseChange` event when this happens. The TracingChannel context should reflect the **current** database at the time of each operation, matching the existing OTel instrumentation's approach of tracking `databaseChange` events.

### Relationship to Existing EventEmitter Events

TracingChannel events and existing EventEmitter events serve different purposes and coexist:

| Concern | EventEmitter events | TracingChannel |
|---|---|---|
| **Use case** | Row streaming, result counting, operational monitoring | APM span-based distributed tracing |
| **Async context** | Not propagated | Automatically propagated |
| **Lifecycle model** | Separate events (`done`, `doneProc`, `error`) | Unified lifecycle wrapping the full async operation |
| **Activation** | Always available | Always available, zero-cost when unused |

---

## Backward Compatibility

Zero-cost when no subscribers are registered — `hasSubscribers` is checked before constructing any context objects. Silently skipped on Node.js versions where `TracingChannel` is unavailable.

Since tedious already requires Node.js >= 18.17, `diagnostics_channel` is always available. `TracingChannel` was added in Node 19.9 / backported to 18.19, so the vast majority of tedious users will have full support.

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
- **`mongodb`** — proposal under discussion (`mongodb:command`, `mongodb:connect`, `mongodb:pool:checkout`)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
