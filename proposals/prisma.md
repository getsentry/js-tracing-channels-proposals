# @prisma/client: `TracingChannel` Proposal

> **Status:** Draft (not yet submitted)

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `@prisma/client`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

### Prisma's tracing story today — and the gap TracingChannel fills

Prisma is ahead of most libraries in this space: `@prisma/instrumentation` provides first-party OpenTelemetry tracing **without monkey-patching**, using a contract-based architecture where the instrumentation package sets a global `TracingHelper` and the Prisma Client runtime checks for it internally. This is a clean design — no IITM/RITM, no prototype patching, no module loader hacks.

However, this architecture is **tightly coupled to the OpenTelemetry SDK**. `@prisma/instrumentation` depends on `@opentelemetry/instrumentation` (^0.207.0) and peer-depends on `@opentelemetry/api` (^1.8). APM tools that don't use the OTel SDK — Datadog's native tracer, Sentry's performance SDK, Elastic APM, custom in-house tracing — cannot subscribe to Prisma's internal operations without either:

1. Adopting the full OTel SDK just to get Prisma spans, or
2. Reimplementing the `TracingHelper` contract privately (fragile, undocumented)

#### Why reimplementing the contract isn't viable

A natural question is: can a non-OTel APM tool simply implement the `TracingHelper` interface from `@prisma/instrumentation-contract` and set the global helper itself? In theory yes, but in practice this path has significant drawbacks:

- **Undocumented internal contract.** `@prisma/instrumentation-contract` is a shared internal package between `@prisma/client` and `@prisma/instrumentation` within the Prisma monorepo. It's not documented as a public API — its shape can change in any release without notice.
- **OTel-shaped types.** The `TracingHelper.runInChildSpan()` interface takes and returns OTel-shaped span objects. A non-OTel APM tool would need to either shim the OTel `Span` interface or pull in `@opentelemetry/api` anyway — at which point you've gained nothing over using `@prisma/instrumentation` directly.
- **Global singleton — one winner.** The contract works by setting a single global `ActiveTracingHelper`. If a user has both `@prisma/instrumentation` (for OTel export) and a custom Sentry implementation, only one wins. There's no way for multiple APM tools to coexist.
- **Still requires initialization ordering.** The global helper must be set before `new PrismaClient()` is constructed — the same timing constraint that TracingChannel eliminates.

`TracingChannel` solves all of these by providing a **vendor-neutral, platform-level** primitive. Any APM tool — OTel-based or not — can subscribe to structured lifecycle events without depending on any tracing SDK. Multiple subscribers coexist by design, there's no initialization ordering constraint, and the contract is `diagnostics_channel` itself — a stable Node.js API.

### Two integration paths

There are two ways TracingChannel could coexist with the current architecture:

**Option A: TracingChannel as the vehicle for `@prisma/instrumentation`**

TracingChannel becomes the underlying emission mechanism. `@prisma/client` emits events via `diagnostics_channel`, and `@prisma/instrumentation` becomes a thin OTel subscriber that translates TracingChannel events into OTel spans — just like `@opentelemetry/instrumentation-undici` subscribes to `undici:request`. This eliminates the custom `TracingHelper` contract entirely in favor of a platform primitive.

```
@prisma/client  ──TracingChannel──>  @prisma/instrumentation (OTel subscriber)
                                 └>  Datadog subscriber
                                 └>  Sentry subscriber
                                 └>  Custom subscriber
```

**Option B: TracingChannel as a parallel API**

The existing `TracingHelper` contract continues to power `@prisma/instrumentation` for OTel users, while TracingChannel provides an independent subscription point for non-OTel APM tools. Both coexist, emitting from the same code paths.

**Option A is recommended** — it reduces internal complexity (one emission mechanism instead of two), aligns with the ecosystem direction (undici, mysql2, and others use TracingChannel as the *source*), and makes `@prisma/instrumentation` simpler to maintain.

### Additional benefits beyond vendor neutrality

Even for OTel users, TracingChannel provides advantages over the current contract:

