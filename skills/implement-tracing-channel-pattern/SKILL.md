# Skill: Implement TracingChannel Support in a Library

You are implementing Node.js `TracingChannel` (`node:diagnostics_channel`) support in a library so APM tools (OTEL, Datadog, Sentry) can instrument it **without monkey-patching**.

**Prerequisite:** A proposal should already exist in `proposals/` for the target library (created via the `propose.md` skill). Read the proposal first — it defines the channel names, context fields, and scope. This skill is about the code implementation, not the API design.

## Background

`TracingChannel` is a Node.js API that provides a structured pub/sub mechanism for tracing async operations. Each `TracingChannel` automatically creates 5 sub-channels: `start`, `end`, `asyncStart`, `asyncEnd`, `error`. APM libraries subscribe to these channels to build spans, track latency, and correlate distributed traces. The channel names follow the pattern `tracing:<name>:<event>`.

## Reference implementations

| Library | PR | Key patterns |
|---|---|---|
| node-redis | [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) | First implementation, batch MULTI/pipeline support |
| ioredis | [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089) | Port to different architecture, IPC socket handling |
| pg | [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624) | Multi-package, mix of TracingChannel + plain channels |

Always read the proposal in `proposals/` for the target library before starting.

## Step 1: Investigate the target library

Before writing any code, understand the library's architecture:

- **Where are operations executed?** Find the single funnel point for the primary operation (e.g., `sendCommand`, `query`, `fetch`, `request`). This is where command/request tracing goes.
- **Where is the connection established?** Find the `connect()` or equivalent. This is where connection tracing goes.
- **How do batched operations work?** (transactions, pipelines, batch queries) — do they go through the same execution path or bypass it?
- **How are socket/connection options stored?** You need access to host, port, and Unix socket path for trace context.
- **What Node.js version is required?** Check `engines` in `package.json`. `TracingChannel` requires Node 19.9+ / 20+.
- **What's the test setup?** Framework, how to run, Docker requirements, dynamic port allocation.
- **Any existing `diagnostics_channel` usage?** Build on it if present.

## Step 2: Create the tracing module

Create a single `tracing.ts` (or `.js`) file that encapsulates all channel setup. This pattern is copy-paste portable across libraries.

```ts
import type { TracingChannel as NodeTracingChannel } from 'node:diagnostics_channel';

// @types/node is missing hasSubscribers on TracingChannel and types
// tracePromise as returning void. Both exist at runtime.
interface TracingChannel<ContextType extends object> extends NodeTracingChannel<unknown, ContextType> {
  readonly hasSubscribers: boolean;
  tracePromise<T>(fn: () => Promise<T>, context?: ContextType): Promise<T>;
}

// Safe load: use getBuiltinModule if available, fallback to require, catch if unavailable
const dc: any = (() => {
  try {
    return ('getBuiltinModule' in process)
      ? (process as any).getBuiltinModule('node:diagnostics_channel')
      : require('node:diagnostics_channel');
  } catch {
    return undefined;
  }
})();

const hasTracingChannel = typeof dc?.tracingChannel === 'function';
```

### Channel naming

Use **package-specific** names to avoid collisions:

| Package | Channel names |
|---|---|
| `redis` / `@redis/client` | `node-redis:command`, `node-redis:connect` |
| `ioredis` | `ioredis:command`, `ioredis:connect` |
| `pg` | `pg:query`, `pg:connect` |
| `mysql2` | `mysql2:query`, `mysql2:connect` |

### Define context types

