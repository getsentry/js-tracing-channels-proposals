# TracingChannel Proposals

This repo contains proposals and PRs for adding Node.js `diagnostics_channel` `TracingChannel` support to popular libraries, enabling native observability event subscriptions for all APM tools.

## Structure

```
proposals/           — Individual proposal documents (one per library)
skills/              — Agent skills for generating new proposals
```

## Status

Proposals live in `proposals/`, one per library. For the current status of any library (PR links, open, merged, released), use `TRACKER.md`, which is mirrored in `data/libraries.json`. Don't record statuses anywhere else; to refresh them, use the `update-tracker` skill.

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
