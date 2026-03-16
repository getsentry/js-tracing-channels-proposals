# TracingChannel Migration Tracker

> Replacing OTel monkey-patching (IITM/RITM) with native `diagnostics_channel` `TracingChannel` support.
> 37 total instrumentations in Sentry JS SDK: 24 OTel-provided + 13 Sentry-built.

## OTel-Provided (24) — Need Full Rewrite or Drop

These currently depend on OTel's monkey-patching infrastructure (IITM/RITM).

### HTTP / Web Frameworks

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| HTTP | `http`/`https` (Node built-in) | `packages/node/src/integrations/http.ts` | — | Not started |
| Express | `express` | `packages/node/src/integrations/tracing/express.ts` | Joining [pillarjs/router#96](https://github.com/pillarjs/router/pull/96) (Qard) + [express#6353](https://github.com/expressjs/express/issues/6353) | Reached out to help spec & unify |
| Fastify | `fastify` | `packages/node/src/integrations/tracing/fastify/` | — | Not started |
| Koa | `koa` | `packages/node/src/integrations/tracing/koa.ts` | — | Not started |
| Hapi | `@hapi/hapi` | `packages/node/src/integrations/tracing/hapi/` | — | Not started |
| Connect | `connect` | `packages/node/src/integrations/tracing/connect.ts` | — | Not started |

### Databases

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| PostgreSQL | `pg` | `packages/node/src/integrations/tracing/postgres.ts` | [node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | PR open — no maintainer review yet |
| MySQL | `mysql` | `packages/node/src/integrations/tracing/mysql.ts` | — | Not started |
| MySQL2 | `mysql2` | `packages/node/src/integrations/tracing/mysql2.ts` | [node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | **Merged** (2026-03-15) |
| MongoDB | `mongodb` | `packages/node/src/integrations/tracing/mongo.ts` | — | Proposal sent, under discussion |
| Mongoose | `mongoose` | `packages/node/src/integrations/tracing/mongoose.ts` | — | Not started |
| Redis | `redis` | `packages/node/src/integrations/tracing/redis.ts` | [node-redis#3195](https://github.com/redis/node-redis/pull/3195) | PR open — approved by Qard + tlhunter |
| IORedis | `ioredis` | `packages/node/src/integrations/tracing/redis.ts` | [ioredis#2089](https://github.com/redis/ioredis/pull/2089) | PR open — contributor acknowledged, pending review |
| Tedious (MSSQL) | `tedious` | `packages/node/src/integrations/tracing/tedious.ts` | — | Proposal drafted |
| Knex | `knex` | `packages/node/src/integrations/tracing/knex.ts` | — | Not started |
| Prisma | `prisma` | `packages/node/src/integrations/tracing/prisma.ts` | — | Not started |

### GraphQL

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| GraphQL | `graphql` | `packages/node/src/integrations/tracing/graphql.ts` | — | Not started |

### Message Queues

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| Kafka | `kafkajs` | `packages/node/src/integrations/tracing/kafka.ts` | — | Not started |
| AMQP (RabbitMQ) | `amqplib` | `packages/node/src/integrations/tracing/amqplib.ts` | — | Not started |

### Utilities

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| DataLoader | `dataloader` | `packages/node/src/integrations/tracing/dataloader.ts` | — | Not started |
| Generic Pool | `generic-pool` | `packages/node/src/integrations/tracing/genericPool.ts` | — | Not started |
| LRU Memoizer | `lru-memoizer` | `packages/node/src/integrations/tracing/lrumemoizer.ts` | — | Not started |

### Filesystem / Fetch

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| FS | `fs` (Node built-in) | `packages/node/src/integrations/fs.ts` | — | Not started |
| Undici | `undici` / native fetch | `packages/node/src/integrations/node-fetch.ts` | — | Not started |

## Sentry-Built (13) — Need API Migration Only

Core logic is ours — only OTel base classes need swapping.

### Core / HTTP

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| SentryHttpInstrumentation | `http`/`https` (Node built-in) | `packages/node-core/src/integrations/http/` | — | Not started |
| SentryNodeFetchInstrumentation | `undici` / native fetch | `packages/node-core/src/integrations/node-fetch/` | — | Not started |
| HTTP Server Spans | `http`/`https` (Node built-in) | `packages/node-core/src/integrations/http/httpServerSpansIntegration.ts` | — | Not started |

### Framework-Specific

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| Hono | `hono` | `packages/node/src/integrations/tracing/hono/` | — | Not started |
| Postgres.js | `postgres` | `packages/node/src/integrations/tracing/postgresjs.ts` | — | Not started |
| Firebase | `firebase-admin` | `packages/node/src/integrations/tracing/firebase/` | — | Not started |

### AI / ML Providers

| Integration | Target Package | Sentry Location | Upstream PR | Status |
|---|---|---|---|---|
| OpenAI | `openai` | `packages/node/src/integrations/tracing/openai/` | — | Not started |
| Anthropic AI | `@anthropic-ai/sdk` | `packages/node/src/integrations/tracing/anthropic-ai/` | — | Not started |
| Google GenAI | `@google/genai` | `packages/node/src/integrations/tracing/google-genai/` | — | Not started |
| LangChain | `langchain` / `@langchain/*` | `packages/node/src/integrations/tracing/langchain/` | — | Not started |
| LangGraph | `@langchain/langgraph` | `packages/node/src/integrations/tracing/langgraph/` | — | Not started |
| Vercel AI (Node) | `ai` | `packages/node/src/integrations/tracing/vercelai/` | — | Not started |
| Vercel AI (Cloudflare) | `ai` | `packages/cloudflare/src/integrations/tracing/vercelai.ts` | — | Not started |

## Other TracingChannel PRs (not in Sentry tracker)

| Library | PR | Status |
|---|---|---|
| h3 | [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) | **Merged** (2025-12-30) |
| h3 (rename) | [h3js/h3#1294](https://github.com/h3js/h3/pull/1294) | **Merged** (2026-02-05) |
| srvx | [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) | **Merged** (2025-12-11) |
| srvx (rename) | [h3js/srvx#176](https://github.com/h3js/srvx/pull/176) | **Merged** (2026-02-05) |
| unstorage | [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) | **Merged** (2026-02-25) |
| db0 | [unjs/db0#193](https://github.com/unjs/db0/pull/193) | PR open |

## Progress Summary

| Category | Total | Merged | PR Open | In Discussion | Not Started |
|---|---|---|---|---|---|
| OTel-provided | 24 | 1 (mysql2) | 3 (pg, redis, ioredis) | 1 (mongodb) | 19 |
| Sentry-built | 13 | 0 | 0 | 0 | 13 |
| Other (non-Sentry) | 6 | 5 | 1 (db0) | 0 | 0 |
| **Total** | **43** | **6** | **4** | **1** | **32** |