Context types should map to [OTEL semantic conventions](https://opentelemetry.io/docs/specs/semconv/) for the relevant category. For databases, the conventions are at https://opentelemetry.io/docs/specs/semconv/database/.

**Example for a database client:**

```ts
export interface CommandTraceContext {
  command: string;              // db.operation.name
  args: ReadonlyArray<unknown>; // db.query.text (APM serializes)
  database: number;             // db.namespace
  serverAddress: string;        // server.address
  serverPort: number | undefined; // server.port (undefined for IPC)
}

export interface BatchCommandTraceContext extends CommandTraceContext {
  batchMode: 'MULTI' | 'PIPELINE';
  batchSize: number;            // db.operation.batch.size
}

export interface ConnectTraceContext {
  serverAddress: string;
  serverPort: number | undefined;
}
```

**Example for an HTTP client:**

```ts
export interface RequestTraceContext {
  method: string;               // http.request.method
  url: string;                  // url.full
  serverAddress: string;        // server.address
  serverPort: number;           // server.port
}
```

### Create channels and trace helpers

```ts
// Check explicitly for `false` rather than truthiness because `hasSubscribers`
// is not available on all Node.js versions that support TracingChannel.
// When `hasSubscribers` is `undefined` (older Node), we assume there are
// subscribers and trace unconditionally, keeping the zero-cost optimization
// only for versions where we can reliably check.
function shouldTrace(channel: TracingChannel<any> | undefined): channel is TracingChannel<any> {
  return !!channel && channel.hasSubscribers !== false;
}

const commandChannel: TracingChannel<CommandContext> | undefined = hasTracingChannel
  ? dc.tracingChannel('<package>:command')
  : undefined;

export function traceCommand<T>(
  fn: () => Promise<T>,
  contextFactory: () => CommandContext
): Promise<T> {
  if (shouldTrace(commandChannel)) {
    return commandChannel.tracePromise(fn, contextFactory());
  }
  return fn();
}
```

### Export types for consumers

Export the context interfaces from the package's public entry point so APM authors can type their subscribers:

```ts
// in package index.ts
export { CommandTraceContext, ConnectTraceContext } from './tracing';
```

## Step 3: Instrument the library

### Rules

1. **Use `tracePromise`** for async operations. It handles the full lifecycle: `start` → `end` → `asyncStart` → `asyncEnd`/`error`.

2. **Accept a context factory, not an eager object.** The factory is only called when `hasSubscribers` is true. This guarantees zero-cost when no APM is listening:
   ```ts
   // GOOD — zero allocation when no subscribers
   traceCommand(fn, () => buildContext(args))

   // BAD — allocates context object on every call
   traceCommand(fn, buildContext(args))
   ```

3. **Do NOT copy/snapshot args.** `diagnostics_channel` intentionally allows subscribers to mutate context. APMs may need to inject distributed trace headers or annotate the context. Pass args by reference.

4. **Handle IPC/Unix sockets.** When the connection uses a Unix domain socket (`path`), emit the path as `serverAddress` with `undefined` for `serverPort`. Never silently default to `localhost:6379` (or equivalent):
   ```ts
   if (options && 'path' in options) {
     return { serverAddress: options.path, serverPort: undefined };
   }
   return { serverAddress: options?.host ?? 'localhost', serverPort: options?.port ?? DEFAULT_PORT };
   ```

5. **Trace at the single funnel point.** Find the one method all operations flow through and instrument there. Don't scatter trace calls across the codebase.

6. **For batched operations that bypass the main path**, add tracing directly in the batch execution method. Each individual operation in a batch gets its own trace event (not one wrapper trace), with additional `batchMode` and `batchSize` fields. This matches how OTEL instruments batches.

7. **Connection tracing covers initial connect only.** Don't trace reconnections — OTEL doesn't, and reconnections are an internal implementation detail.

## Step 4: Determine scope using OTEL as north star

Check what the existing OTEL instrumentation for your library traces. The OTEL JS contrib repo is at https://github.com/open-telemetry/opentelemetry-js-contrib. Your minimum scope should fully cover what OTEL instruments.

**Typical scope for a database client:**
- Individual command/query execution (one trace per command)
- Initial connection
- Batch operations (MULTI, pipeline, batch queries) with per-command traces + batch metadata

**Typically NOT in scope:**
- Pub/sub lifecycle (pub/sub commands are traced as regular commands)
- Connection pool acquire/release
- Reconnection attempts
- Cluster routing decisions (covered naturally since commands route through individual node clients)

## Step 5: Write integration tests

Test against a real instance of the service (not mocks). Subscribe to the `tracing:` channels and verify events fire with correct context.

### What to test

1. **Basic operation**: Execute an operation, verify `start` fires with correct context fields, `asyncEnd` fires with result.
2. **Errors**: Execute an operation that will fail, verify `error` event fires.
3. **Batch operations**: If applicable, verify each operation in a batch gets its own trace with `batchMode`/`batchSize`.
4. **Connection tracing**: Verify `connect` channel fires with server info.
5. **Connection errors**: Point at a bad port, verify `error` fires.
6. **No subscribers**: Verify operations work without errors when nobody is listening.

### Test pitfalls

- **Do NOT hardcode `127.0.0.1` and default ports.** In CI, services run in Docker with dynamically assigned ports. Use the test infrastructure's connection details.
- **Always unsubscribe in `finally` blocks** using the same function reference you subscribed with. Leaking subscribers across tests causes flaky assertions.
- **Gate tests on `TracingChannel` availability** since it doesn't exist on Node 18:
  ```ts
  const hasTracingChannel = typeof dc.tracingChannel === 'function';
  (hasTracingChannel ? describe : describe.skip)('Tracing Channel', () => { ... });
  ```

## Step 6: Pre-commit validation

**Before every commit**, you MUST run these checks locally. Do NOT push code that hasn't passed all of them.

### 1. Lint all changed files

Run the project's linter on every file you touched. Fix all errors — do NOT commit with lint failures.

```bash
# Example for mysql2 (uses eslint + prettier)
npx eslint --fix <changed-files>
npx eslint <changed-files>  # verify clean after fix
```

### 2. Run unit tests

Run any unit tests related to your changes:

```bash
npx tsx test/unit/test-tracing.test.mts  # or equivalent
```

### 3. Run integration tests on all Node versions the repo's CI checks against

Check the CI matrix (e.g., `.github/workflows/`) to find which Node versions are tested. Run integration tests on each of them — different versions may have different runtime behavior (e.g., Node 18 backported `TracingChannel` but without the aggregated `hasSubscribers` getter).

```bash
# Example: if CI tests Node 18 and Node 22
nvm use 18 && npx tsx test/integration/tracing-channel.test.mts
nvm use 22 && npx tsx test/integration/tracing-channel.test.mts
```

### 4. Run the full test suite if available

If the project has a full test runner (e.g., `npm test`, `npx poku`), run it to catch regressions beyond your tracing code.

### Node 18 compatibility gotchas

- `TracingChannel.hasSubscribers` (the aggregated getter) is `undefined` on Node 18 — only sub-channel `hasSubscribers` (e.g., `channel.start.hasSubscribers`) works
- Use the `shouldTrace` helper which checks `hasSubscribers !== false`: treats `undefined` (Node 18) as "might have subscribers, trace anyway" and `false` (Node 20+) as "definitely no subscribers, skip". Also serves as a type guard for TypeScript narrowing.
- `process.getBuiltinModule` doesn't exist on Node 18 — always fallback to `require()`
- poku's `skip()` calls `process.exit(0)` internally — safe because poku runs each test in a separate process

## Checklist

- [ ] Tracing module created with Node 18 fallback and `shouldTrace` guard
- [ ] `TracingChannel` shim type for `hasSubscribers` and `tracePromise` return type
- [ ] Context types defined matching OTEL semantic conventions
- [ ] Context factory pattern (lazy, not eager)
- [ ] Primary operation instrumented (command/query/request)
- [ ] Connection instrumented (initial only)
- [ ] Batch operations instrumented with per-operation traces + batch metadata
- [ ] IPC/Unix socket connections handled (no false `localhost` defaults)
- [ ] Args passed by reference (no snapshot/copy)
- [ ] Context types exported from package entry point
- [ ] Integration tests with real service (not mocks)
- [ ] Tests gated on `TracingChannel` availability
- [ ] Tests use dynamic connection info from test infra (no hardcoded ports)
- [ ] **Lint passes on all changed files**
- [ ] **Unit tests pass**
- [ ] **Integration tests pass on all Node versions in CI matrix**