- **No initialization ordering.** The current approach requires `@prisma/instrumentation` to be initialized before `PrismaClient` is constructed (the global `TracingHelper` must be set). TracingChannel subscribers can attach at any time.
- **Zero-cost guarantee.** `hasSubscribers` gating ensures context objects are never constructed when no APM is listening. The current contract always calls `runInChildSpan()` when the helper is set, even if the OTel tracer has no active samplers.
- **Runtime portability.** `diagnostics_channel` is supported by Bun and Deno. The current contract depends on `@opentelemetry/api`'s global registration mechanism.
- **Ecosystem consistency.** As TracingChannel becomes the standard emission mechanism across database drivers (mysql2 ✅, pg, mongodb, node-redis, ioredis), Prisma emitting through the same primitive means APM tools get a consistent subscription model across the entire stack.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `prisma:client:operation` | All model operations — `findMany`, `create`, `update`, `delete`, `upsert`, `aggregate`, `groupBy`, `count`, etc. | `model`, `operation`, `args`, `database`, `serverAddress`, `serverPort` |
| `prisma:client:query` | Raw SQL execution — `$queryRaw`, `$executeRaw`, and engine-level SQL dispatched by model operations | `query`, `params`, `database`, `serverAddress`, `serverPort`, `dbSystem` |
| `prisma:client:transaction` | Transaction lifecycle — `$transaction([...])` (batch) and `$transaction(async (tx) => { ... })` (interactive) | `isolationLevel`, `transactionType`, `database`, `serverAddress`, `serverPort` |
| `prisma:client:connect` | Engine lifecycle — `$connect()` | `database`, `serverAddress`, `serverPort`, `dbSystem` |

Plain `diagnostics_channel` (fire-and-forget, no async lifecycle):

| Channel | Tracks | Context fields |
|---|---|---|
| `prisma:client:disconnect` | Engine teardown — `$disconnect()` | `database`, `serverAddress`, `serverPort` |

### Why These Channels

- **`prisma:client:operation`** is the primary channel. It captures the high-level Prisma operation with structured metadata (`model`, `operation`, `args`) that only the ORM layer knows. This maps directly to the `prisma:client:operation` span that `@prisma/instrumentation` creates today, and is what APM tools need to produce span names like `User.findMany` rather than opaque SQL queries.
- **`prisma:client:query`** captures actual SQL execution. In the v7+ architecture, this fires from the query plan executor when SQL is dispatched to the driver adapter. It maps to the current `db_query` span and provides `db.query.text` for APM tools that want SQL-level visibility.
- **`prisma:client:transaction`** wraps the full transaction lifecycle — from `BEGIN` through all enclosed operations to `COMMIT`/`ROLLBACK`. The `transactionType` discriminator (`batch` vs `interactive`) distinguishes the two modes. Maps to the current `transaction` span.
- **`prisma:client:connect`** tracks engine initialization, which in v7+ means establishing the driver adapter connection.
- **`prisma:client:disconnect`** is a plain channel (fire-and-forget) since disconnect is a teardown operation without meaningful async lifecycle for tracing.

### Context Properties

#### Operation Channel (`prisma:client:operation`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `model` | Model name from the client call (e.g. `User`, `Post`) | `db.collection.name` / span name |
| `operation` | Action name (`findMany`, `create`, `update`, `delete`, `upsert`, `aggregate`, `groupBy`, `count`, `findUnique`, `findFirst`, `createMany`, `updateMany`, `deleteMany`) | `db.operation.name` |
| `args` | Operation arguments — where/data/select/include (APM serializes/sanitizes) | Query reconstruction |
| `database` | Database name from connection URL | `db.namespace` |
| `serverAddress` | Host from connection URL | `server.address` |
| `serverPort` | Port from connection URL | `server.port` |

#### Query Channel (`prisma:client:query`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `query` | SQL text dispatched to the driver adapter | `db.query.text` |
| `params` | Bind parameters (APM serializes/sanitizes) | Parameterized query reconstruction |
| `database` | Database name | `db.namespace` |
| `serverAddress` | Host | `server.address` |
| `serverPort` | Port | `server.port` |
| `dbSystem` | Database system identifier (`postgresql`, `mysql`, `sqlite`, `sqlserver`, `cockroachdb`) | `db.system.name` |

