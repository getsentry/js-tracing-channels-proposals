# TracingChannel Proposals

Proposals and PRs for adding Node.js [`diagnostics_channel.TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#tracingchannel) support to popular npm libraries, enabling native, zero-overhead observability for all APM tools (including OpenTelemetry, Sentry, Datadog, and others).

## Why

OpenTelemetry's Node.js instrumentation relies on [import-in-the-middle](https://github.com/nicolo-ribaudo/import-in-the-middle) (IITM) and [require-in-the-middle](https://github.com/nicolo-ribaudo/require-in-the-middle) (RITM) to monkey-patch library internals. This approach is fragile, breaks with ESM, and adds overhead even when tracing is disabled.

Node.js 19.9+ ships `diagnostics_channel.TracingChannel`, a built-in mechanism that lets libraries publish structured `start`/`end`/`asyncStart`/`asyncEnd`/`error` events. Consumers (Sentry, Datadog, New Relic, etc.) subscribe without patching — zero cost when nobody is listening.

## Proposals

✅ Merged · 🟡 PR open · 💬 In discussion · 📝 Proposal drafted · ⬜ Not started

| Library | Package | PR | Status |
|---|---|---|---|
| [node-redis](proposals/node-redis.md) | `redis` | [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) | ✅ **Merged** |
| [ioredis](proposals/ioredis.md) | `ioredis` | [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) | 🟡 PR open |
| [pg](proposals/pg.md) | `pg` / `pg-pool` | [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | 🟡 PR open |
| [knex](proposals/knex.md) | `knex` | [knex/knex#6410](https://github.com/knex/knex/pull/6410) | 🟡 PR open |
| [mysql2](proposals/mysql2.md) | `mysql2` | [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | ✅ **Merged** |
| [mongodb](proposals/mongodb.md) | `mongodb` | [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) | 💬 Under discussion |
| [mongoose](proposals/mongoose.md) | `mongoose` | [mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) | 💬 Issue opened |
| [prisma](proposals/prisma.md) | `prisma` | [prisma#29353](https://github.com/prisma/prisma/issues/29353) | 💬 Issue opened |
| [graphql](proposals/graphql.md) | `graphql` | [graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629) | 💬 Issue opened |
| [hono](proposals/hono.md) | `hono` | [hono#4842](https://github.com/honojs/hono/issues/4842) | 💬 Issue opened |
| [koa](proposals/koa.md) | `koa` | — | 📝 Proposal drafted |
| [tedious](proposals/tedious.md) | `tedious` | [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727) | 📬 Submitted |
| [consola](proposals/consola.md) | `consola` | — | 📝 Proposal drafted |
| [elysia](proposals/elysia.md) | `elysia` | [elysia#1809](https://github.com/elysiajs/elysia/issues/1809) | 💬 In discussion |

See [TRACKER.md](TRACKER.md) for the full migration tracker across all 46 instrumentations (OTel-provided, Sentry-built, and ecosystem).

## Channel Naming Convention

```
{npm-package-name}:{operation}
```

Examples: `mysql2:query`, `ioredis:command`, `pg:query`, `redis:command`

Context fields follow [OTel database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/).

## How It Works

Libraries emit on a `TracingChannel`, APM tools subscribe:

```js
// Library side (e.g. inside mysql2)
const dc = require('diagnostics_channel');
const queryChannel = dc.tracingChannel('mysql2:query');

// In the query path:
queryChannel.traceCallback(fn, { query, params }, thisArg, callback);

// Consumer side (e.g. inside Sentry SDK)
const dc = require('diagnostics_channel');
dc.tracingChannel('mysql2:query').subscribe({
  start({ query, params }) { /* create span */ },
  end({ query, result }) { /* finish span */ },
  error({ query, error }) { /* record error */ },
});
```

Zero cost when no subscribers — `channel.hasSubscribers` short-circuits before allocating any context objects.

## Workflow

This repo includes Claude Code skills that automate the proposal → implement → review → learn cycle. Each step is triggered by the human operator.

### 1. Write a proposal

```
> use the propose skill for kafkajs
```

The skill researches the library (maintenance status, existing OTel instrumentation, async model), reads all prior proposals and `LEARNINGS.md`, then drafts a proposal. It gates on operator approval before saving.

### 2. Implement TracingChannel support

```
> use the implement skill for the kafkajs proposal
```

Takes a proposal from `proposals/` and produces a working implementation with tests. Handles `tracePromise`/`traceCallback` selection, `shouldTrace` guards, Node 18 compat, and Docker-based integration tests.

### 3. Update the tracker

```
> update the tracker
```

Fetches the latest status of every upstream PR in `TRACKER.md`, checks for new PRs on libraries with proposals, and recalculates the progress summary.

### 4. Capture review feedback

```
> capture review feedback from https://github.com/sidorares/node-mysql2/pull/4178
```

Fetches all review comments from an upstream PR, filters noise, and for each substantive comment presents:
- What the reviewer is asking
- Validity assessment (valid / debatable / misunderstanding)
- Suggested approach (agree, push back with rationale, ask clarification)
- Whether it contains a generalizable learning

The operator decides which comments to act on and replies themselves. Selected learnings are distilled into `LEARNINGS.md` under themed sections (channel naming, payload shape, API design, Node.js compat, anti-patterns), where they automatically inform the next proposal.

### Files

| File | Purpose |
|---|---|
| `proposals/` | One proposal per library, ready to post as GitHub issue/PR body |
| `TRACKER.md` | Full migration tracker across all 44 instrumentations |
| `LEARNINGS.md` | Distilled knowledge from reviews and implementation — feeds into new proposals |
| `skills/propose-tracing-channel-pattern/` | Skill: research + draft a proposal |
| `skills/implement-tracing-channel-pattern/` | Skill: turn a proposal into a working implementation |
| `skills/update-tracker/` | Skill: sync tracker with upstream PR status |
| `skills/capture-review-feedback/` | Skill: triage PR review comments with human in the loop |

## Prior Art

- **undici** (Node core) — the reference implementation, ships TracingChannel support since Node 19.9
- **h3** — [merged](https://github.com/h3js/h3/pull/1251)
- **srvx** — [merged](https://github.com/h3js/srvx/pull/141)
- **unstorage** — [merged](https://github.com/unjs/unstorage/pull/707)

## Related

- [e18e ecosystem issue](https://github.com/e18e/ecosystem-issues/issues/255) — umbrella issue for driving TracingChannel adoption across the ecosystem
- [untracing](https://github.com/unjs/untracing) — shared utility for library authors to standardize TracingChannel usage
- [Node.js `diagnostics_channel` docs](https://nodejs.org/api/diagnostics_channel.html)
- [Sentry JS SDK](https://github.com/getsentry/sentry-javascript)
- [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js)
