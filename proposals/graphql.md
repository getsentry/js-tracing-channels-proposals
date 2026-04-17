# graphql: `TracingChannel` Proposal

> **Issue:** [graphql/graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629)
> **Status:** 💬 Issue opened

---

I'd like to propose adding first-class [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support to `graphql-js`, following the pattern established by [`undici`](https://github.com/nodejs/undici) in Node.js core.

## Motivation

### The observability gap in graphql-js

graphql-js is deliberately minimal — it provides the execution engine and nothing else. There are no built-in hooks, middleware, plugins, or tracing APIs. This is a strength for a reference implementation, but it means **every** APM tool must resort to monkey-patching to observe what the engine is doing.

Today, `@opentelemetry/instrumentation-graphql` patches `parse`, `validate`, and `execute`, then recursively traverses the entire schema at instrumentation time to wrap every field resolver's `resolve` function. Datadog's `dd-trace` does the same. Sentry does the same. Every APM vendor independently patches the same three functions and walks the same schema tree — fragile, duplicative, and version-coupled.

This has broader ecosystem concerns:

- **Runtime lock-in:** RITM and IITM rely on Node.js-specific module loader internals (`Module._resolveFilename`, `module.register()`). They don't work on Bun or Deno, which implement the Node.js API surface but not the module loader internals.
- **ESM fragility:** IITM is built on Node.js's module customization hooks, which are still evolving and have been a persistent source of breakage in the OTEL JS ecosystem.
- **Initialization ordering:** Both require instrumentation to be set up before `graphql` is first `require()`'d / `import`'d. Get the order wrong and instrumentation silently does nothing — very hard to debug in production.
- **Bundling:** Users must ensure instrumented modules are externalized, which is increasingly difficult as frameworks bundle server-side code into single executables or deployment files.
- **Schema walking is expensive.** Every APM tool recursively wraps every resolver on every type in the schema at setup time. This is O(fields) work that runs once per instrumented schema — and if the schema is rebuilt (e.g., in a gateway), it runs again. Native emission eliminates this entirely.

`TracingChannel` solves all of these. It provides structured lifecycle events (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) with built-in async context propagation, zero-cost when no subscribers are attached, and a standardized subscription model that requires no monkey-patching.

### Cross-platform compatibility

