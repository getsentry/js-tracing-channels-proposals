# TracingChannel Migration Tracker

> Adding native `diagnostics_channel` `TracingChannel` support to benefit all observability tools, including OTel, Sentry, Datadog, and others.
> 34 total instrumentations in Sentry JS SDK: 24 OTel-provided + 10 Sentry-built. 44 total tracked.

| Emoji | Status |
|---|---|
| ✅ | Merged |
| 🟡 | PR open |
| 💬 | In discussion / reached out |
| 📝 | Proposal drafted |
| ⬜ | Not started |
| 🔴 | No go — unmaintained / not viable |

## OTel-Provided (24) — Need Native TracingChannel Support

These currently rely on external monkey-patching infrastructure (IITM/RITM) and would benefit from native TracingChannel support.

### HTTP / Web Frameworks

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| HTTP | `http`/`https` (Node built-in) | `packages/node/src/integrations/http.ts` | — | — | ⬜ Not started |
| Express | `express` | `packages/node/src/integrations/tracing/express.ts` | [express#6353](https://github.com/expressjs/express/issues/6353) | [pillarjs/router#96](https://github.com/pillarjs/router/pull/96) (Qard) | 💬 Reached out to help spec & unify |
| Fastify | `fastify` | `packages/node/src/integrations/tracing/fastify/` | — | — | ✅ Ships TracingChannel natively (`tracing:fastify.request.handler`) |
| Koa | `koa` | `packages/node/src/integrations/tracing/koa.ts` | — | — | 📝 Proposal drafted |
| Hapi | `@hapi/hapi` | `packages/node/src/integrations/tracing/hapi/` | — | — | ⬜ Not started |
| Connect | `connect` | `packages/node/src/integrations/tracing/connect.ts` | — | — | ⬜ Not started |

### Databases

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| PostgreSQL | `pg` | `packages/node/src/integrations/tracing/postgres.ts` | [node-postgres#3619](https://github.com/brianc/node-postgres/issues/3619) | [node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650) | 🟡 PR open (replaces closed #3624) |
| MySQL | `mysql` | `packages/node/src/integrations/tracing/mysql.ts` | — | — | 🔴 Unmaintained — use `mysql2` |
| MySQL2 | `mysql2` | `packages/node/src/integrations/tracing/mysql2.ts` | [node-mysql2#4174](https://github.com/sidorares/node-mysql2/issues/4174) | [node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | ✅ **Merged** (2026-03-14) |
| MongoDB | `mongodb` | `packages/node/src/integrations/tracing/mongo.ts` | [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) | — | 💬 Issue opened |
| Mongoose | `mongoose` | `packages/node/src/integrations/tracing/mongoose.ts` | [mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) | — | 💬 Issue opened |
| Redis | `redis` | `packages/node/src/integrations/tracing/redis.ts` | [node-redis#2590](https://github.com/redis/node-redis/issues/2590) | [node-redis#3195](https://github.com/redis/node-redis/pull/3195) | ✅ **Merged** (2026-04-02) |
| IORedis | `ioredis` | `packages/node/src/integrations/tracing/redis.ts` | — | [ioredis#2089](https://github.com/redis/ioredis/pull/2089) | ✅ **Merged** (2026-04-07) |
| Tedious (MSSQL) | `tedious` | `packages/node/src/integrations/tracing/tedious.ts` | [tedious#1727](https://github.com/tediousjs/tedious/issues/1727) | — | 💬 Issue opened |
| Knex | `knex` | `packages/node/src/integrations/tracing/knex.ts` | [knex#6394](https://github.com/knex/knex/issues/6394) | [knex#6410](https://github.com/knex/knex/pull/6410) | 🟡 PR open |
| Prisma | `prisma` | `packages/node/src/integrations/tracing/prisma.ts` | [prisma#29353](https://github.com/prisma/prisma/issues/29353) | — | 💬 Issue opened |

### GraphQL

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| GraphQL | `graphql` | `packages/node/src/integrations/tracing/graphql.ts` | [graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629) | — | 💬 Issue opened |

### Message Queues

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| Kafka | `kafkajs` | `packages/node/src/integrations/tracing/kafka.ts` | — | — | ⬜ Not started |
| AMQP (RabbitMQ) | `amqplib` | `packages/node/src/integrations/tracing/amqplib.ts` | — | — | ⬜ Not started |

### Utilities

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| DataLoader | `dataloader` | `packages/node/src/integrations/tracing/dataloader.ts` | — | — | ⬜ Not started |
| Generic Pool | `generic-pool` | `packages/node/src/integrations/tracing/genericPool.ts` | — | — | ⬜ Not started |
| LRU Memoizer | `lru-memoizer` | `packages/node/src/integrations/tracing/lrumemoizer.ts` | — | — | ⏭️ Skipped — thin wrapper over `lru-cache`, covered by lru-cache TracingChannel work |

### Filesystem / Fetch

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| FS | `fs` (Node built-in) | `packages/node/src/integrations/fs.ts` | — | — | ⬜ Not started |
| Undici | `undici` / native fetch | `packages/node/src/integrations/node-fetch.ts` | — | — | ⬜ Not started |

## Sentry-Built (10) — Need API Migration Only

Core logic is ours — only OTel base classes need swapping.

### Framework-Specific

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| Hono | `hono` | `packages/node/src/integrations/tracing/hono/` | [hono#4842](https://github.com/honojs/hono/issues/4842) | — | 💬 Issue opened |
| Postgres.js | `postgres` | `packages/node/src/integrations/tracing/postgresjs.ts` | — | — | ⬜ Not started |
| Firebase | `firebase-admin` | `packages/node/src/integrations/tracing/firebase/` | — | — | ⬜ Not started |

### AI / ML Providers

| Integration | Target Package | Sentry Location | Upstream Issue | Upstream PR | Status |
|---|---|---|---|---|---|
| OpenAI | `openai` | `packages/node/src/integrations/tracing/openai/` | [openai-node#1819](https://github.com/openai/openai-node/issues/1819) | — | 💬 Issue opened |
| Anthropic AI | `@anthropic-ai/sdk` | `packages/node/src/integrations/tracing/anthropic-ai/` | — | — | ⬜ Not started |
| Google GenAI | `@google/genai` | `packages/node/src/integrations/tracing/google-genai/` | — | — | ⬜ Not started |
| LangChain | `langchain` / `@langchain/*` | `packages/node/src/integrations/tracing/langchain/` | — | — | ⬜ Not started |
| LangGraph | `@langchain/langgraph` | `packages/node/src/integrations/tracing/langgraph/` | — | — | ⬜ Not started |
| Vercel AI (Node) | `ai` | `packages/node/src/integrations/tracing/vercelai/` | [ai#14410](https://github.com/vercel/ai/issues/14410) | — | 💬 Issue opened |
| Vercel AI (Cloudflare) | `ai` | `packages/cloudflare/src/integrations/tracing/vercelai.ts` | — | — | ⬜ Not started |

## Other TracingChannel PRs (not in Sentry tracker)

| Library | Sentry Issue | Upstream PR | Status |
|---|---|---|---|
| h3 | — | [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) | ✅ **Merged** (2025-12-30) |
| h3 (rename) | — | [h3js/h3#1294](https://github.com/h3js/h3/pull/1294) | ✅ **Merged** (2026-02-05) |
| srvx | — | [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) | ✅ **Merged** (2025-12-11) |
| srvx (rename) | — | [h3js/srvx#176](https://github.com/h3js/srvx/pull/176) | ✅ **Merged** (2026-02-05) |
| unstorage | [sentry-javascript#18022](https://github.com/getsentry/sentry-javascript/issues/18022) | [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) | ✅ **Merged** (2026-02-25) |
| db0 | [sentry-javascript#18023](https://github.com/getsentry/sentry-javascript/issues/18023) | [unjs/db0#193](https://github.com/unjs/db0/pull/193) | 🟡 PR open |
| Nitro | — | [nitrojs/nitro#4001](https://github.com/nitrojs/nitro/pull/4001) (pi0) | ✅ **Merged** (2026-04-13) |
| Elysia | — | [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809) | 💬 In discussion |

## Logging Libraries

| Library | Upstream PR | Channel Type | Status |
|---|---|---|---|
| pino | [pinojs/pino#2281](https://github.com/pinojs/pino/pull/2281) | TracingChannel (`traceSync`) | ✅ **Merged** (v9.10.0, 2025-09) |
| consola | — | Plain `diagnostics_channel` | 📝 Proposal drafted |

## Ecosystem Coordination

- [e18e ecosystem issue #255](https://github.com/e18e/ecosystem-issues/issues/255) — umbrella issue for driving TracingChannel adoption
- [untracing](https://github.com/unjs/untracing) — shared utility for library authors to standardize TracingChannel usage

## Progress Summary

| Category | Total | ✅ Merged | 🟡 PR Open | 💬 In Discussion | ⬜ Not Started |
|---|---|---|---|---|---|
| OTel-provided | 24 | 4 (mysql2, fastify, redis, ioredis) | 2 (pg, knex) | 6 (express, mongodb, mongoose, tedious, prisma, graphql) | 11 + 1 📝 (koa) |
| Sentry-built | 10 | 0 | 0 | 2 (hono, vercel-ai-node) | 8 |
| Other (non-Sentry) | 8 | 6 | 1 (db0) | 1 (elysia) | 0 |
| Logging | 2 | 1 (pino) | 0 | 0 | 0 + 1 📝 (consola) |
| **Total** | **44** | **11** | **3** | **9** | **21** |
