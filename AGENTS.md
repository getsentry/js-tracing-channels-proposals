# TracingChannel Proposals

This repo contains proposals and PRs for adding Node.js `diagnostics_channel` `TracingChannel` support to popular libraries, replacing monkey-patching (IITM/RITM) with native event subscriptions.

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
| [mysql2](proposals/mysql2.md) | `mysql2` | — | Draft (not yet submitted) |

## Skills

| Skill | Purpose |
|---|---|
| `skills/propose.md` | Create a new TracingChannel proposal for a library (API design, channel names, context fields) |
| `skills/implement.md` | Implement TracingChannel support in a library's codebase (code, tests, PR) |

## Creating a New Proposal

Use the skill at `skills/propose.md`. It will:

1. Research the target library and its OTel instrumentation
2. Design channel names and context properties mapped to OTel semantic conventions
3. Draft the proposal using the established template
4. Reference all existing proposals as prior art

**Key rule:** Always read ALL files in `proposals/` before writing a new one. Each proposal builds on patterns from previous ones.

## Conventions

- **Channel naming:** `{npm-package-name}:{operation}` (e.g. `mysql2:query`, `ioredis:command`)
- **Context fields:** Map to [OTel database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/)
- **Backward compat:** Zero-cost when no subscribers, graceful degradation on Node < 19.9
- **Prior art:** Always link `undici` (Node core), plus all existing proposals/PRs