A previous discussion ([#3133](https://github.com/graphql/graphql-js/issues/3133)) raised the concern that `diagnostics_channel` is Node.js-specific and graphql-js targets multiple platforms. The ecosystem has moved on since then:

- **Bun** supports `node:diagnostics_channel` including `TracingChannel` ([Bun docs](https://bun.sh/docs/runtime/nodejs-apis#node-diagnostics-channel))
- **Deno** supports `node:diagnostics_channel` via its Node.js compatibility layer ([Deno docs](https://docs.deno.com/api/node/diagnostics_channel/))

Every server-side JavaScript runtime that runs graphql-js in production now supports `diagnostics_channel`. Browser environments don't need APM tracing at the execution engine level; browsers run GraphQL clients, not servers.

That said, graphql-js is deliberately isomorphic and has zero runtime-specific imports in `src/`. To preserve that invariant, this proposal does not have graphql-js import `node:diagnostics_channel` itself. Instead, graphql-js exposes a public API for enabling tracing, and APMs (or runtime-specific adapters) hand the module in when they set up. Details in the [Public API](#public-api) section below.

---

## Proposed Tracing Channels

All channels use the Node.js [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) API, which provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` sub-channels automatically.

| TracingChannel | Tracks | Context fields |
|---|---|---|
| `graphql:execute` | `execute()` — full operation execution lifecycle | `operationType`, `operationName`, `document`, `schema`, `variableValues` |
| `graphql:parse` | `parse()` — query string to AST | `source` |
| `graphql:validate` | `validate()` — AST validation against schema | `document`, `schema` |
| `graphql:resolve` | Individual field resolver execution | `fieldName`, `fieldPath`, `fieldType`, `parentType`, `args` |
| `graphql:subscribe` | `subscribe()` — subscription setup | `operationType`, `operationName`, `document`, `schema`, `variableValues` |

### Why These Channels

- **`graphql:execute`** is the primary channel. It wraps the full operation execution — from `execute()` invocation through all field resolution to the final `ExecutionResult`. This is where APM tools create the top-level span (e.g., `query GetUser` or `mutation CreatePost`). Maps directly to OTel's `graphql.execute` span.
- **`graphql:parse`** and **`graphql:validate`** are separate phases with distinct payload shapes and performance characteristics. Parse failures and validation errors are important diagnostic signals. Both OTel and Datadog create separate spans for these.
- **`graphql:resolve`** covers individual field resolver execution. This is the noisiest channel — a single query can trigger hundreds of resolver calls. However, it's critical for identifying slow resolvers in production. APM tools control noise via depth limiting and trivial-resolver filtering on the subscriber side. The channel emits for **every** resolver invocation; subscribers decide what to trace.
- **`graphql:subscribe`** wraps subscription setup (`subscribe()` → source event stream creation). Each subsequent event goes through `graphql:execute` as normal, so the execute channel covers ongoing subscription events.

### Context Properties

#### Execute Channel (`graphql:execute`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `operationType` | `operation.operation` (`query`, `mutation`, `subscription`) | `graphql.operation.type` |
| `operationName` | `operation.name?.value` | `graphql.operation.name` |
| `document` | The parsed `DocumentNode` AST | `graphql.source` (APM serializes) |
| `schema` | The `GraphQLSchema` object | Schema introspection |
| `variableValues` | Variables passed to execution (APM serializes/sanitizes) | `graphql.variables.*` |

#### Parse Channel (`graphql:parse`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `source` | The GraphQL query string or `Source` object | `graphql.source` |

#### Validate Channel (`graphql:validate`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `document` | The parsed `DocumentNode` AST | Query identification |
| `schema` | The `GraphQLSchema` object | Schema identification |

#### Resolve Channel (`graphql:resolve`)

| Field | Source | OTEL attribute it enables |
|---|---|---|
| `fieldName` | `info.fieldName` | `graphql.field.name` |
| `fieldPath` | `info.path` serialized (e.g., `users.0.name`) | `graphql.field.path` |
| `fieldType` | `info.returnType` stringified | `graphql.field.type` |
| `parentType` | `info.parentType.name` | `graphql.parent.name` |
| `args` | Arguments passed to the resolver | Field-level debugging |

#### Subscribe Channel (`graphql:subscribe`)

Same context shape as the execute channel.

---

## Public API

graphql-js owns the channel names and is responsible for emitting events; APMs (or framework adapters) own the acquisition of `node:diagnostics_channel` and register it with graphql-js at setup. This keeps graphql-js free of any runtime-specific imports while still delivering true auto-instrumentation once an APM is loaded.

### Structural types

Minimal, structural versions of Node's `diagnostics_channel` types. `node:diagnostics_channel` satisfies these by duck typing, so no dependency on `@types/node` is required.

```ts
export interface MinimalChannel {
  readonly hasSubscribers: boolean;
  publish(message: unknown): void;
}

export interface MinimalTracingChannel {
  readonly hasSubscribers: boolean;
  readonly start: MinimalChannel;
  readonly end: MinimalChannel;
  readonly asyncStart: MinimalChannel;
  readonly asyncEnd: MinimalChannel;
  readonly error: MinimalChannel;

  traceSync<T>(
    fn: (...args: unknown[]) => T,
    ctx: object,
    thisArg?: unknown,
    ...args: unknown[]
  ): T;

  tracePromise<T>(
    fn: (...args: unknown[]) => Promise<T>,
    ctx: object,
    thisArg?: unknown,
    ...args: unknown[]
  ): Promise<T>;
}

export interface MinimalDiagnosticsChannel {
  tracingChannel(name: string): MinimalTracingChannel;
}

export interface GraphQLChannels {
  execute: MinimalTracingChannel;
  parse: MinimalTracingChannel;
  validate: MinimalTracingChannel;
  resolve: MinimalTracingChannel;
  subscribe: MinimalTracingChannel;
}
```

### `enableDiagnosticsChannel(dc)`

The single public function APMs call to register the module:

```ts
let channels: GraphQLChannels | undefined;

// PRIVATE: used by graphql-js internals at emission sites
export function getChannels(): GraphQLChannels | undefined {
  return channels;
}

// PUBLIC
export function enableDiagnosticsChannel(dc: MinimalDiagnosticsChannel): void {
  channels = {
    execute: dc.tracingChannel('graphql:execute'),
    parse: dc.tracingChannel('graphql:parse'),
    validate: dc.tracingChannel('graphql:validate'),
    resolve: dc.tracingChannel('graphql:resolve'),
    subscribe: dc.tracingChannel('graphql:subscribe'),
  };
}
```

Shape-wise this matches the existing `enableDevMode()` in `src/devMode.ts`: module-level state, top-level `enable*` function, void return. It's the closest fit to graphql-js's existing conventions rather than inventing a new API shape.

### Why graphql-js owns the channel names

Because graphql-js calls `dc.tracingChannel(name)` internally with canonical names, multiple APMs all converge on the same cached `TracingChannel` instances. An APM can't subtly break subscription coexistence by drifting on the string `"graphql:execute"`; the name only exists in graphql-js itself. `node:diagnostics_channel` caches channels by name, so concurrent registrations from multiple APMs land on identical underlying instances and all subscribers receive all events.

### Ordering and re-registration

`enableDiagnosticsChannel` can be called at any time. APMs are not forced into an init race: subscribers attached before or after registration all converge on the same cached channels. Re-registering with the same module is a structural no-op; re-registering with a different module replaces the stored references, but since `node:diagnostics_channel` is a module singleton, that case is practically limited to isolation/testing.

---

## How APM Tools Use This

### Today: Monkey-Patching 3 Functions + Walking the Entire Schema

To instrument graphql-js today, `@opentelemetry/instrumentation-graphql` uses IITM/RITM to intercept the module and patch internals:

```js
// Simplified from @opentelemetry/instrumentation-graphql

// 1. Patch parse
wrap(parseModule, 'parse', original => function patchedParse(source, options) {
  const span = tracer.startSpan('graphql.parse');
  try {
    const result = original.call(this, source, options);
    span.setAttribute('graphql.source', source.toString());
    return result;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
});

// 2. Patch validate
wrap(validateModule, 'validate', original => function patchedValidate(schema, document, rules) {
  const span = tracer.startSpan('graphql.validate');
  const errors = original.call(this, schema, document, rules);
  if (errors.length) span.setAttribute('graphql.validation.error', errors.map(String));
  span.end();
  return errors;
});

// 3. Patch execute — the big one
wrap(executeModule, 'execute', original => function patchedExecute(args) {
  // Extract operation metadata from the document AST
  const operationDef = getOperationDefinition(args.document);
  const operationType = operationDef?.operation ?? 'query';
  const operationName = operationDef?.name?.value ?? 'anonymous';

  const span = tracer.startSpan(`${operationType} ${operationName}`, {
    attributes: {
      'graphql.operation.type': operationType,
      'graphql.operation.name': operationName,
      'graphql.source': print(args.document),
    },
  });

  // 4. WALK THE ENTIRE SCHEMA to wrap every resolver
  //    This runs on every execute() call (or once per schema, cached)
  wrapFields(args.schema, tracer, depth, options);

  return context.with(trace.setSpan(context.active(), span), () => {
    const result = original.call(this, args);
    return Promise.resolve(result).then(res => {
      span.end();
      return res;
    });
  });
});

// The resolver wrapping function — recursively walks all types
function wrapFields(schema, tracer, depth, options) {
  const typeMap = schema.getTypeMap();
  for (const [typeName, type] of Object.entries(typeMap)) {
    if (!isObjectType(type) || typeName.startsWith('__')) continue;
    const fields = type.getFields();
    for (const [fieldName, field] of Object.entries(fields)) {
      const originalResolve = field.resolve ?? defaultFieldResolver;
      field.resolve = function tracedResolve(source, args, context, info) {
        const span = tracer.startSpan(`${typeName}.${fieldName}`, {
          attributes: {
            'graphql.field.name': fieldName,
            'graphql.field.path': responsePathToString(info.path),
            'graphql.field.type': String(info.returnType),
          },
        });
        // ... wrap sync/async resolver, handle errors, end span ...
      };
    }
  }
}
```

This approach has several problems beyond the standard monkey-patching fragility:
- **Schema walking is O(fields).** For a schema with 500 types averaging 10 fields each, that's 5,000 resolver wraps. In a gateway that rebuilds schemas on each request (e.g., Apollo Federation stitching), this can be a measurable startup cost.
- **Resolver wrapping mutates the schema.** Replacing `field.resolve` modifies the schema object in place. If multiple APM tools instrument the same schema, they stack wrappers — each calling the other's wrapper, not the original resolver.
- **No way to unwrap cleanly.** Once `field.resolve` is replaced, the original reference is captured in a closure. Disabling instrumentation doesn't restore the original resolvers.

### With TracingChannel: Subscribe to Structured Events

APMs enable tracing by handing graphql-js the `node:diagnostics_channel` module, then subscribing to the channel names that graphql-js exposes:

```js
const dc = require('node:diagnostics_channel');
const { enableDiagnosticsChannel } = require('graphql');

// Register the diagnostics_channel module with graphql-js (runtime-agnostic core stays clean).
enableDiagnosticsChannel(dc);

// Subscribe to operation execution — the primary span
dc.tracingChannel('graphql:execute').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan(`${ctx.operationType} ${ctx.operationName}`, {
      attributes: {
        'graphql.operation.type': ctx.operationType,
        'graphql.operation.name': ctx.operationName,
        'graphql.source': print(ctx.document),
      },
    });
  },
  asyncEnd(ctx) {
    ctx.span?.end();
  },
  error(ctx) {
    ctx.span?.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error?.message });
    ctx.span?.recordException(ctx.error);
  },
});

// Subscribe to parse/validate
dc.tracingChannel('graphql:parse').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan('graphql.parse');
  },
  end(ctx) { ctx.span?.end(); },  // parse is synchronous
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});

