# Autoloader & Shared Mapper Registry

Status: Early exploration / thinking out loud

## Problem

Once libraries adopt TracingChannel, every APM vendor (Sentry, DD, OTel, etc.) still needs to manually subscribe to each library's channels and translate payloads into their own attribute format. This is better than monkey-patching, but still duplicates effort across vendors.

## Core Idea

A three-layer architecture:

1. **TracingChannel (library side)** - Libraries emit events with domain-appropriate payloads. No APM knowledge required. This is the current focus of the proposals in this repo.

2. **Shared Mapper Registry (APM collaboration)** - A set of mappers, co-maintained by APM vendors, that translate library-specific payloads into semantic attributes (e.g., OTel semantic conventions). Mappers are the glue between raw channel payloads and consumer expectations.

3. **Autoloader / Sink (consumer side)** - A mechanism that auto-discovers available TracingChannels, looks up matching mappers, and feeds normalized attributes into the consumer SDK (OTel, etc.).

## Mapper Shape (rough sketch)

```ts
type ChannelMapper<T, R> = {
  // required - factory/start, used with bindStore
  // whatever is returned flows to onEnd/onError via ALS
  onStart: (payload: T) => R

  // optional - sensible defaults (end span, set error status)
  onEnd?: (context: R, payload: T) => void
  onError?: (context: R, payload: T) => void
}
```

A minimal mapper only needs `onStart`. A full mapper overrides all three when custom end/error behavior is needed (e.g., setting attributes from the response payload before ending the span).

## Separation of Concerns

- **Library authors** only care about emitting TracingChannel events with a payload shape that makes sense for their domain. No APM concerns, no attribute semantics, no data quality burden.
- **APM vendors** co-maintain the mapper registry. They already understand semantic conventions, data quality, and attribute naming. This is a natural fit for shared ownership.
- **Consumers** (e.g., OTel SDK) implement the autoloader once and get support for any library that has a TracingChannel + mapper.

## Why Shared Ownership of Mappers

APM vendors were going to write per-library instrumentation anyway. Co-maintaining one mapper per library is a fraction of the effort compared to each vendor independently maintaining full instrumentations. It also ensures consistency across APM tools.

Library authors should not own mappers because:
- TracingChannel is already the right level of abstraction for them
- APM attribute semantics and data quality are APM concerns
- Adding that burden would slow TracingChannel adoption

## Incentive Loop

1. Library ships TracingChannel support (low effort, no APM knowledge needed)
2. APM consortium adds a mapper (they were going to write instrumentation anyway)
3. Every APM consumer benefits immediately

## Rollout Strategy

**Phase 1: In-house at Sentry.** Build the mapper + autoloader abstraction internally to solve Sentry's own need: a clean way to hook into TracingChannels and stream their events to spans, metrics, and logs. This lets us iterate on the API shape without coordination overhead, and validates the abstraction against real production use.

**Phase 2: Stabilize and open up.** Once the API is proven and stable, open-source the mapper/autoloader layer and invite other APM vendors to co-maintain mappers. The shared model works better when the abstraction is already battle-tested rather than designed by committee from day one.

## Open Questions

- How does auto-discovery work? Convention-based channel naming? A registry?
- Should mappers target OTel semantic conventions specifically, or a more generic attribute schema?
- Package structure: one big `@tracing-channels/otel-mappers` package, or per-library mapper packages?
- How to handle payload shape changes across library versions?
- Governance: who reviews/merges mapper PRs? OpenTelemetry org? A separate working group?
