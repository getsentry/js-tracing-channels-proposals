# node-redis: `TracingChannel` Proposal

> **PR:** [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195)
> **Original proposal issue:** [redis/node-redis#2590](https://github.com/redis/node-redis/issues/2590) (by Datadog's @tlhunter)
> **Status:** Merged (2026-04-02)

---

This PR implements tracing channels for `command` and `connect` operations. This allows APM libraries (OTEL, Datadog, Sentry) to instrument redis commands **without monkey-patching**.

It also enables users to setup their own custom instrumentations and analytics.

## Tracing Channels

All channels in this PR use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `node-redis:command` | Individual Redis command execution from queue to reply (standalone, MULTI, and pipeline) | `command`, `args`, `database`, `serverAddress`, `serverPort`, and optionally `batchMode`, `batchSize` for MULTI/pipeline commands |
| `node-redis:connect` | Client connection lifecycle (initial connect only, not reconnections) | `serverAddress`, `serverPort` |

## Context Properties

The payload closely follows what OTEL currently extracts as attributes in their instrumentations:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `command` | `args[0]` (uppercased) | `db.operation.name` |
| `args` | full `RedisArgument[]` | `db.query.text` (APM serializes/sanitizes) |
| `database` | `this.#selectedDB` | `db.namespace` |
| `serverAddress` | socket options host | `server.address` |
| `serverPort` | socket options port | `server.port` |

For batch commands:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `batchMode` | `'MULTI'` or `'PIPELINE'` | `db.operation.name` prefix |
| `batchSize` | `commands.length` | `db.operation.batch.size` |

## Backward Compatibility

Zero-cost when no subscribers are registered. Silently skipped on Node.js versions where `TracingChannel` is unavailable (e.g. Node 18).

```ts
const dc = ('getBuiltinModule' in process)
  ? process.getBuiltinModule('node:diagnostics_channel')
  : require('node:diagnostics_channel');
```

## Implementation Notes

- Wraps `connect()`, `sendCommand()`, pipeline execution, and `MULTI` with `tracePromise`
- Emits `node-redis:connect` and `node-redis:command` events including server address/port, selected DB, command args, and batch metadata
- New tracing context types exported from the package
- Test suite validates start/asyncEnd/error emissions and batch context behavior
