I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to the MongoDB Node.js driver, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

The MongoDB driver already has an excellent observability foundation — the [Command Monitoring](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md) API (`commandStarted`, `commandSucceeded`, `commandFailed`) and the [CMAP](https://github.com/mongodb/specifications/blob/master/source/connection-monitoring-and-pooling/connection-monitoring-and-pooling.md) pool events provide rich operational visibility. However, APM instrumentation libraries (OpenTelemetry, Datadog, Sentry) **cannot use these events** for span-based tracing today. Instead, they resort to monkey-patching internal methods like `Connection.prototype.command` and `ConnectionPool.prototype.checkOut` via IITM/RITM. Here's why:

1. **No async context propagation.** Command Monitoring events are emitted via `EventEmitter`. When `commandStarted` fires, the listener runs in the emitter's execution context — not the caller's `AsyncLocalStorage` context. APM tools need to create child spans of the caller's span, which requires capturing the async context at the call site. EventEmitter listeners lose this context.

2. **Opt-in gating.** Command Monitoring only fires when the user passes `monitorCommands: true` to `MongoClient`. APM tools can't control how users instantiate their clients, so they can't rely on this flag being set. Monkey-patching works regardless of user configuration.

3. **Split lifecycle.** `commandStarted` and `commandSucceeded`/`commandFailed` are separate EventEmitter events. To build a span, APM tools must correlate them via `requestId` and manage span storage manually. Tracing channels provide a contextualized lifecycle for the operation, so correlation is built-in.

Beyond these APM-specific gaps, the current monkey-patching approach has broader ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `mongodb` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing — very hard to debug in production.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code into single executables or deployment files.

`TracingChannel` solves all of these. It provides structured lifecycle events (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) with built-in async context propagation, zero-cost when no subscribers are attached, and a standardized subscription model that requires no monkey-patching.

The driver's existing Command Monitoring and CMAP events remain valuable for operational monitoring and debugging. `TracingChannel` is not a replacement — it's a complement that fills the specific gaps APM tools need for span-based distributed tracing.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `mongodb:command` | Command execution — from invocation through `Connection.command()` to reply/error | `commandName`, `databaseName`, `collectionName`, `command`, `serverAddress`, `serverPort` |
| `mongodb:connect` | Connection establishment lifecycle | `serverAddress`, `serverPort` |
| `mongodb:pool:checkout` | Pool connection checkout — from request to acquired connection | `serverAddress`, `serverPort` |

### Context Properties

The payload maps to what OTEL currently extracts via monkey-patching in [`@opentelemetry/instrumentation-mongodb`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/node/opentelemetry-instrumentation-mongodb), making migration straightforward:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `commandName` | The command name (e.g. `insert`, `find`, `update`, `aggregate`) | `db.operation.name` |
| `databaseName` | Target database name | `db.namespace` |
| `collectionName` | Target collection name | `db.collection.name` |
| `command` | The command document (APM serializes/sanitizes) | `db.query.text` |
| `serverAddress` | Server host | `server.address` |
| `serverPort` | Server port | `server.port` |

### Pool Checkout Context

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `serverAddress` | Pool server host | `server.address` |
| `serverPort` | Pool server port | `server.port` |

---

## Relationship to Existing Monitoring

This proposal **complements**, not replaces, the existing monitoring APIs:

| Concern | Command Monitoring / CMAP | TracingChannel |
|---|---|---|
| **Use case** | Operational monitoring, debugging, logging | APM span-based distributed tracing |
| **Async context** | Not propagated (EventEmitter) | Automatically propagated |
| **Activation** | `monitorCommands: true` required | Always available, zero-cost when unused |
| **Lifecycle model** | Separate start/success/fail events correlated by `requestId` | Unified lifecycle wrapping the full async operation |
| **Subscribers** | Attached to `MongoClient` instance | Global `diagnostics_channel` subscription |

---

## Backward Compatibility

Zero-cost when no subscribers are registered — `hasSubscribers` is checked before constructing any context objects. Silently skipped on Node.js versions where `TracingChannel` is unavailable (e.g. Node 18).

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

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
