# mysql2: `TracingChannel` Proposal

> **PR:** [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178)
> **Status:** ✅ Merged

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `mysql2`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly, which was the missing piece that makes existing monkey-patching approaches fragile in real-world async Node.js applications.

Current instrumentations today use IITM (import-in-the-middle) for ESM and RITM (require-in-the-middle) for CJS to monkey-patch `Connection.prototype.query` and `Connection.prototype.execute`. This has a few fragility concerns in today's ecosystem:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before `mysql2` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling server-side code into single executables, binaries, or deployment files.

If `mysql2` emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `mysql2:query` | `connection.query()` execution — from invocation to result/error | `query`, `values`, `database`, `serverAddress`, `serverPort` |
| `mysql2:execute` | `connection.execute()` prepared statement execution | `query`, `values`, `database`, `serverAddress`, `serverPort` |
| `mysql2:connect` | Client connection lifecycle (initial connect) | `database`, `serverAddress`, `serverPort`, `user` |
| `mysql2:pool:connect` | Pool connection acquisition | `database`, `serverAddress`, `serverPort` |

### Context Properties

The payload closely follows what OTEL currently extracts as attributes in their [mysql2 instrumentation](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-mysql2), making it straightforward for APM vendors to migrate:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `query` | SQL string passed to `query()` / `execute()` | `db.query.text` |
| `values` | Bind parameters (APM serializes/sanitizes) | Parameterized query reconstruction |
| `database` | Connection config `database` | `db.namespace` |
| `serverAddress` | Connection config `host` | `server.address` |
| `serverPort` | Connection config `port` | `server.port` |
| `user` | Connection config `user` (connect channel only) | `db.user` |

### Pool Channels

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `database` | Pool config `database` | `db.namespace` |
| `serverAddress` | Pool config `host` | `server.address` |
| `serverPort` | Pool config `port` | `server.port` |

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
