# TracingChannel Proposal Learnings

> Distilled knowledge from writing proposals and implementing TracingChannel support. These are general principles — apply them to any new proposal or implementation.
> Updated by the `capture-review-feedback` skill and by hand.

## Channel Naming

### Use npm package name as channel prefix

Every channel uses the npm package name as prefix (`mysql2:query`, `pg:connection`, `ioredis:command`). This mirrors undici's `undici:request` from Node.js core and ensures global uniqueness in the `diagnostics_channel` namespace.

### Use domain verbs, not method names

Name channels after what the operation *is*, not what method the user called: `pg:query` not `pg:Client.query`. APM subscribers can name spans correctly without inspecting the payload.

### One channel per semantically distinct operation

Separate channels when the span-naming strategy or payload shape differs. Merge when they don't. Stored procedures (span named after procedure), SQL queries (span named after sanitized query text), and bulk loads (span named after table) warrant separate channels. Two methods that do the same thing with different parameterization can share one.

### Frameworks need fewer channels than databases

Database operations (query, connect, pool acquire) are semantically distinct and warrant separate channels. HTTP framework lifecycle phases (onRequest, handle, afterHandle) are stages of the same request — use a single channel with a discriminator field like `lifecycle` rather than N channels for a pipeline.

### Choose traceSync vs plain publish based on whether there's measurable work to wrap

The choice between `TracingChannel.traceSync()` and plain `channel.publish()` for logging libraries depends on whether the core performs measurable work that consumers might care about profiling.

- **pino** uses `traceSync` around its `asJson` serialization function. JSON encoding is real work that adds up under heavy logging. `traceSync` gives consumers start/end timing around serialization, letting APMs answer "how much time is this app spending serializing log lines?" This is why Qard (diagnostics_channel author) considers pino's choice correct.
- **consola** just dispatches to reporters in its core `_log()`. The actual formatting work happens inside each reporter, not in consola itself. There's no measurable work to wrap, so plain `publish()` is the right fit.

The general rule: if the library performs meaningful computation at the instrumentation point (serialization, encoding, query building), `traceSync` gives consumers visibility into that cost. If the library is just dispatching/routing with no significant work, plain `publish()` avoids unnecessary machinery. In both cases, the subscriber runs synchronously in the caller's async context, so log-trace correlation via `AsyncLocalStorage` works either way.

### Logging libraries already have observation APIs; acknowledge them

Most logging libraries already have reporter/transport/stream APIs that APM tools can use (consola reporters, pino transports, winston transports, bunyan streams). These work. The `diagnostics_channel` pitch is not "your reporter API is broken." The value is: (1) standardized interface across all logging libraries so APMs write one subscriber pattern instead of N library-specific integrations, (2) no dependency on the logger instance (subscribe by channel name globally, without needing to find/import the instance), (3) consistency with the rest of the stack if the library's ecosystem already uses `diagnostics_channel` (e.g. unjs: h3, srvx, unstorage, db0 all use it already).

## Payload Shape

### Always include serverAddress and serverPort

These map to OTEL's `server.address` and `server.port`. They are universal across every TracingChannel proposal. Never omit them.

### Always include the database/namespace identifier

