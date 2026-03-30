# Channel Consumer Abstraction

Status: Early exploration / thinking out loud

## Problem

TracingChannel exposes 6 event hooks: `start`, `end`, `asyncStart`, `asyncEnd`, `error`, and requires manual `bindStore` setup for ALS context propagation. For APM consumers, this is more surface area than needed. Most use cases boil down to: something started, something ended, something failed, with context flowing across async boundaries automatically.

## Core Idea

Build an abstraction (internally at Sentry first) that:

1. Takes a TracingChannel reference
2. The act of binding to the store via `bindStore` IS the start event. No separate `start` listener needed.
3. Collapses the 6 TracingChannel events down to a promise-shaped API: **factory** (start), `.then()` (end), `.catch()` (error)
   - `start` and `asyncStart` are handled by the factory/bindStore
   - `end` and `asyncEnd` merge into `.then()`
   - `error` maps to `.catch()`
4. Exposes a stream-like fluent API that looks like a promise chain but is a subscription

## Key Insight

Binding to the store with `bindStore` already qualifies as the "start" event. The factory callback that creates the span runs at bind time, so there's no need for a separate `onStart` hook. Whatever the factory returns (e.g., a span) flows via ALS to `.then()` and `.catch()`.

## API Sketch

### Stream API (primary)

```ts
traceStream('tracing:knex', (payload) => {
  // this IS the start - runs when bindStore fires
  // whatever is returned flows to .onEnd() and .onError() via ALS
  return startSpan({ name: 'knex.query', op: 'db' })
})
.onEnd((span, payload) => {
  span.end()
})
.onError((span, payload) => {
  span.setStatus('error')
  span.end()
})
```

- The factory callback is the start. It runs on `bindStore` and its return value becomes the ALS-propagated context.
- `.onEnd()` runs on end. Receives the factory's return value + the end payload.
- `.onError()` runs on error. Receives the factory's return value + the error payload.
- Not thenable. No risk of accidental `await`.

### With sensible defaults (minimum viable)

`.onEnd()` and `.onError()` can have defaults (end the span, set error status), so the minimum subscription is just the factory:

```ts
// defaults: .onEnd() ends the span, .onError() sets error + ends
traceStream('tracing:knex', (payload) => {
  return startSpan({ name: 'knex.query', op: 'db' })
})
```

### With a mapper (one-liner)

```ts
// mapper provides the span factory
traceStream('tracing:knex', knexMapper)
```

### Metrics and logs (not just spans)

The abstraction should not be span-specific. The stream could support multiple signal types:

```ts
traceStream('tracing:knex', knexMapper)
  .toSpans()      // creates spans
  .toMetrics()    // emits duration/count metrics
  .toLogs()       // structured log on start/end/error
```

Or these could be separate subscriptions on the same stream if that's cleaner.

## What the Abstraction Handles Internally

- `bindStore` setup on the TracingChannel (this IS the start)
- ALS context propagation from factory return value to `.onEnd()` / `.onError()`
- Merging sync/async end events into a single `.then()` callback
- Default `.then()` / `.catch()` behavior (end span, set error status)
- Error handling if a hook throws
- Subscription cleanup

## Connection to Mappers

This is the consumer-side counterpart to the [mapper registry exploration](./autoloader-and-shared-mappers.md). The stream abstraction consumes mappers:

```
Library (TracingChannel) -> Stream abstraction -> Mapper -> Spans/Metrics/Logs
```

## Open Questions

- How does the factory return type work with TypeScript generics? e.g., `traceStream<Span>('tracing:knex', ...)`
- What does error recovery look like? If `.onEnd()` throws, does the span leak?
- Should the stream support filtering? e.g., `.filter((payload) => payload.query !== 'SELECT 1')` to skip health checks
- ~~Can `.onEnd()` and `.onError()` compose with a mapper, or are they mutually exclusive paths?~~ Resolved: a mapper can define all three (`onStart`, `onEnd`, `onError`) or just `onStart` with defaults for the rest.
