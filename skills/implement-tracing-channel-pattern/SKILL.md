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

const noop = () => {};

const commandChannel: TracingChannel<CommandContext> | undefined = hasTracingChannel
  ? dc.tracingChannel('<package>:command')
  : undefined;

export function traceCommand<T>(
  fn: () => Promise<T>,
  contextFactory: () => CommandContext
): Promise<T> {
  if (shouldTrace(commandChannel)) {
    // tracePromise returns a wrapper promise that re-rejects on error.
    // Silence the wrapper to prevent unhandled rejections when callers
    // (e.g. Pipeline) discard the return value. Callers that await this
    // promise still see the rejection through their own .then() chain.
    const traced = commandChannel.tracePromise(fn, contextFactory());
    traced.catch(noop);
    return traced;
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

2. **`tracePromise` wrapper causes unhandled rejections when discarded.** `tracePromise` returns a wrapper promise that re-rejects on error. If any caller discards this return value (pipeline/batch paths, fire-and-forget sends), the wrapper rejects with nobody listening — causing `unhandledRejection` that can crash under `--unhandled-rejections=throw`. **Always add `.catch(noop)` on the wrapper** at the trace helper level (see the `traceCommand` example above). Callers that `await`/`return` the traced promise are unaffected — they see the rejection through their own `.then()` chain. When auditing call sites, check every place the traced function is called and verify the return value is always consumed; if even one path discards it, the `.catch(noop)` is required.

3. **`tracePromise` returns a native Promise.** If the library supports custom Promise implementations (e.g. `{ Promise: bluebird }`), do NOT use `tracePromise` — it will silently replace the user's Promise type with a native one, breaking `instanceof` checks. Use `traceCallback` inside the user's Promise constructor instead:
   ```js
   // BAD — returns native Promise, breaks custom Promise support
   if (shouldTrace(channel)) {
     return channel.tracePromise(() => new this._Promise(...), context)
   }
   return new this._Promise(...)

   // GOOD — preserves whatever Promise type the user configured
   return new this._Promise((resolve, reject) => {
     const callback = (err, res) => err ? reject(err) : resolve(res)
     if (shouldTrace(channel)) {
       channel.traceCallback((tracedCb) => doWork(tracedCb), 0, context, null, callback)
     } else {
       doWork(callback)
     }
   })
   ```

4. **`traceCallback` requires an actual callback.** If the code path has no callback (e.g. event-emitter-style queries, fire-and-forget operations), do NOT call `traceCallback` — it will crash when trying to wrap `undefined`. Always guard: `if (shouldTrace(channel) && callback)`.

5. **Accept a context factory, not an eager object.** The factory is only called when `hasSubscribers` is true. This guarantees zero-cost when no APM is listening:
   ```ts
   // GOOD — zero allocation when no subscribers
   traceCommand(fn, () => buildContext(args))

   // BAD — allocates context object on every call
   traceCommand(fn, buildContext(args))
   ```

6. **Do NOT copy/snapshot args.** `diagnostics_channel` intentionally allows subscribers to mutate context. APMs may need to inject distributed trace headers or annotate the context. Pass args by reference.

7. **Handle IPC/Unix sockets.** When the connection uses a Unix domain socket (`path`), emit the path as `serverAddress` with `undefined` for `serverPort`. Never silently default to `localhost:6379` (or equivalent):
   ```ts
   if (options && 'path' in options) {
     return { serverAddress: options.path, serverPort: undefined };
   }
   return { serverAddress: options?.host ?? 'localhost', serverPort: options?.port ?? DEFAULT_PORT };
   ```

8. **Trace at the single funnel point.** Find the one method all operations flow through and instrument there. Don't scatter trace calls across the codebase.

9. **For batched operations that bypass the main path**, add tracing directly in the batch execution method. Each individual operation in a batch gets its own trace event (not one wrapper trace), with additional `batchMode` and `batchSize` fields. This matches how OTEL instruments batches.

10. **Connection tracing covers initial connect only.** Don't trace reconnections — OTEL doesn't, and reconnections are an internal implementation detail.

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
- **Gate tests on `TracingChannel` availability.** At minimum, skip when `dc.tracingChannel` doesn't exist (Node 16). On Node 18, `TracingChannel` exists but might have issues (see Node 18 gotchas below) — if your tests fail there, you may need stricter gating:
  ```ts
  const hasTracingChannel = typeof dc.tracingChannel === 'function';
  (hasTracingChannel ? describe : describe.skip)('Tracing Channel', () => { ... });
  ```

## Step 6: Pre-commit validation

**CRITICAL: Before every push**, you MUST run ALL of the checks below locally. Do NOT push code that hasn't passed ALL of them. Every failed CI run on someone else's repo damages credibility and wastes maintainer attention. There is no excuse for pushing code that fails CI when you can catch it locally.

### 1. Lint all changed files

Run the project's linter on every file you touched. Fix all errors — do NOT commit with lint failures.

```bash
# Example for mysql2 (uses eslint + prettier)
npx eslint --fix <changed-files>
npx eslint <changed-files>  # verify clean after fix
```

### 2. Start the service in Docker for integration tests

If the project has integration tests (and most do), spin up the service locally. Do NOT skip integration tests — unit tests alone will not catch issues like `tracePromise` silently replacing a custom Promise type.

```bash
# Example for a database client
docker run -d --name test-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
# Wait for it
docker exec test-db pg_isready -U postgres

# Example for Redis
docker run -d --name test-redis -p 6379:6379 redis:7
```

### 3. Run the ENTIRE test suite (unit AND integration), not just your new tests

**Do NOT cherry-pick which tests to run.** Run the project's full test suite — your tracing code touches hot paths (query execution, connection setup) that affect every existing test. A change that looks isolated can break tests you'd never think to check.

```bash
# Run ALL tests — unit AND integration
PGUSER=postgres PGPASSWORD=postgres npm test  # or yarn test, make test, etc.
```

### 4. Run the full test suite on EVERY Node version in the CI matrix using nvm

Check the CI matrix (e.g., `.github/workflows/`) to find which Node versions are tested. **You must run the full test suite (unit AND integration) against every version in the matrix before pushing.** `TracingChannel` behavior varies significantly across Node versions — `shouldTrace` returns different values on Node 18 vs 20+, which means different code paths execute on different versions. A test that passes on Node 20 can crash on Node 18 because `shouldTrace` returns `true` on 18 (due to `undefined hasSubscribers`) but `false` on 20 (no subscribers), exercising tracing code paths that are skipped on 20.

```bash
# Install any missing versions first
nvm install 16 && nvm install 18 && nvm install 20

# Run the FULL test suite (unit + integration) against EVERY version
nvm use 16 && PGUSER=postgres PGPASSWORD=postgres npm test
nvm use 18 && PGUSER=postgres PGPASSWORD=postgres npm test
nvm use 20 && PGUSER=postgres PGPASSWORD=postgres npm test

# Clean up
docker stop test-db && docker rm test-db
```

**Do NOT skip this step. Do NOT run only unit tests. Do NOT run only your new tests. Do NOT assume that passing on one version means passing on all.** The `shouldTrace` helper activates tracing code unconditionally on Node 18 (where `hasSubscribers` is `undefined`), which means existing tests that never touch diagnostics can still break if your tracing wrappers have bugs (e.g. wrapping a callback that doesn't exist, or returning the wrong Promise type).

### Node 18 compatibility gotchas

- `TracingChannel.hasSubscribers` (the aggregated getter) is `undefined` on Node 18 — only sub-channel `hasSubscribers` (e.g., `channel.start.hasSubscribers`) works
- Use the `shouldTrace` helper which checks `hasSubscribers !== false`: treats `undefined` (Node 18) as "might have subscribers, trace anyway" and `false` (Node 20+) as "definitely no subscribers, skip". Also serves as a type guard for TypeScript narrowing.
- `process.getBuiltinModule` doesn't exist on Node 18 — always fallback to `require()`
- **Node 18's `TracingChannel.unsubscribe` might be broken:** on some Node 18 versions, unsubscribing from a tracing channel and then calling `traceCallback`/`tracePromise` again on the same channel can crash with `Cannot read properties of undefined (reading 'length')` because `_subscribers` on sub-channels becomes `undefined`. This doesn't affect production use (APMs subscribe once at startup), but it can break test patterns that subscribe/unsubscribe/resubscribe across tests. If your tests hit this, you may need stricter gating (e.g. checking `typeof hasSubscribers === 'boolean'` to require Node 19.9+/20.5+).
- Plain `dc.channel()` works fine on Node 16+ — only gate TracingChannel tests, not plain channel tests.
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
- [ ] Integration tests with real service via Docker (not mocks)
- [ ] Tests gated on `TracingChannel` availability (skip on Node 16; may need stricter gating if Node 18 tests hit unsubscribe bugs)
- [ ] Tests use dynamic connection info from test infra (no hardcoded ports)
- [ ] `traceCallback` guarded against undefined callbacks (`shouldTrace(ch) && callback`)
- [ ] `tracePromise` wrapper has `.catch(noop)` to prevent unhandled rejections when callers discard the return value
- [ ] `tracePromise` not used where custom Promise types must be preserved (use `traceCallback` inside user's Promise constructor instead)
- [ ] **Lint passes on all changed files**
- [ ] **FULL test suite (unit + integration) passes locally with Docker**
- [ ] **FULL test suite passes on ALL Node versions in CI matrix via nvm**
