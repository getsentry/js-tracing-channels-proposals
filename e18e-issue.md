Native observability as a standard: adopt `diagnostics_channel.TracingChannel` across the ecosystem

---

## Overview

APM tools (Sentry, Datadog, New Relic, etc.) currently instrument popular Node.js libraries by monkey-patching their internals via [import-in-the-middle](https://github.com/nodejs/import-in-the-middle) (IITM) and [require-in-the-middle](https://github.com/nodejs/require-in-the-middle) (RITM). This is fragile, breaks with ESM, and adds overhead even when tracing is disabled.

I can summarize the core friction points caused by the current state of things into three sections.

### Multi-runtime support

Module patching doesn't work across the multi-runtime ecosystem we have today. Bun doesn't support module hooks, Deno thinks it's a bad idea in general and won't support it (it is a bad idea), and Cloudflare Workers follows suit. The browser is in a similar boat.

### Load order

Due to the nature of how patching is applied at load time, almost all APMs need to sit at the very top of the user's entrypoint, often requiring the `--import` flag to ensure patched code is applied before the user imports their first dependency.

If they don't do that, they either have parts of their app completely missing the patched methods or things not working at all.

### Externalizing and bundling

IITM needs modules to run through the module loader to be hooked and then patched. Anything that interferes with this process breaks the instrumentation. A common pattern today is server-side frameworks bundling server code for various reasons:

- Creating standalone serverless artifacts.
- Optimizing server dependencies.

This means users always need to be aware of their instrumented dependencies and make sure they are externalized by configuring the framework/bundler they are using. Today, some frameworks maintain a list of things to externalize by default, which is fragile, hard to maintain, and not sustainable. We've had countless issues caused/fixed by externalization alone.

### OTel adoption is nuanced

I think OTel is a great ecosystem but is usually the wrong abstraction layer to adopt in libraries. Some frameworks adopt `@opentelemetry/api` or even the base SDKs for Node, and this causes a major issue when working with other libraries that may do the same.

**OTel is not just a spec, it is an implementation detail** which imposes its own limitations and generally dictates the HOW of doing things. Given how much commitment is involved in adopting it, almost only frameworks do that because small libraries can't afford to. Not to mention being coupled to their release schedule, breaking changes, minimum Node version support, and so on. Arguably you can just use the `@opentelemetry/api` part to avoid pulling in implementation details, but that still feels like too high of a layer.

During the many proposals I created, I stumbled on libraries and ecosystems (e.g. redis, mongodb) trying to support observability by creating their own OTel layer, pulling in those dependencies — which I think is a mistake because it's the wrong layer to bake in as first party.

Tracing and diagnostic channels can already be used for OTel and help them move off IITM as well. A good example of this is OTel's instrumentation of `undici`:

```ts
// opentelemetry-js-contrib/packages/instrumentation-undici/src/undici.ts
// note that undici uses plain diagnostics_channel events
this.subscribeToChannel('undici:request:create', this.onRequestCreated.bind(this));
this.subscribeToChannel('undici:client:sendHeaders', this.onRequestHeaders.bind(this));
this.subscribeToChannel('undici:request:headers', this.onResponseHeaders.bind(this));
this.subscribeToChannel('undici:request:trailers', this.onDone.bind(this));
this.subscribeToChannel('undici:request:error', this.onError.bind(this));
```

## Proposal: Drive `TracingChannel` adoption

Node.js ships [`diagnostics_channel.TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#tracingchannel) — a built-in primitive that lets libraries publish structured `start`/`end`/`error` events. APM tools subscribe without patching. Zero cost when nobody is listening — `channel.hasSubscribers` short-circuits before allocating any context objects.

It also handles async context propagation and plays well with existing ecosystems like OTel (albeit with a minor patch for ALS).

When libraries adopt TracingChannel natively, all observability tools (including OTel) get a stable, first-party subscription surface. This means fewer moving parts at runtime, no ESM compatibility issues, and libraries owning their own observability surface instead of having external tools rewrite their internals at load time. This reduces the maintenance burden on both sides and benefits the entire o11y ecosystem.

I have been working with @Qard (the creator of TracingChannel) on gauging the ecosystem's appetite for adopting this API. We also started [untracing](https://github.com/unjs/untracing) — a shared utility for library authors to standardize channel naming and make adoption easier. We have a private tracker at Sentry but this table illustrates what we've been doing:

| Library | Package | Upstream | Status |
|---|---|---|---|
| mysql2 | `mysql2` | [node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) | ✅ Merged |
| h3 | `h3` | [h3#1251](https://github.com/h3js/h3/pull/1251) | ✅ Merged |
| srvx | `srvx` | [srvx#141](https://github.com/h3js/srvx/pull/141) | ✅ Merged |
| unstorage | `unstorage` | [unstorage#707](https://github.com/unjs/unstorage/pull/707) | ✅ Merged |
| PostgreSQL | `pg` | [node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | 🟡 PR open |
| node-redis | `redis` | [node-redis#3195](https://github.com/redis/node-redis/pull/3195) | 🟡 PR open |
| ioredis | `ioredis` | [ioredis#2089](https://github.com/redis/ioredis/pull/2089) | 🟡 PR open |
| db0 | `db0` | [db0#193](https://github.com/unjs/db0/pull/193) | 🟡 PR open |
| MongoDB | `mongodb` | [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) | 💬 Issue opened |
| Mongoose | `mongoose` | [mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) | 💬 Issue opened |
| Knex | `knex` | [knex#6394](https://github.com/knex/knex/issues/6394) | 💬 Issue opened |
| Prisma | `prisma` | [prisma#29353](https://github.com/prisma/prisma/issues/29353) | 💬 Issue opened |
| GraphQL | `graphql` | [graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629) | 💬 Issue opened |
| Tedious | `tedious` | [tedious#1727](https://github.com/tediousjs/tedious/issues/1727) | 💬 Issue opened |
| Express | `express` | [express#6353](https://github.com/expressjs/express/issues/6353) | 💬 Reached out |

Plus Fastify already ships TracingChannel natively, and undici (Node core) is the reference implementation — so the ecosystem already has solid examples.

### An example: mysql2

One of the successful examples is `mysql2` adopting TracingChannel into the codebase. Even though it was trickier due to the callback-heavy nature of their codebase, it still went smoothly. Here are some snippets:

#### Today with OTel

OTel's instrumentation monkey-patches mysql2's `Connection` prototype at load time via IITM:

```typescript
// opentelemetry-js-contrib/packages/instrumentation-mysql2/src/instrumentation.ts

const patch = (ConnectionPrototype: mysqlTypes.Connection) => {
  this._wrap(ConnectionPrototype, 'query', this._patchQuery(format, false));
  this._wrap(ConnectionPrototype, 'execute', this._patchQuery(format, true));
};

const unpatch = (ConnectionPrototype: mysqlTypes.Connection) => {
  this._unwrap(ConnectionPrototype, 'query');
  this._unwrap(ConnectionPrototype, 'execute');
};
```

`_patchQuery` returns a replacement function that wraps every call — extracting args, creating spans, patching callbacks — regardless of whether tracing is active:

```typescript
private _patchQuery(format, isPrepared) {
  return function wrappedQuery(...args) {
    const queryText = getQueryText(args[0], values, maskStatement);
    const span = thisPlugin.tracer.startSpan('mysql.query', { attributes });

    // Wrap the user's callback to end the span
    if (typeof args[args.length - 1] === 'function') {
      args[args.length - 1] = patchCallbackQuery(endSpan)(args[args.length - 1]);
    }

    return originalQuery.apply(this, args);
  };
}
```

#### With TracingChannel

mysql2 ([node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178)) now natively emits on `TracingChannel`. No patching needed:

```javascript
// mysql2/lib/connection.js — emit in the query path
traceCallback(
  queryChannel,
  (wrappedCb) => {
    cmdQuery.onResult = wrappedCb;
    this.addCommand(cmdQuery);
  },
  0,
  () => ({
    query: cmdQuery.sql,
    values: cmdQuery.values,
    database: this.config.database || '',
    serverAddress: server.serverAddress,
    serverPort: server.serverPort,
  }),
  null,
  cmdQuery.onResult
);
```

On the APM side, they can listen anytime, anywhere, and conditionally:

```javascript
// APM side — subscribe, no patching
dc.tracingChannel('mysql2:query').subscribe({
  start({ query }) { /* create span */ },
  asyncEnd({ query, result }) { /* finish span */ },
  error({ query, error }) { /* record error */ },
});
```

### Where e18e can help

- **Amplifying the message** to maintainers of libraries that haven't responded yet
- **Coordinating PRs** for libraries in the "not started" bucket — there are ~25 more integrations to cover including Koa, Hapi, Connect, kafkajs, amqplib, dataloader, generic-pool, and others
- **Establishing TracingChannel adoption as an ecosystem health norm** alongside dependency cleanup and performance work — perhaps it fits more in the levelup bucket? Honestly it ticks all three and it's already built into Node, there is nothing to build, only adopt.
