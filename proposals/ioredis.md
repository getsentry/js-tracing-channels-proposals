# ioredis: `TracingChannel` Proposal

> **PR:** [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089)
> **Based on:** [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (port to ioredis), original proposal in [redis/node-redis#2590](https://github.com/redis/node-redis/issues/2590)
> **Status:** Open

---

This PR implements tracing channels for `command` and `connect` operations. This allows APM libraries (OTEL, Datadog, Sentry) to instrument redis commands **without monkey-patching**.

It also enables users to setup their own custom instrumentations and analytics.

This is a port of [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) to ioredis.

## Tracing Channels

All channels in this PR use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `ioredis:command` | Individual Redis command execution from queue to reply (standalone, MULTI, and pipeline) | `command`, `args`, `database`, `serverAddress`, `serverPort`, and optionally `batchMode`, `batchSize` for MULTI/pipeline commands |
| `ioredis:connect` | Client connection lifecycle (initial connect only, not reconnections) | `serverAddress`, `serverPort` |

## Context Properties

The payload closely follows what OTEL currently extracts as attributes in their instrumentations:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `command` | command name | `db.operation.name` |
| `args` | full args array | `db.query.text` (APM serializes/sanitizes) |
| `database` | selected DB | `db.namespace` |
| `serverAddress` | socket options host (or `path` for IPC) | `server.address` |
| `serverPort` | socket options port (`undefined` for IPC) | `server.port` |

For batch commands:

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `batchMode` | `'pipeline'` or `'multi'` | `db.operation.name` prefix |
| `batchSize` | `commands.length` | `db.operation.batch.size` |

## Backward Compatibility

Zero-cost when no subscribers are registered. Silently skipped on Node.js versions where `TracingChannel` is unavailable (e.g. Node 18).

```ts
const dc = ('getBuiltinModule' in process)
  ? process.getBuiltinModule('node:diagnostics_channel')
  : require('node:diagnostics_channel');
```

## Implementation Notes

- `Redis.connect()` and `Redis.sendCommand()` emit trace events on `ioredis:connect` and `ioredis:command`
- Pipeline/MULTI commands annotated via `Command.batchMode`/`batchSize`
- Tracing implemented in new `lib/tracing.ts`, exported as public types
- Tests skipped on Node versions without `TracingChannel`

## Differences from node-redis

- Channel prefix is `ioredis:` instead of `node-redis:`
- `serverAddress` also supports `path` for IPC (Unix domain sockets)
- `batchMode` uses lowercase values (`'pipeline'`, `'multi'`) vs node-redis's uppercase (`'PIPELINE'`, `'MULTI'`)
- Command name extracted from ioredis's `Command` object rather than `args[0]`
