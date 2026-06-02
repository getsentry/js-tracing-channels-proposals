# Postgres.js: `TracingChannel` Proposal

> **Target:** [porsager/postgres](https://github.com/porsager/postgres)
> **Issue:** [porsager/postgres#1171](https://github.com/porsager/postgres/issues/1171)
> **Status:** 💬 Issue opened

---

This proposal adds first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to Postgres.js, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly.

## Motivation

### Why native tracing matters for Postgres.js

Postgres.js is the second most popular PostgreSQL client for Node.js (8.6k stars) and is used by Drizzle ORM and other major frameworks. APM tools (Sentry, OTel, Datadog) need to instrument it for query-level observability. Today they do this through monkey-patching, which is fragile and has several ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `postgres` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code.

### What APM tools do today

Sentry's current [instrumentation](https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/tracing/postgresjs.ts) (428 LOC) wraps the module's default export, proxies `resolve`/`reject` on each query to capture completion, and patches `Query.prototype.handle` across three file paths as a fallback for pre-existing instances. All of this breaks if Postgres.js renames internals or refactors the query flow.

### Relationship to the existing `debug` option

Postgres.js already has a `debug` callback:

```js
const sql = postgres({ debug: (id, string, parameters, types) => { ... } })
```

This fires during the `build()` phase and provides the query string and parameters. However, it doesn't cover the async lifecycle (no completion/error events), doesn't propagate async context, and requires per-instance configuration. TracingChannel complements `debug` by providing structured lifecycle events that APM tools can subscribe to globally.

## Proposed Tracing Channels

| Channel | Type | Tracks |
|---|---|---|
| `postgres:query` | TracingChannel | Query execution (tagged template `sql`...``, `.execute()`) |
| `postgres:connection` | TracingChannel | Connection establishment |
| `postgres:transaction` | TracingChannel | Transaction lifecycle (`sql.begin()`) |

### Why these channels

- **`postgres:query`** is the primary channel. All queries flow through `handler()` in `index.js`, which dispatches to `connection.execute()`. This is the single point where query text, parameters, and connection info are all available.
- **`postgres:connection`** covers the connection lifecycle from socket open through authentication to ready. Postgres.js manages its own pool internally, so this channel also serves as the pool acquisition signal (a query that triggers a new connection will fire both `postgres:connection` and `postgres:query`).
- **`postgres:transaction`** covers `sql.begin()` / `sql.reserve()` boundaries. Transactions reserve a connection and execute multiple queries within it. APM tools need this to group child query spans under a transaction parent.

### Why no separate pool channels

Unlike `node-postgres` where `pg-pool` is a separate package with explicit acquire/release semantics, Postgres.js manages connections implicitly. Connections move between internal queues (`open`, `busy`, `full`, `closed`) automatically. There's no user-facing acquire/release operation, so pool-level channels would expose implementation details without matching a user-visible operation.

## Context Payloads

### postgres:query

```js
// start
{
  query: {
    text: 'SELECT * FROM users WHERE id = $1',
    name: undefined,         // prepared statement name, if cached
  },
  connection: {
    database: 'mydb',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    pid: 12345,              // PostgreSQL backend process ID
    ssl: false,
  },
}

// asyncEnd (enriched after completion)
{
  query: { ... },
  connection: { ... },
  result: {
    count: 1,                // rows returned/affected
    command: 'SELECT',       // PostgreSQL command tag
  },
}
```

### postgres:connection

```js
// start
{
  connection: {
    database: 'mydb',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    ssl: false,
  },
}

// asyncEnd (enriched after connection is ready)
{
  connection: {
    ...
    pid: 12345,              // now available after handshake
  },
}
```

### postgres:transaction

```js
// start
{
  connection: {
    database: 'mydb',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    pid: 12345,
    ssl: false,
  },
  options: {
    isolationLevel: 'read committed',  // if specified
  },
}

// asyncEnd (enriched after commit/rollback)
{
  connection: { ... },
  options: { ... },
  result: {
    committed: true,         // false if rolled back
  },
}
```

## How APM Tools Use This

### Today: 428 lines of monkey-patching

```js
// Simplified from Sentry's instrumentation

// 1. Wrap the postgres() factory to intercept sql instance creation
const WrappedPostgres = function(...args) {
  const sql = Reflect.construct(Original, args);
  return instrumentPostgresJsSql(sql, config);
};

// 2. Patch Query.prototype.handle as fallback for pre-existing instances
moduleExports.Query.prototype.handle = async function(...args) {
  if (this[QUERY_FROM_INSTRUMENTED_SQL]) return originalHandle.apply(this, args);

  // 3. Proxy resolve/reject to capture completion
  this.resolve = new Proxy(this.resolve, { apply: (target, thisArg, args) => {
    span.end();
    return Reflect.apply(target, thisArg, args);
  }});
  this.reject = new Proxy(this.reject, { apply: (target, thisArg, args) => {
    span.setStatus({ code: SPAN_STATUS_ERROR });
    span.end();
    return Reflect.apply(target, thisArg, args);
  }});

  return originalHandle.apply(this, args);
};

// 4. Patch 3 file paths for CJS compatibility
['src/query.js', 'cf/src/query.js', 'cjs/src/query.js'].forEach(path => { ... });
```

### With TracingChannel: subscribe to structured events

```js
const dc = require('node:diagnostics_channel');

dc.tracingChannel('postgres:query').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(ctx.result?.command || 'postgres.query', {
      attributes: {
        'db.system': 'postgres',
        'db.query.text': sanitize(ctx.query.text),
        'db.namespace': ctx.connection.database,
        'server.address': ctx.connection.host,
        'server.port': ctx.connection.port,
      },
    });
  },
  asyncEnd(ctx) {
    if (ctx.result) {
      ctx.span?.setAttribute('db.operation.name', ctx.result.command);
    }
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.end();
  },
});

dc.tracingChannel('postgres:transaction').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan('postgres.transaction');
  },
  asyncEnd(ctx) {
    ctx.span?.setAttribute('db.transaction.committed', ctx.result?.committed);
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR });
    ctx.span?.end();
  },
});
```

### What changes for APM vendors

| Concern | Monkey-patching (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Must intercept module load before first `import`; patch factory + prototype + 3 file paths | Subscribe to `diagnostics_channel` at any time |
| **Scope** | Wrap default export, proxy resolve/reject on every query, patch Query.prototype.handle | Subscribe to 3 channels |
| **Context propagation** | Manual Proxy wrapping of resolve/reject callbacks | Built-in via TracingChannel's `AsyncLocalStorage` integration |
| **Version coupling** | Depends on Query internals (resolve/reject properties, handle method, file paths) | Stable channel contract |
| **Deduplication** | `QUERY_FROM_INSTRUMENTED_SQL` symbol to prevent double-spans | Not needed |
| **Runtime support** | Node.js only (IITM/RITM) | Any runtime with `diagnostics_channel` support |

## Implementation Notes

### Insertion points

Based on the Postgres.js source architecture:

1. **`postgres:query`** -- wrap `handler()` in `src/index.js` (line ~329). This is the single dispatch point where the tagged template result is submitted to a connection. Query text, parameters, and connection info are all available here. Use `tracePromise` since queries return promises.

2. **`postgres:connection`** -- wrap the connection establishment flow in `src/connection.js`. The `ReadyForQuery` handler (line ~535) marks when a connection is fully established and the backend PID is available for context enrichment.

3. **`postgres:transaction`** -- wrap `sql.begin()` in `src/index.js` (line ~234). The transaction function reserves a connection, executes BEGIN, runs the user's callback, and then commits or rolls back. Use `tracePromise` around the full transaction lifecycle.

### Runtime compatibility

Postgres.js already supports Cloudflare Workers and Bun. The TracingChannel implementation should gracefully degrade on runtimes without `diagnostics_channel`:

```js
let dc
try {
  dc = typeof process.getBuiltInModule === 'function'
    ? process.getBuiltInModule('diagnostics_channel')
    : require('diagnostics_channel')
} catch (e) {
  // diagnostics_channel not available
}
```

### Zero overhead

All emission sites should be guarded by `hasSubscribers`:

```js
if (queryChannel.hasSubscribers) {
  return queryChannel.tracePromise(async () => { ... }, context)
}
return originalExecution()
```

## Prior Art

This approach follows the same pattern already adopted by other database libraries:

- **`mysql2`** -- [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) -- merged
- **`node-redis`** -- [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) -- merged
- **`ioredis`** -- [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) -- merged
- **`pg` / `pg-pool`** -- [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650) -- PR open
- **`graphql-js`** -- [graphql/graphql-js#4670](https://github.com/graphql/graphql-js/pull/4670) -- merged
- **`mongoose`** -- [Automattic/mongoose#16275](https://github.com/Automattic/mongoose/pull/16275) -- PR open
- **`knex`** -- [knex/knex#6410](https://github.com/knex/knex/pull/6410) -- PR open

---

Happy to put together a PR with the implementation.
