# pg (node-postgres): `TracingChannel` Proposal

> **Issue:** [brianc/node-postgres#3619](https://github.com/brianc/node-postgres/issues/3619)
> **PR:** [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624)
> **Status:** Open

---

This proposal adds first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `pg` and `pg-pool`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

`TracingChannel` is a higher-level API built on top of `diagnostics_channel`, specifically designed for tracing async operations. It provides structured lifecycle channels (`start`, `end`, `error`, `asyncStart`, `asyncEnd`) and handles async context propagation correctly, which was the missing piece that makes existing monkey-patching approaches fragile in real-world async Node.js applications.

Current instrumentations today use IITM (import-in-the-middle) for ESM and RITM for CJS which has a few fragility concerns in today's ecosystem state:

- **Runtime lock-in:** both RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** both require instrumentation to be set up before `pg` is first require()'d. Get the order wrong and instrumentation silently does nothing, which is very hard to debug in production.
- **Bundling and Externalization:** Users have to ensure their instrumented modules are externalized, which is becoming very difficult to guarantee with more and more frameworks bundling the server-side code into single executables, binaries or deployment files.

If `pg` emits structured events through `TracingChannel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concern, no clobbering, and no internal API dependency.

## Tracing Channels

| Channel | Type | Tracks |
|---|---|---|
| `pg:query` | TracingChannel | Query execution — full async lifecycle |
| `pg:connection` | TracingChannel | Client connection lifecycle |
| `pg:pool:connect` | TracingChannel | Pool connection acquisition |
| `pg:pool:release` | Plain channel | Connection returned to pool |
| `pg:pool:remove` | Plain channel | Connection removed from pool |

## Key Design Decisions

- **5 channels total:** 3 TracingChannels (with full async lifecycle) + 2 plain channels for pool events that don't need async tracing
- All instrumentation guarded by `hasSubscribers` — zero overhead when no subscribers are attached
- Gracefully degrades to no-ops on Node < 19.9 or non-Node environments

## Differences from Redis Proposals

- More channels (5 vs 2) due to pg-pool being a separate concern with its own lifecycle events
- Mix of TracingChannel and plain `diagnostics_channel` — pool release/remove are fire-and-forget events, not async operations worth tracing
- Covers two packages (`pg` and `pg-pool`) in a single PR since they're in the same monorepo
