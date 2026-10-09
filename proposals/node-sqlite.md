# node:sqlite: `TracingChannel` Proposal

> **Target:** [nodejs/node](https://github.com/nodejs/node) (`lib/sqlite.js`, `src/node_sqlite.cc`)
> **Status:** 🟡 PR open
> **PR:** [nodejs/node#66581](https://github.com/nodejs/node/pull/66581)

---

I'd like to propose adding [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `node:sqlite`, so APM tools can produce proper database spans for SQLite queries the same way they do for `undici`, `pg`, `mysql2` and the Redis clients.

`node:sqlite` already has the [`sqlite.db.query`](https://nodejs.org/api/diagnostics_channel.html#event-sqlitedbquery) channel, added in [#62241](https://github.com/nodejs/node/pull/62241). That channel is great for profiling, and this proposal does not change it. But its own docs are clear about what it can't do:

> This is a **profiling** event: it fires once per statement upon completion and reports an estimated duration from SQLite's internal profiler. It is not a distributed-tracing span. There is no corresponding start event, no async context propagation, and no parent-span linkage. If you need OpenTelemetry-compatible spans or async context propagation, wrap your SQLite calls with a `TracingChannel` at the JavaScript layer instead.

During review of that PR, @Qard also noted that the C-level profile only measures the SQLite C API, and [suggested](https://github.com/nodejs/node/pull/62241#discussion_r3264033243) `TracingChannel` in JS as the way to get real tracing. He also [asked](https://github.com/nodejs/node/pull/62241#discussion_r2939408817) for an event carrying the database instance, the query template and the query parameters, which the profiling channel couldn't provide. This proposal is that follow-up.

### Why core should do the wrapping

Today the docs ask users to wrap their SQLite calls themselves. In practice nobody does that by hand, so the job falls to APM tools, and patching a builtin has the same problems as patching any npm package:

- **Runtime lock-in:** RITM/IITM rely on Node.js module loader internals. They don't work on Bun or Deno, which both ship SQLite modules and are working toward `node:sqlite` compatibility.
- **ESM fragility:** IITM is built on module customization hooks, which are still evolving and have been a persistent source of breakage in the OTel JS ecosystem.
- **Initialization ordering:** instrumentation must be set up before `node:sqlite` is first imported. Get the order wrong and it silently does nothing.
- **Bundling:** builtins are never bundled, but the wrappers APMs install still depend on load order and on module patching being enabled at all, which is increasingly not the case with single executable applications and frameworks that bundle server code.

There's also a coverage gap: there is no OpenTelemetry instrumentation for `node:sqlite` at all (the request in [open-telemetry/opentelemetry-js-contrib#2698](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2698) was closed), and neither Sentry nor Datadog instrument it. Shipping channels in core means every APM gets SQLite spans by writing one subscriber, with nothing to patch.

---

## Proposed Tracing Channels

| TracingChannel | Tracks | Sub-channels used |
|---|---|---|
| `sqlite.query` | Executing SQL: `statement.run/get/all/iterate()`, `database.exec()`, and the `SQLTagStore` equivalents | `start`, `end`, `error` (plus `asyncStart`/`asyncEnd` for the async API) |

The full sub-channel names are `tracing:sqlite.query:start`, `tracing:sqlite.query:end`, and so on, matching the core convention used by `tracing:module.require` and `tracing:net.server.listen`. They don't collide with the existing `sqlite.db.query` channel.

One channel is enough here. Every operation above is "run some SQL against a database", and APMs name the span the same way for all of them (from the SQL text), so a `method` field covers the distinction without an extra channel per method.

### Context Properties

| Field | Source | OTel attribute it enables |
|---|---|---|
| `sql` | `statement.sourceSQL`, or the string passed to `exec()` | `db.query.text`, and `db.operation.name` / `db.collection.name` after parsing |
| `parameters` | The bound parameters as passed by the caller (named object and/or anonymous values) | Parameterized query reconstruction (opt-in in most APMs) |
| `method` | `'run'`, `'get'`, `'all'`, `'iterate'` or `'exec'` | Span naming / filtering |
| `database` | The `Database` instance | Per-instance filtering, same as `sqlite.db.query` |
| `statement` | The `Statement` instance (`undefined` for `exec()`) | Correlation with the prepared statement |
| `location` | `database.location()` (`null` for in-memory databases) | `db.namespace` |
| `result` | Set by `TracingChannel` on `end`: rows for `get`/`all`, `{ changes, lastInsertRowid }` for `run` | `db.response.returned_rows`, affected rows |
| `error` | Set by `TracingChannel` on `error`: the thrown error, including `errcode` / `errstr` | `db.response.status_code`, `error.type` |

`db.system.name` is always `sqlite`, so it doesn't need a field. There are no `serverAddress` / `serverPort` fields because SQLite is embedded: `location` is the closest equivalent and is what OTel uses for `db.namespace`.

`sql` is the **source** SQL with placeholders, not the expanded SQL that `sqlite.db.query` publishes. Expanded SQL has parameter values baked in, which is a PII problem for most APM backends, and the placeholder form is what `db.query.text` expects. Subscribers that want the values get them separately in `parameters`, so they decide whether to record them.

### `iterate()`

`statement.iterate()` returns an iterator, so the real work happens while the caller consumes it. I'd suggest publishing `start` when `iterate()` is called and `end` when the iterator completes, whether it's exhausted, closed with `return()`, or throws. That way the span covers the time the query actually ran. If maintainers prefer something simpler, wrapping only the `iterate()` call with `traceSync` still gives a correct parent and start time.

### Async API

If the batched async `Database` API ([#62015](https://github.com/nodejs/node/pull/62015)) lands, its methods would publish on the same `sqlite.query` channel using `tracePromise`, so `asyncStart` / `asyncEnd` fire when the result comes back from the thread pool. The context shape stays the same, and subscribers don't need to care which API was used.

---

## How this relates to `sqlite.db.query`

The two channels complement each other:

| | `sqlite.db.query` (existing) | `sqlite.query` TracingChannel (proposed) |
|---|---|---|
| Purpose | Profiling | Distributed tracing |
| Events | One, after the statement completes | `start` / `end` / `error` around the JS call |
| Timing | SQLite's estimate of C-layer run time | Wall time of the call as the application sees it |
| Parent span linkage | No | Yes, `start` runs in the caller's async context |
| Async context propagation (`bindStore`) | No | Yes |
| SQL | Expanded, with values inlined | Source, with placeholders, plus `parameters` |
| Errors | Not reported | `error` sub-channel |
| Mechanism | `sqlite3_trace_v2` per connection | No SQLite trace hook needed |

Profiling tools keep using `sqlite.db.query`. APMs building spans use `sqlite.query`.

---

## Performance

During #62241, the main concern was that installing `sqlite3_trace_v2` on every connection costs something (1% to 5.6% in the benchmarks posted there) even when you only care about some of them. This proposal doesn't touch `sqlite3_trace_v2` at all, so it adds no per-connection SQLite cost. Every event also carries the `Database` instance, so a subscriber that only cares about one database can filter on it.

Because `start` and `end` are published around the binding call rather than from inside a SQLite callback, subscribers never run while SQLite is mid-statement. That avoids the class of reentrancy crashes #62241 had to guard against (a subscriber closing the statement or database while it was still in use).

When nothing is subscribed, the only cost is a `hasSubscribers` check per call, and the context object is never built. There are two ways to do this, and I'm happy to go with whichever the sqlite team prefers:

1. **In JS (`lib/sqlite.js`):** wrap the prototype methods, and call the binding straight through when `sqlite.query` has no subscribers. This is the simplest option and what @Qard suggested on #62241.
2. **Native check, JS publish:** check `HasSubscribers()` on the native `Channel` in `node_sqlite.cc`, the same way `sqlite.db.query` already does, and only call into a JS helper that runs `traceSync` when something is subscribed. This keeps the unsubscribed path entirely in C++.

Either way, I'd include a benchmark in `benchmark/sqlite/` comparing no channel, unsubscribed and subscribed, like #62241 did, and document the channel under the built-in channels in `diagnostics_channel.md`.

---

## Prior Art

Node.js core already uses `TracingChannel` for its own operations:

- **`undici`**: `undici:request` channels, shipped in core since Node 20.12
- **`module`**: `tracing:module.require` and `tracing:module.import`
- **`net`**: `tracing:net.server.listen`
- **`node:sqlite`**: `sqlite.db.query` profiling channel ([#62241](https://github.com/nodejs/node/pull/62241)), which this proposal complements

Database clients in the ecosystem that ship or are adding `TracingChannel` support:

- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`), merged
- **`pg` / `pg-pool`**: [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)
- **`node-redis`**: [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`)
- **`ioredis`**: [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)

---

I'd love feedback from @nodejs/sqlite and @nodejs/diagnostics on the channel shape and which implementation option you'd prefer. I'm happy to put together the PR.