#### Transaction Channel (`prisma:client:transaction`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `transactionType` | `batch` (array API) or `interactive` (callback API) | Transaction classification |
| `isolationLevel` | Isolation level if specified (`ReadUncommitted`, `ReadCommitted`, `RepeatableRead`, `Serializable`, `Snapshot`) | `db.transaction.isolation_level` |
| `database` | Database name | `db.namespace` |
| `serverAddress` | Host | `server.address` |
| `serverPort` | Port | `server.port` |

#### Connect / Disconnect Channels

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `database` | Database name from connection URL | `db.namespace` |
| `serverAddress` | Host from connection URL | `server.address` |
| `serverPort` | Port from connection URL | `server.port` |
| `dbSystem` | Database system identifier | `db.system.name` |

---

## How APM Tools Use This

### Today: OTel-Only via Contract

Prisma's current tracing requires the OTel SDK:

```js
// Requires @opentelemetry/api + @opentelemetry/sdk-trace-base + @prisma/instrumentation
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

// Must be called BEFORE PrismaClient is constructed
registerInstrumentations({
  instrumentations: [new PrismaInstrumentation()],
});

// Internally:
// 1. PrismaInstrumentation.enable() sets a global ActiveTracingHelper
// 2. PrismaClient checks for the global helper on every operation
// 3. If present, wraps operations in runInChildSpan() which creates OTel spans
// 4. Non-OTel APM tools cannot participate without adopting the full SDK
```

This means Datadog, Sentry, Elastic, and custom tracing solutions must either:
- Pull in the entire OTel SDK as a dependency just for Prisma spans
- Go without Prisma-level visibility entirely (falling back to driver-level SQL tracing only)

### With TracingChannel: Any APM Can Subscribe

```js
const dc = require('node:diagnostics_channel');

// Any APM tool — OTel, Datadog, Sentry, or custom — subscribes directly
dc.tracingChannel('prisma:client:operation').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`${ctx.model}.${ctx.operation}`, {
      attributes: {
        'db.system': 'postgresql',
        'db.operation.name': ctx.operation,
        'db.collection.name': ctx.model,
        'db.namespace': ctx.database,
        'server.address': ctx.serverAddress,
        'server.port': ctx.serverPort,
      },
    });
  },
  asyncEnd(ctx) {
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});

// SQL-level visibility
dc.tracingChannel('prisma:client:query').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan('prisma:query', {
      attributes: {
        'db.system.name': ctx.dbSystem,
        'db.query.text': ctx.query,
        'db.namespace': ctx.database,
        'server.address': ctx.serverAddress,
        'server.port': ctx.serverPort,
      },
    });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});

// Transaction lifecycle
dc.tracingChannel('prisma:client:transaction').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan('prisma:transaction', {
      attributes: {
        'prisma.transaction.type': ctx.transactionType,
        'db.transaction.isolation_level': ctx.isolationLevel,
      },
    });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});
```

### How `@prisma/instrumentation` simplifies (Option A)

If TracingChannel becomes the vehicle, `@prisma/instrumentation` reduces to a pure subscriber — no custom contracts, no global state:

```js
// @prisma/instrumentation becomes ~50 lines instead of a custom contract
import { InstrumentationBase } from '@opentelemetry/instrumentation';
const dc = require('node:diagnostics_channel');

class PrismaInstrumentation extends InstrumentationBase {
  enable() {
    this._subscriptions = dc.tracingChannel('prisma:client:operation').subscribe({
      start(ctx) {
        ctx.span = this.tracer.startSpan(`${ctx.model}.${ctx.operation}`, { /* ... */ });
      },
      asyncEnd(ctx) { ctx.span?.end(); },
      error(ctx) { /* ... */ },
    });
    // Subscribe to :query, :transaction, :connect as needed
  }

  disable() {
    this._subscriptions?.unsubscribe();
  }
}
```

This mirrors how `@opentelemetry/instrumentation-undici` works — undici emits via TracingChannel, the OTel package subscribes. The custom `TracingHelper` contract, `ActiveTracingHelper` global, and `@prisma/instrumentation-contract` package become unnecessary.

**What changes:**