dc.tracingChannel('graphql:validate').subscribe({
  start(ctx) {
    ctx.span = tracer.startSpan('graphql.validate');
  },
  end(ctx) { ctx.span?.end(); },  // validate is synchronous
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});

// Subscribe to resolver execution — with depth control on the subscriber side
dc.tracingChannel('graphql:resolve').subscribe({
  start(ctx) {
    const depth = ctx.fieldPath.split('.').length;
    if (depth > maxDepth) return;  // subscriber-side depth limiting
    ctx.span = tracer.startSpan(`${ctx.parentType}.${ctx.fieldName}`, {
      attributes: {
        'graphql.field.name': ctx.fieldName,
        'graphql.field.path': ctx.fieldPath,
        'graphql.field.type': ctx.fieldType,
      },
    });
  },
  asyncEnd(ctx) { ctx.span?.end(); },
  error(ctx) { ctx.span?.setStatus({ code: SpanStatusCode.ERROR }); },
});
```

**What changes for APM vendors:**

| Concern | Monkey-patching (today) | TracingChannel (proposed) |
|---|---|---|
| **Setup** | Must intercept module load via IITM/RITM before first `require('graphql')` | Subscribe to `diagnostics_channel` at any time — no ordering constraint |
| **Scope** | Patch 3 functions + walk entire schema to wrap every resolver | Subscribe to 5 channels |
| **Schema mutation** | Replaces `field.resolve` on every field in the schema | No schema mutation — graphql-js emits events, subscribers observe |
| **Multi-vendor** | Stacked resolver wrappers call each other | Independent subscribers, no interference |
| **Teardown** | Cannot cleanly unwrap resolvers once patched | `unsubscribe()` — clean, reversible |
| **Performance** | O(fields) schema walking at setup + wrapper overhead per resolver call | Zero-cost when no subscribers, single emission point per resolver |
| **Version coupling** | Depends on `parse`, `validate`, `execute` export paths + schema type internals | Stable channel contract — graphql-js can refactor internals freely |
| **Runtime support** | Node.js only (IITM/RITM don't work on Bun/Deno) | Any runtime with `diagnostics_channel` support |

---

## Implementation Notes

### Insertion Points

Based on graphql-js's execution flow:

1. **`graphql:parse`** — wrap `parse()` in `src/language/parser.ts`. Parse is synchronous — `TracingChannel.traceSync` is the appropriate wrapper.

2. **`graphql:validate`** — wrap `validate()` in `src/validation/validate.ts`. Validate is also synchronous.

3. **`graphql:execute`** — wrap `execute()` in `src/execution/execute.ts`. Execute may return a `Promise<ExecutionResult>` or a synchronous `ExecutionResult` depending on resolver async-ness. Use `tracePromise` when the result is a Promise, `traceSync` when it's synchronous (or check with `isPromise()`).

4. **`graphql:resolve`** — emit from the field execution path in `completeValue()` / `executeField()` within `src/execution/execute.ts`. This is where each resolver is invoked. The emission point should be inside the engine, not by wrapping `field.resolve` — this avoids schema mutation entirely.

5. **`graphql:subscribe`** — wrap `subscribe()` in `src/execution/subscribe.ts`.

### v17 Executor Class

In v17, execution is refactored into an `Executor` class (`src/execution/Executor.ts`). TracingChannel integration would be cleaner here — `executeField()` and `completeValue()` are class methods that can emit events without function-level patching. The standalone `execute()` function is a thin wrapper around `Executor`, so instrumenting the class covers both APIs.

### Sync vs Async Execution

graphql-js has a dual sync/async execution model:
- `parse()` and `validate()` are always synchronous
- `execute()` returns `ExecutionResult | Promise<ExecutionResult>` depending on resolver types
- Individual resolvers can be sync or async

For TracingChannel:
- `graphql:parse` and `graphql:validate` use `traceSync`
- `graphql:execute` checks `isPromise(result)` and uses `tracePromise` or `traceSync` accordingly
- `graphql:resolve` similarly branches — but since most resolvers are sync (default property access), the fast path avoids Promise wrapping

### Resolver Emission and Noise

The `graphql:resolve` channel emits for **every** resolver invocation, including trivial default resolvers (property access). This is by design — the emission is cheap (a `hasSubscribers` check), and filtering belongs on the subscriber side.

APM tools already implement resolver filtering strategies:
- **Depth limiting** — only trace resolvers up to N levels deep
- **Trivial resolver skipping** — skip resolvers that are `undefined` (using the default `field.resolve ?? defaultFieldResolver`)
- **List item collapsing** — collapse `users.0.name`, `users.1.name` into `users.*.name`

The TracingChannel context includes `fieldPath` so subscribers can implement all of these strategies. Additionally, the context includes enough information for the engine to provide a `isTrivialResolver` boolean hint, letting subscribers skip trivial resolvers without needing to inspect the schema:

| Field | Source | Purpose |
|---|---|---|
| `isTrivialResolver` | `field.resolve === undefined` | Subscriber can skip default property-access resolvers |

---

## Backward Compatibility

Fully backward compatible on every axis:

- **No new dependencies.** graphql-js imports nothing new. The `MinimalDiagnosticsChannel` types are local structural definitions; `node:diagnostics_channel` is only referenced by the APMs that call `enableDiagnosticsChannel(dc)`.
- **No runtime-specific code in `src/`.** The isomorphic invariant is preserved. Non-Node runtimes that never call `enableDiagnosticsChannel` see no behavior change and no Node references anywhere in the execution path.
- **Zero cost when no APM is loaded.** If `enableDiagnosticsChannel` is never called, `getChannels()` returns `undefined` and every emission site short-circuits on a single property access. No context objects are allocated.
- **Zero cost when an APM is loaded but has no subscribers.** Each emission site is gated on `channel.hasSubscribers` before any span context is constructed.
- **No ordering constraints.** `enableDiagnosticsChannel` and APM subscriptions can happen in any order, at any time.

---

## Prior Art

This approach follows the same pattern already adopted or in progress by other major libraries:

- **`undici`** (Node.js core) — ships `TracingChannel` support since Node 20.12: [`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels)
- **`fastify`** — ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`node-redis`** — [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) (`node-redis:command`, `node-redis:connect`)
- **`ioredis`** — [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) (`ioredis:command`, `ioredis:connect`)
- **`pg` / `pg-pool`** — [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) (`pg:query`, `pg:connection`, `pg:pool:connect`)
- **`mysql2`** — [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) (`mysql2:query`, `mysql2:execute`, `mysql2:connect`, `mysql2:pool:connect`) ✅ merged
- **`mongodb`** — [NODE-7472](https://jira.mongodb.org/browse/NODE-7472) — proposal under discussion (`mongodb:command`, `mongodb:connect`, `mongodb:pool:checkout`)
- **`tedious`** — [tediousjs/tedious#1727](https://github.com/tediousjs/tedious/issues/1727) — proposal under discussion
- **`knex`** — [knex/knex#6394](https://github.com/knex/knex/issues/6394) — issue opened (`knex:query`, `knex:transaction`, `knex:pool:acquire`)
- **`mongoose`** — [Automattic/mongoose#16105](https://github.com/Automattic/mongoose/issues/16105) — issue opened (`mongoose:query`, `mongoose:aggregate`, `mongoose:save`, `mongoose:model`)
- **`@prisma/client`** — [prisma/prisma#29353](https://github.com/prisma/prisma/issues/29353) — issue opened (`prisma:client:operation`, `prisma:client:query`, `prisma:client:transaction`)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
