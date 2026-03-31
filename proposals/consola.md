# Consola: `diagnostics_channel` Proposal

> **Status:** Draft

---

I'd like to propose adding first-class [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) support to Consola, so APM/observability tools can observe log events and correlate them with active traces without needing custom reporters or monkey-patching.

`diagnostics_channel` is a Node.js core API for lightweight pub/sub event emission. For logging libraries, a simple `channel.publish()` call is the right fit: logging is a point event (something happened, here's the data), not a lifecycle operation with start/end semantics. The subscriber callback runs synchronously in the caller's async context, so APM tools automatically have access to the active trace/span via `AsyncLocalStorage` for log-trace correlation.

Consola already has a reporter system (`addReporter`) that APM tools can use to observe log events. This works and is better than monkey-patching. However, every logging library has its own version of this: pino has transports, winston has transports, bunyan has streams. APM tools must write and maintain separate integration code for each library's specific API.

`diagnostics_channel` standardizes this. The subscriber code is identical regardless of the logging library: `dc.subscribe('consola:log', handler)`, `dc.subscribe('winston:log', handler)`, `dc.subscribe('pino:log', handler)`. Same API, same subscription mechanism, same teardown. APM tools write one pattern, not N library-specific integrations.

Beyond cross-library standardization:

- **No dependency on the logger instance.** Reporters require access to the consola instance to call `addReporter()`. With `diagnostics_channel`, APMs subscribe to a channel name globally without needing to find or import the logger. This matters in large apps where the logger is created inside framework internals (Nitro, Nuxt) and the APM initializes separately.
- **Consistent with the rest of the stack.** If the HTTP layer (h3), storage (unstorage), and database (db0) all emit via `diagnostics_channel`, but logs go through a library-specific reporter API, APMs maintain two different observation mechanisms. Unifying on `diagnostics_channel` means one subscription system for everything.

Additionally, Consola is a **foundational dependency** in the unjs ecosystem. It powers logging in Nitro (the server engine) and Nuxt. Combined with existing `diagnostics_channel` support in h3 (HTTP), unstorage (storage), srvx (server), and db0 (database), adding it to Consola would complete the observability picture for the unjs stack by covering the **logging dimension**. APM tools could automatically correlate log messages with HTTP requests, storage operations, and other traced activities.

If Consola emits structured events through `diagnostics_channel`, instrumentation libraries become **subscribers**, not **patches**. Each tool listens independently with no ordering concerns, no clobbering, and no internal API dependency.

---

## Proposed Channel

| Channel | Tracks | Published payload |
|---|---|---|
| `consola:log` | Every log call that passes level filtering | `logObj` (the internal LogObject) |

A single plain `diagnostics_channel` (not `TracingChannel`) because logging is a **point event**, not an async lifecycle operation. There is no meaningful start/end to wrap. The subscriber callback executes synchronously inline, so `AsyncLocalStorage` context (active trace/span) is naturally available without needing `traceSync`.

### Why plain `channel.publish()` and not `TracingChannel`

Pino uses `TracingChannel` with `traceSync` ([pinojs/pino#2281](https://github.com/pinojs/pino/pull/2281)) to wrap its `asJson` serialization function. This makes sense for pino: JSON encoding is real, measurable work that adds up under heavy logging, and `traceSync` gives consumers start/end timing around that serialization cost.

Consola's core `_log()` method doesn't perform that kind of work. It dispatches to reporters, which handle their own formatting. There's no meaningful computation to wrap with start/end timing. Plain `channel.publish()` is the right fit:

1. The log payload (level, type, tag, args, date) is available to subscribers
2. The active async context (via `AsyncLocalStorage`) is naturally available because `publish()` runs synchronously in the caller's context
3. No unnecessary sub-channels (`start`, `end`, `asyncStart`, `asyncEnd`, `error`) for what is a point event

### Payload Shape

The published object is the raw `logObj` that Consola already constructs internally:

| Field | Type | Purpose |
|---|---|---|
| `level` | `number` | Log severity level (0=fatal, 1=error, 2=warn, 3=log, 4=info, 5=debug). Maps to OTel `severity_number`. |
| `type` | `string` | Log type (`info`, `warn`, `error`, `debug`, `success`, `fail`, `ready`, `start`, `box`, `trace`, `verbose`, `fatal`, `log`) |
| `tag` | `string` | Tag from `withTag()`. Enables log grouping/filtering by component. |
| `args` | `any[]` | The raw arguments passed to the log call. APMs extract message text and structured data. |
| `date` | `Date` | Timestamp of the log event |

Publishing the raw `logObj` rather than extracting individual fields follows the "pass raw context objects, let APMs extract what they need" principle from framework proposals. It's simpler, forward-compatible (new fields added to `logObj` are automatically available), and avoids constructing a new object on every log call.

### What APMs extract from the payload

| Extracted field | OTel Logs attribute it enables |
|---|---|
| `level` | `severity_number` |
| `type` | `severity_text` (mapped from consola type to standard severity) |
| `tag` | Custom attribute for log source identification |
| `args` | `body` (the log message content) |
| `date` | `observed_time_unix_nano` |
| Active `AsyncLocalStorage` context (implicit) | `trace_id`, `span_id` (automatic log-trace correlation) |

---

## How APM Tools Use This

### Today: Custom Reporter

APM tools register a custom reporter to observe log events:

```js
// Requires access to the consola instance
consola.addReporter({
  log(logObj) {
    const activeSpan = trace.getSpan(context.active());
    apmClient.captureLog({
      level: logObj.level,
      type: logObj.type,
      tag: logObj.tag,
      message: logObj.args,
      traceId: activeSpan?.spanContext().traceId,
      spanId: activeSpan?.spanContext().spanId,
    });
  }
});
```

This works, but:
- Requires access to the consola instance (which may be buried inside Nitro/Nuxt internals)
- Is specific to Consola's reporter API. Pino transports, winston transports, and bunyan streams all have different APIs. APMs write N integrations for N libraries.
- Every logging library reinvents the same observation pattern differently

### With `diagnostics_channel`: Subscribe to Structured Events

```js
const dc = require('node:diagnostics_channel');

dc.subscribe('consola:log', (logObj, name) => {
  const activeSpan = trace.getSpan(context.active());
  if (activeSpan) {
    // Automatic log-trace correlation
    apmClient.captureLog({
      level: logObj.level,
      type: logObj.type,
      tag: logObj.tag,
      message: logObj.args,
      traceId: activeSpan.spanContext().traceId,
      spanId: activeSpan.spanContext().spanId,
    });
  }
});
```

**What changes for APM vendors:**

| Concern | Custom reporter (today) | `diagnostics_channel` (proposed) |
|---|---|---|
| **Instance access** | Must find and call `addReporter()` on the consola instance | Subscribe to channel name globally, no instance needed |
| **Cross-library consistency** | Different API per library (consola reporters, pino transports, winston transports) | Same `dc.subscribe()` API for every logging library |
| **Stack consistency** | Different mechanism from h3/unstorage/db0 instrumentation | Same `diagnostics_channel` as the rest of the unjs stack |
| **Multi-vendor** | Multiple reporters coexist (works fine) | Independent subscribers, same behavior |
| **Runtime support** | Works wherever consola works | Works wherever `diagnostics_channel` is supported (Node, Bun, Cloudflare Workers) |

---

## Implementation Notes

### Insertion Point

The natural insertion point is the `_log()` method in Consola's core, which is the single funnel point all log calls pass through after level filtering:

```js
const dc = (() => {
  try {
    return ('getBuiltinModule' in process)
      ? process.getBuiltinModule('node:diagnostics_channel')
      : require('node:diagnostics_channel');
  } catch {
    return undefined;
  }
})();

const logChannel = dc?.channel('consola:log');

// In _log():
_log(logObj) {
  if (logChannel?.hasSubscribers) {
    logChannel.publish(logObj);
  }
  // Existing reporter dispatch continues unchanged
  for (const reporter of this.options.reporters) {
    reporter.log(logObj, { options: this.options });
  }
}
```

This is minimal: two lines of code in the hot path, gated behind `hasSubscribers` for zero cost when no APM is listening. The existing reporter system is completely untouched.

### Comparison with Pino's Approach

Pino uses `TracingChannel` with `traceSync` ([pinojs/pino#2281](https://github.com/pinojs/pino/pull/2281)):

```js
// Pino's approach (lib/tools.js)
function asJson(obj, msg, num, time) {
  if (asJsonChan.hasSubscribers === false) {
    return _asJson.call(this, obj, msg, num, time);
  }
  const store = { instance: this, arguments };
  return asJsonChan.traceSync(_asJson, store, this, obj, msg, num, time);
}
```

This works, but `traceSync` adds unnecessary machinery for a point event. Plain `publish()` achieves the same observable behavior: the subscriber runs synchronously with full async context access. The simpler approach is easier for maintainers to review and accept.

---

## Backward Compatibility

Zero-cost when no subscribers are registered. `hasSubscribers` is checked before publishing. Silently skipped on runtimes where `diagnostics_channel` is unavailable.

```js
const dc = (() => {
  try {
    return ('getBuiltinModule' in process)
      ? process.getBuiltinModule('node:diagnostics_channel')
      : require('node:diagnostics_channel');
  } catch {
    return undefined;
  }
})();

const logChannel = dc?.channel('consola:log');
```

Consola supports browsers where `diagnostics_channel` doesn't exist. The `try/catch` ensures the browser bundle is unaffected.

---

## Prior Art

This approach follows the pattern of ecosystem-wide adoption of `diagnostics_channel` for observability:

**Logging:**
- **`pino`** - [pinojs/pino#2281](https://github.com/pinojs/pino/pull/2281) (uses `TracingChannel` with `traceSync` for log event emission) ✅ merged (v9.10.0)

**Frameworks:**
- **`undici`** (Node.js core) - ships `TracingChannel` support since Node 20.12: [`undici:request`](https://nodejs.org/api/diagnostics_channel.html#undici-channels)
- **`fastify`** - ships `TracingChannel` support natively (`tracing:fastify.request.handler`)
- **`h3`** - [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) (`h3.request`) ✅ merged
- **`srvx`** - [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) (`srvx.request`) ✅ merged
- **`elysia`** - [elysiajs/elysia#1809](https://github.com/elysiajs/elysia/issues/1809) (`elysia:request`)
- **`hono`** - [honojs/hono#4842](https://github.com/honojs/hono/issues/4842)

**Databases:**
- **`mysql2`** - [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) ✅ merged
- **`node-redis`** - [redis/node-redis#3195](https://github.com/redis/node-redis/pull/3195) - approved, pending merge
- **`ioredis`** - [redis/ioredis#2089](https://github.com/redis/ioredis/pull/2089)
- **`pg` / `pg-pool`** - [brianc/node-postgres#3624](https://github.com/brianc/node-postgres/pull/3624)
- **`knex`** - [knex/knex#6410](https://github.com/knex/knex/pull/6410)
- **`mongodb`** - [NODE-7472](https://jira.mongodb.org/browse/NODE-7472)

**Storage/Other:**
- **`unstorage`** - [unjs/unstorage#707](https://github.com/unjs/unstorage/pull/707) ✅ merged
- **`db0`** - [unjs/db0#193](https://github.com/unjs/db0/pull/193)
- **`graphql`** - [graphql/graphql-js#4629](https://github.com/graphql/graphql-js/issues/4629)

---

Would love to hear if there's appetite for this. Happy to put together a PR with the implementation if so.
