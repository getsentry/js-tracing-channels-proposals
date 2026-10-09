# Nuxt `nuxt.request`: `TracingChannel` Proposal

> **Issue:** TBD (going straight to PR)
> **Status:** 📝 Proposal drafted, implementation on `awad/nuxt-request-tracing-channel`
> **Target package:** `nuxt` (renderer in `packages/nuxt/src/runtime/server/renderer`), motivated by `@nuxt/vite-server`

---

Nuxt 4.5 added opt-in [`TracingChannel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) support in [nuxt/nuxt#35191](https://github.com/nuxt/nuxt/pull/35191): the `tracingChannel` option turns on Nuxt's own `nuxt.*` channels and passes the `srvx`, `h3` and `unstorage` toggles down to Nitro. Nuxt 4.6 introduced [`@nuxt/vite-server`](https://nuxt.com/blog/v4-6#a-server-agnostic-nuxt), an experimental server builder that renders the app without Nitro or h3.

With `@nuxt/vite-server`, the `nuxt.*` channels still fire, but nothing publishes a request-level channel for them to nest under. APM subscribers get render, data, plugin and middleware spans with no request span as their parent. On Nitro that parent comes from `srvx.request` and `h3.request`, both of which are tied to that stack.

This proposal adds a `nuxt.request` channel in Nuxt's own renderer, so every server builder, deploy target and dev server gets a request span without depending on srvx or h3.

---

## Why the renderer

Every request Nuxt renders goes through `createNuxtRenderer().fetch(event)`, whichever runtime is serving it:

| Path | Route to the renderer |
|---|---|
| vite-server, node | srvx `serve()` → `createFetchHandler` → `renderer.fetch` |
| vite-server, Cloudflare / Netlify / universal-deploy | platform → `#server-entry` `fetch` → `createFetchHandler` → `renderer.fetch` |
| vite-server, dev | Vite middleware → `ssrLoadModule(serverEntry).fetch` → `createFetchHandler` → `renderer.fetch` |
| Nitro | srvx → h3 → `nitro-server/runtime/handlers/renderer.ts` → `renderer.fetch` |

The alternatives each miss some of these paths. Installing `srvx/tracing` in vite-server's node entry only helps node production: the other deploy targets never start an srvx server, and the dev server bridges Vite's middlewares without one.

---

## Proposed Tracing Channel

| Channel | Tracks | Context |
|---|---|---|
| `nuxt.request` | Each request the renderer handles: pages, payloads, islands and error routes | `{ event }` |

It follows the existing `nuxt.*` conventions: the [untracing](https://github.com/unjs/untracing) `{namespace}.{operation}` name, the shared `traceAsync` helper, and the `tracingChannelNuxt` build flag.

### Context Properties

| Field | Source | Enables |
|---|---|---|
| `event` | `appEvent(event)`: the server runtime's own event when it provides one (`event['~app']`), else the renderer event | `http.request.method`, `url.full`, `url.path`, request headers, and route data from the app event. Same object `nuxt.render` already publishes, so subscribers can correlate the two. |

The event is passed raw, not pre-extracted, matching the other framework channels.

### Implementation

```ts
export function createNuxtRenderer (optionsOrInstance) {
  const instance = 'getRenderer' in optionsOrInstance ? optionsOrInstance : createRendererInstance(optionsOrInstance)
  return {
    fetch: tracingChannelNuxt
      ? event => traceAsync('nuxt.request', { event: appEvent(event) }, () => fetch(instance, event))
      : event => fetch(instance, event),
  }
}
```

The branch is chosen once per renderer, not per request, and `tracingChannelNuxt` is a build-time constant, so a build without tracing drops the traced path entirely.

### Nesting

| Builder | Span tree |
|---|---|
| vite-server (any target, dev) | `nuxt.request` → `nuxt.render` → `nuxt.data` / `nuxt.plugin` / ... |
| Nitro | `srvx.request` → `h3.request` → `nuxt.request` → `nuxt.render` → ... |

On Nitro the extra span is redundant but harmless; it marks where Nitro hands off to Nuxt.

### Known gaps

- **Requests the renderer never sees:** Nitro API routes (`server/api`), and in vite-server the static files and route-rule redirects that `createFetchHandler` answers before calling the renderer.
- **Error page re-render:** when vite-server's `createFetchHandler` catches a failed render it calls `renderer.fetch` again for the error page, producing a second `nuxt.request`. With inline error rendering (the default) the renderer handles errors itself, so this only applies with `experimental.inlineErrorRendering: false`.

---

## Test

`test/renderer/tracing-channel.test.ts`, in the existing `renderer` Vitest project (standalone renderer fixture, `tracingChannelNuxt` mocked on):

- `nuxt.request` start/asyncEnd brackets `nuxt.render` start/asyncEnd for a page render.
- The published `event` is the app event when the server runtime provides one.

Both fail without the change.

---

## Backward Compatibility

- **Opt-in:** only active with `tracingChannel` (or `tracingChannel.nuxt`) enabled, like every other `nuxt.*` channel.
- **Zero-cost when unused:** `tracingChannelNuxt` is inlined at build time. When enabled with no subscribers, `traceAsync` calls `fetch` directly.
- **Runtimes without `diagnostics_channel`:** `traceAsync` looks up the module with `process.getBuiltinModule` and falls through when it's missing (workerd without `nodejs_compat`, browsers).

---

## Prior Art

- **`undici`** (Node.js core): ships TracingChannel support since Node 20.12
- **`nuxt`**: [nuxt/nuxt#35191](https://github.com/nuxt/nuxt/pull/35191) ✅ merged (v4.5.0)
- **`srvx`**: [h3js/srvx#141](https://github.com/h3js/srvx/pull/141) ✅ merged
- **`h3`**: [h3js/h3#1251](https://github.com/h3js/h3/pull/1251) ✅ merged
- **`mysql2`**: [sidorares/node-mysql2#4178](https://github.com/sidorares/node-mysql2/pull/4178) ✅ merged
