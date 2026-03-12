# Skill: Create TracingChannel Proposal

Create a `diagnostics_channel` `TracingChannel` proposal for a Node.js library, ready to post as a GitHub issue or PR description.

## Context

We are proposing that popular Node.js libraries adopt built-in [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support so that APM/instrumentation tools (OpenTelemetry, Datadog, Sentry, etc.) can subscribe to structured events **instead of monkey-patching** via IITM/RITM.

## Prior Art

Read the existing proposals in `proposals/` for examples and patterns:

| Library | File | Key patterns |
|---|---|---|
| node-redis | `proposals/node-redis.md` | Redis command tracing, batch/pipeline support, `batchMode`/`batchSize` fields |
| ioredis | `proposals/ioredis.md` | Port of node-redis pattern, IPC/Unix socket support, lowercase batch modes |
| pg | `proposals/pg.md` | Multi-package (pg + pg-pool), mix of TracingChannel + plain channels for fire-and-forget events |
| mysql2 | `proposals/mysql2.md` | Separate channels for `query()` vs `execute()` (prepared statements), pool acquisition |

**Always read ALL existing proposals before drafting a new one.** They demonstrate the evolving style and increasing sophistication of the proposals. Each new proposal should learn from and reference the previous ones.

## Steps

### 1. Research the target library

Before writing anything, understand:

- **What operations does it perform?** (queries, commands, connections, pool management, etc.)
- **What does the existing OTel instrumentation patch?** Check `@opentelemetry/instrumentation-{name}` source code to see which prototypes/methods are monkey-patched. This tells you exactly what events the library should emit.
- **What attributes does OTel extract?** Map these to context fields. The [OTel semantic conventions for databases](https://opentelemetry.io/docs/specs/semconv/database/) are the reference.
- **Does the library already have any `diagnostics_channel` support?** Search the repo for `diagnostics_channel`, `TracingChannel`, `dc.channel`.
- **What's the library's async model?** Callbacks, promises, streams? This affects how `TracingChannel` wraps operations.
- **Does it have a connection pool?** Pools typically need their own channels for acquire/release.

### 2. Design the channels

Follow the naming convention `{package-name}:{operation}`:

```
mysql2:query
mysql2:execute
mysql2:connect
pg:query
pg:connection
node-redis:command
ioredis:command
```

**Guidelines:**
- Use the npm package name as prefix (not the GitHub repo name)
- One TracingChannel per distinct async operation worth tracing
- Use plain `diagnostics_channel` (not TracingChannel) for fire-and-forget events that don't need async lifecycle tracking (e.g. pool release/remove)
- Separate channels for operations with meaningfully different semantics (e.g. mysql2's `query` vs `execute` for prepared statements)
- Don't over-channel — if two operations share the same context shape and lifecycle, consider a single channel with a discriminator field

### 3. Design context properties

Map to OTEL semantic conventions. Common fields:

| Field | Maps to | Used for |
|---|---|---|
| `query` / `command` | `db.query.text` / `db.operation.name` | The operation being performed |
| `args` / `values` | Parameterized query data | APM serializes/sanitizes these |
| `database` | `db.namespace` | Database name or number |
| `serverAddress` | `server.address` | Host |
| `serverPort` | `server.port` | Port |

**Important:** Always check what the existing OTel instrumentation extracts. The context should provide at minimum everything OTel currently gets via monkey-patching, so migration is seamless.

### 4. Write the proposal

Use this structure (adapted from existing proposals):

```markdown
# Title

[1-2 sentence summary of what this adds]

[Motivation section — explain why TracingChannel over monkey-patching.
Reuse the standard 4-bullet motivation from existing proposals:
runtime lock-in, ESM fragility, initialization ordering, bundling.]

---

## Proposed Tracing Channels

[Table: channel name, what it tracks, context fields]

### Context Properties

[Table: field, source, OTEL attribute it enables]

[Additional tables for special cases like batch operations, pool events, etc.]

---

## Backward Compatibility

[Standard section — zero-cost when no subscribers, graceful degradation on older Node]

```ts
const dc = ('getBuiltinModule' in process)
  ? process.getBuiltinModule('node:diagnostics_channel')
  : require('node:diagnostics_channel');
```

---

## Prior Art

[Link ALL existing proposals/PRs — this list grows with each new proposal]

- **`undici`** (Node.js core) — ships TracingChannel support since Node 20.12
- **`node-redis`** — redis/node-redis#3195
- **`ioredis`** — redis/ioredis#2089
- **`pg` / `pg-pool`** — brianc/node-postgres#3624
- [Add any new ones here]

---

[Closing — ask for feedback, offer to submit PR]
```

### 5. Library-specific considerations

Adapt the template based on what you learned in step 1:

- **Multiple packages in a monorepo** (like pg + pg-pool): cover all relevant packages, note which channels belong to which
- **Prepared statements** (like mysql2's `execute`): separate channel from regular queries
- **Batch/pipeline operations** (like Redis MULTI/pipeline): add batch-specific context fields (`batchMode`, `batchSize`)
- **Connection pools**: add pool-specific channels (acquire, release, remove)
- **IPC/Unix sockets** (like ioredis): handle `serverAddress` being a path, `serverPort` being undefined
- **Callback vs promise APIs**: note which async model the TracingChannel wraps

### 6. Save the proposal

Save to `proposals/{package-name}.md` in this repo.

## Output

The final proposal should be:
- Ready to copy-paste as a GitHub issue body
- Self-contained (reader doesn't need to look at other proposals to understand it)
- Specific enough that a maintainer can evaluate the API surface
- Links to prior art so the maintainer sees this is part of a broader ecosystem movement