Maps to OTEL's `db.namespace`. The field name should follow the library's own conventions (`database` for most, `databaseName` if that's what the driver API calls it), but the concept must always be present.

### Map payload fields to OTEL semantic conventions explicitly

Include an "OTEL attribute it enables" column in context property tables. Payload fields should be chosen to make APM migration from monkey-patching straightforward, and the mapping must be documented in the proposal.

### Include everything APMs currently monkey-patch to get

Study the existing `@opentelemetry/instrumentation-{name}` to see what it extracts via monkey-patching. TracingChannel must provide at least that, otherwise migration is a feature regression. Libraries often have domain-specific fields (collection name, procedure name, table name) that APMs need.

### Pass raw context objects for frameworks, not pre-extracted fields

For frameworks, the request context object already contains everything APMs need. Pre-extracting individual fields would either be incomplete or duplicate data. Let APM subscribers extract what they need.

## API Design

### Mix TracingChannel and plain diagnostics_channel

Not every event needs the full async lifecycle (start → end → asyncStart → asyncEnd). Fire-and-forget events like pool release or pool remove are single-point — use plain `dc.channel()` for these. Reserve TracingChannel for operations with meaningful start/end semantics.

### Match trace wrapper to the library's async model

Use `tracePromise` for promise-based APIs, `traceCallback` for callback-based. Using the wrong one silently breaks async context propagation.

### Document relationship to existing observability APIs

For libraries that already have monitoring/tracing (command events, hook systems, `.trace()` methods), include a comparison table showing what the existing API covers vs what TracingChannel adds. This preempts "why do we need this when we already have X?"

### Evaluate architectural options for complex cases

When a library has existing observability primitives, evaluate the integration options explicitly (TracingChannel powers existing API, existing API triggers TracingChannel, or independent coexistence) with pros/cons. This demonstrates rigor and builds maintainer trust.

### Position TracingChannel as complement, never replacement

Never frame TracingChannel as replacing existing monitoring APIs. That triggers defensiveness. Frame it as filling a specific gap — async context propagation for distributed tracing — that existing APIs don't cover.

## Node.js Compatibility

### TracingChannel.hasSubscribers is broken on Node 18

The aggregated `hasSubscribers` getter on the TracingChannel object is `undefined` on Node 18. Only sub-channel `.hasSubscribers` works (e.g., `channel.start.hasSubscribers`). Use a `shouldTrace` helper that checks `hasSubscribers !== false` — this treats `undefined` (Node 18) as "might have subscribers, trace anyway" and `false` (Node 20+) as "definitely no subscribers, skip".

### process.getBuiltinModule doesn't exist on Node 18

Always fall back to `require()`:
```js
const dc = ('getBuiltinModule' in process)
  ? process.getBuiltinModule('node:diagnostics_channel')
  : require('node:diagnostics_channel');
```
For libraries targeting non-Node runtimes (Bun, Deno), wrap the whole thing in `try/catch` as well.

### Gate TracingChannel tests on availability

At minimum, skip TracingChannel tests when `dc.tracingChannel` doesn't exist (Node 16). On Node 18, TracingChannel exists but has quirks — may need stricter gating if tests hit unsubscribe bugs. Plain `dc.channel()` works fine on Node 16+, so only gate TracingChannel-specific tests.

### tracePromise wrapper causes unhandled rejections when return value is discarded

`tracePromise` returns a wrapper promise that re-rejects on error via `.then(onSuccess, onError)` where the error handler re-throws. If the caller discards this return value (e.g., pipeline/batch paths where individual command results are collected separately), the wrapper promise rejects with nobody listening — causing an `unhandledRejection` event that can crash the process under `--unhandled-rejections=throw`. The fix is to add `.catch(noop)` on the wrapper at the call site. Callers that `await`/`return` the traced promise are unaffected — they see the rejection through their own `.then()` chain. Discovered via [ioredis#2089 review](https://github.com/redis/ioredis/pull/2089/comments#discussion_r2966664588); same pattern was already handled in mysql2#4178.

### tracePromise breaks custom Promise implementations

`tracePromise` returns a native Promise. If a library supports custom Promise implementations (e.g., `{ Promise: bluebird }`), `tracePromise` silently replaces the user's Promise type, breaking `instanceof` checks. Use `traceCallback` inside the user's Promise constructor instead.

### traceCallback crashes on undefined callbacks

If the code path has no callback (event-emitter-style queries, fire-and-forget operations), `traceCallback` will crash trying to wrap `undefined`. Always guard: `if (shouldTrace(channel) && callback)`.

### shouldTrace activates unconditionally on Node 18

Because `hasSubscribers` is `undefined` on Node 18, the `shouldTrace` helper returns true even when no APM is listening. This means existing tests that never touch diagnostics can still break if tracing wrappers have bugs (wrapping a nonexistent callback, returning wrong Promise type). Run the FULL test suite on ALL supported Node versions.

### Zero-cost guarantee depends on hasSubscribers gating

Always construct context objects inside a `hasSubscribers` guard, never eagerly. The factory pattern ensures zero overhead when no APM subscribes. This is the key performance guarantee that makes proposals palatable to maintainers — always state it prominently.

## Maintainer Persuasion

### Grow the Prior Art section with every proposal

Each new proposal lists all previous TracingChannel PRs/proposals. The snowball effect is deliberate — maintainers see ecosystem momentum and don't want to be the holdout.

### Include the standard four-point motivation

Every proposal includes: runtime lock-in, ESM fragility, initialization ordering, and bundling/externalization. This frames the problem in terms maintainers care about (their users hitting bugs), not APM-vendor concerns.

### Tailor motivation to the library's specific pain points

Beyond the standard block, add what hurts *this* library's users specifically. If the primary runtime lacks IITM/RITM support, say so. If OTel patches 6 methods, list them. Tailored motivation is much more persuasive than generic.

### Show the OTel plugin simplification

If a library has a first-party OTel plugin, show a concrete before/after: hundreds of lines of monkey-patching reduce to a single TracingChannel subscription. This reframes TracingChannel as "less code to maintain" rather than "more work."

### Use the standard backward-compatibility snippet verbatim

The `getBuiltinModule`/`require` fallback pattern is recognized by maintainers who've seen other TracingChannel PRs. Don't reinvent it.

## Anti-Patterns

### Don't let field values diverge across sibling libraries

When proposing for related libraries (e.g., two Redis clients), align field value casing and naming. Divergence means APM consumers need extra normalization code. Match values to each other, not just to each library's internal conventions.

### Don't merge channels with different span-naming strategies

If one operation uses a low-cardinality name (procedure name) and another uses high-cardinality text (SQL query needing sanitization), they need separate channels. Forcing them into one channel pushes type-checking onto every APM subscriber.

### Don't run only unit tests or only one Node version

The `shouldTrace` helper activates tracing unconditionally on Node 18, so even unrelated tests can break. Always run the full test suite on all Node versions the library supports before pushing.

### Don't mock the database in integration tests

Run integration tests against real services via Docker. Mock/prod divergence has masked broken implementations in the past.

## Argument Sanitization

### Sanitize at the emitter, not the consumer

Libraries should sanitize command arguments before emitting them on channels. Consumers (APMs) shouldn't need to know which commands carry secrets. Use `?` placeholders for redacted values — matches the SQL parameterization convention used by `db.query.text` across OTel, Sentry, and Datadog.

### Use OTel's redis-common serialization rules as baseline

The `@opentelemetry/redis-common` package (Apache 2.0) defines a command → arg-count map controlling how many args to serialize. Adopt this as the starting point and let library maintainers tighten it. Commands like `AUTH` fall to the default (0 args = command name only), which is safe by accident but correct.

### Sanitize all emission points, not just TracingChannel

Point event channels (like `COMMAND_REPLY`) also carry args. If you sanitize TracingChannel context but forget point events, sensitive data leaks through the other path. Audit every `publish()` call that includes args.

## Architecture

### Describe what's happening, not what to compute

Core code should emit events that describe system state changes ("a command started," "a connection closed," "an error occurred"). Subscribers independently decide what to compute from those events. This eliminates inline metric closures, noop classes, and the coupling between core code and specific observability backends.

### Two functions replace an entire class hierarchy

A generic `trace(channelName, fn, contextFactory)` for async lifecycles and `publish(channelName, factory)` for point events can replace dozens of inline closure methods, noop counterparts, and metric-specific wiring. The channel itself becomes the gating mechanism — no subscribers means zero cost, no noops needed.

### Factory callbacks for zero-cost event emission

Both `trace()` and `publish()` accept factory callbacks instead of pre-built objects. The factory is only called when `hasSubscribers` is true. This prevents object allocation on every command when no APM is listening — the same zero-cost principle as TracingChannel's `hasSubscribers` but extended to point events.

### Channel name map + type map for type safety

Centralize channel names in a `CHANNELS` const map and map them to payload types via `ChannelEvents`/`TracingChannelContextMap` interfaces. Use `TRACE_*` prefix for TracingChannels to distinguish them from point events. Consumers get full type inference at the call site without runtime overhead.

### Cache channel acquisitions

`dc.channel()` and `dc.tracingChannel()` involve internal bookkeeping. Cache the returned objects in a `Map` to avoid re-acquisition on every publish/trace call. This matters when `publish()` or `trace()` is called on every command.

## Pitfalls

### tracePromise floating promises in fire-and-forget paths

Pool wait and pipeline paths create traced promises that nobody awaits. `tracePromise` wraps the inner promise in a separate chain — if it rejects with nobody listening, that's an unhandled rejection. Always `.catch(noop)` on fire-and-forget traced promises.

### Duplicate event emission across call layers

When `sendCommand` is called from `_executeCommand`, both layers can emit the same event (e.g., `COMMAND_REPLY`), causing double-counted metrics. Emit at the outermost layer that has the complete context (transformed reply, parsed args), not at every layer in the call chain.

### Point events must carry enough state for subscribers to act correctly

When converting inline code to channel events, identify implicit state that the original code relied on (e.g., a boolean guard before decrementing a counter). That state must be included in the event payload — subscribers don't have access to the emitter's internal variables.

## Maintainer Relations

### Frame refactors as delivery mechanism changes, not rewrites

When refactoring existing observability code to use channels, emphasize that the domain knowledge (which metrics, which semantic conventions, which error classification) is preserved. What changed is the delivery mechanism — from inline closures to channel subscriptions. This respects the original work and reduces defensiveness.

### Noops disappear as a natural consequence

When all observability flows through channels, noop implementations become unnecessary. If a metric group is disabled, no subscription is created, `hasSubscribers` is false, and the channel is skipped entirely. Zero cost by design, not by maintaining parallel noop code. This is a concrete benefit to communicate — less code to maintain.