| Concern | Current contract | TracingChannel (proposed) |
|---|---|---|
| **Vendor lock-in** | OTel SDK required | Any APM tool can subscribe |
| **Initialization order** | `PrismaInstrumentation` must be enabled before `new PrismaClient()` | Subscribe at any time |
| **Internal packages** | Requires `@prisma/instrumentation-contract` shared between client and instrumentation | None — `diagnostics_channel` is the contract |
| **Activation cost** | `runInChildSpan()` always called when helper is set | Zero-cost — `hasSubscribers` gate skips context construction |
| **Runtime support** | Depends on `@opentelemetry/api` global registration | `diagnostics_channel` works on Node.js, Bun, Deno |
| **Ecosystem consistency** | Prisma-specific contract | Same subscription model as undici, mysql2, pg, redis, etc. |

---

## Implementation Notes

### Insertion Points

Based on Prisma v7+'s TypeScript architecture:

1. **`prisma:client:operation`** — wrap `_request()` in `getPrismaClient.ts`. This is where all model operations flow through, and where the current `prisma:client:operation` OTel span is created. The `model`, `action`, and `args` are all available at this point.

2. **`prisma:client:query`** — emit from `withQuerySpanAndEvent()` in the query plan executor (`tracing.ts`). This is where the current `db_query` OTel span fires and where `$on('query')` events are emitted. The SQL text, params, and duration are available here.

3. **`prisma:client:transaction`** — wrap `$transaction()` in `getPrismaClient.ts`. For batch transactions, wrap the array execution. For interactive transactions, wrap the callback invocation through `COMMIT`/`ROLLBACK`.

4. **`prisma:client:connect`** / **`prisma:client:disconnect`**, wrap `$connect()` and `$disconnect()` in `ClientEngine.ts`.

### Connection Metadata

Prisma parses the `DATABASE_URL` connection string internally. The `serverAddress`, `serverPort`, `database`, and `dbSystem` fields should be extracted from the parsed connection config — the same source the current OTel spans use for attributes.

For driver adapters (e.g., `@prisma/adapter-pg`), the connection metadata lives in the adapter's underlying driver config. The TracingChannel context should provide whatever is available from Prisma's connection config, and driver-level TracingChannel events (e.g., `pg:query`) will provide wire-level details.

### Async Model

All Prisma Client operations return `PrismaPromise` (a lazy promise). `TracingChannel.tracePromise` is the appropriate wrapper:

```js
// Conceptual — wrapping _request()
if (shouldTrace(operationChannel)) {
  return operationChannel.tracePromise(originalRequest, {
    model: params.model,
    operation: params.action,
    args: params.args,
    database: this._engineConfig.database,
    serverAddress: this._engineConfig.host,
    serverPort: this._engineConfig.port,
  });
}
```

### Relationship to Existing Observability APIs

| Concern | `$on('query')` events | `$extends` query component | `@prisma/instrumentation` | TracingChannel (proposed) |
|---|---|---|---|---|
| **Use case** | Logging, debugging | Application-level interception | OTel-based APM tracing | Vendor-neutral APM tracing |
| **Async context** | Not propagated | Propagated (promise chain) | Propagated (OTel `startActiveSpan`) | Automatically propagated |
| **Vendor dependency** | None | None | `@opentelemetry/api` + SDK | None |
| **Registration** | Per-client (`$on`) | Per-client (`$extends`) | Global (before client construction) | Global (`diagnostics_channel`) |
| **Can modify operations** | No | Yes | No | No |
| **Activation cost** | Always fires when configured | Always runs when registered | Always when helper is set | Zero-cost when no subscribers |

### Relationship to Driver-Level TracingChannel

When both Prisma and the underlying driver emit TracingChannel events, APM tools get a layered view:

```
prisma:client:operation  →  (model: "User", operation: "findMany")
  prisma:client:query    →  (query: "SELECT ... FROM users WHERE ...")
    pg:query              →  (raw SQL execution on the wire)
  prisma:client:query end
prisma:client:operation end
```

APM tools can choose to:
- Subscribe to **all layers** for maximum detail (Prisma → SQL → driver spans)
- Subscribe to **Prisma only** for application-level observability with model/operation metadata
- Subscribe to **driver only** for raw database-level tracing without the ORM abstraction

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
- **`mongoose`** — [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) — issue opened (`mongoose:query`, `mongoose:aggregate`, `mongoose:save`, `mongoose:model`)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
