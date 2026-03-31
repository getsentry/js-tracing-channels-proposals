# TracingChannel Proposals

This repo contains proposals and PRs for adding Node.js `diagnostics_channel` `TracingChannel` support to popular libraries, enabling native observability event subscriptions for all APM tools.

## Structure

```
proposals/           — Individual proposal documents (one per library)
skills/              — Agent skills for generating new proposals
```

## Existing Proposals

| Library | Target Package | Repo | Status |
|---|---|---|---|
| [node-redis](proposals/node-redis.md) | `redis` | [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) | PR open |
| [ioredis](proposals/ioredis.md) | `ioredis` | [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) | PR open |
| [pg](proposals/pg.md) | `pg` / `pg-pool` | [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | PR open |
| [mysql2](proposals/mysql2.md) | `mysql2` | [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | **Merged** |
| [mongodb](proposals/mongodb.md) | `mongodb` | — | Proposal, under discussion |
| [tedious](proposals/tedious.md) | `tedious` | — | Draft (not yet submitted) |

## Skills

**You MUST read the relevant skill file before starting any task.**

| Skill | When to use | File |
|---|---|---|
| `skills/propose-tracing-channel-pattern-for-a-library-or-a-framework.md` | Asked to create a proposal, draft an issue, or design channels for a new library | Read this file first |
| `skills/implement-tracing-channel-pattern-for-a-library-or-a-framework.md` | Asked to implement, code, add tracing, or create a PR for a library | Read this file first |

## Conventions

- **Channel naming:** `{npm-package-name}:{operation}` (e.g. `mysql2:query`, `ioredis:command`)
- **Context fields:** Map to [OTel database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/)
- **Backward compat:** Zero-cost when no subscribers, graceful degradation on Node < 19.9. Use `shouldTrace` helper (`hasSubscribers !== false`) — never raw truthiness checks — to handle Node versions where `hasSubscribers` is `undefined`
- **Prior art:** Always link `undici` (Node core), plus all existing proposals/PRs
