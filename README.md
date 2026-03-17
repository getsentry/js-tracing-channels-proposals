# TracingChannel Proposals

Proposals and PRs for adding Node.js [`diagnostics_channel.TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#tracingchannel) support to popular npm libraries — replacing OpenTelemetry's monkey-patching infrastructure (IITM/RITM) with native, zero-overhead event subscriptions.

## Why

OpenTelemetry's Node.js instrumentation relies on [import-in-the-middle](https://github.com/nicolo-ribaudo/import-in-the-middle) (IITM) and [require-in-the-middle](https://github.com/nicolo-ribaudo/require-in-the-middle) (RITM) to monkey-patch library internals. This approach is fragile, breaks with ESM, and adds overhead even when tracing is disabled.

Node.js 19.9+ ships `diagnostics_channel.TracingChannel`, a built-in mechanism that lets libraries publish structured `start`/`end`/`asyncStart`/`asyncEnd`/`error` events. Consumers (Sentry, Datadog, New Relic, etc.) subscribe without patching — zero cost when nobody is listening.

## Proposals

| Library | Package | PR | Status |
|---|---|---|---|
| [node-redis](proposals/node-redis.md) | `redis` | [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) | PR open |
| [ioredis](proposals/ioredis.md) | `ioredis` | [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) | PR open |
| [pg](proposals/pg.md) | `pg` / `pg-pool` | [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | PR open |
| [mysql2](proposals/mysql2.md) | `mysql2` | [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | **Merged** |
| [mongodb](proposals/mongodb.md) | `mongodb` | — | Under discussion |
| [tedious](proposals/tedious.md) | `tedious` | — | Proposal drafted |
| [elysia](proposals/elysia.md) | `elysia` | — | Proposal drafted |

See [TRACKER.md](TRACKER.md) for the full migration tracker across all 44 instrumentations (OTel-provided, Sentry-built, and ecosystem).

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

## Prior Art

- **undici** (Node core) — the reference implementation, ships TracingChannel support since Node 19.9
- **h3** — [merged](https://github.com/h3js/h3/pull/1251)
- **srvx** — [merged](https://github.com/h3js/srvx/pull/141)
- **unstorage** — [merged](https://github.com/unjs/unstorage/pull/707)

## Related

- [Node.js `diagnostics_channel` docs](https://nodejs.org/api/diagnostics_channel.html)
- [Sentry JS SDK](https://github.com/getsentry/sentry-javascript)
- [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js)
