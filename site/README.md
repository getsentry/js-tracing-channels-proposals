# Do I Have Diagnostic Channels? 🔌

A playful yes/no site: type an npm package, find out instantly whether it ships
native `diagnostics_channel` / `TracingChannel` support — and where the upstream
work stands.

Built with [Astro 6](https://astro.build), deployed to GitHub Pages.

## Data

The site reads **`../data/libraries.json`** at build time — the canonical,
hand-maintained structured dump of the [TracingChannel migration
tracker](../TRACKER.md). It is kept in sync with `TRACKER.md` by the
[`update-tracker` skill](../skills/update-tracker/SKILL.md). Edit the JSON there,
not in this folder.

Each library carries the AA / AAA capability pair:

- **AA** — ships plain `diagnostics_channel` events (observable, no span lifecycle).
- **AAA** — ships a `TracingChannel` (`start`/`end`/`asyncStart`/`asyncEnd` + context).

## Develop

```bash
cd site
pnpm install
pnpm dev      # http://localhost:4321/js-tracing-channels-proposals/
pnpm build    # static output → dist/
pnpm preview  # serve the built site
```

## Deploy

Pushing to `main` (touching `site/**` or `data/**`) triggers
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), which builds and
publishes to GitHub Pages. **One-time setup:** in the repo settings, set
*Pages → Build and deployment → Source* to **GitHub Actions**.

The base path defaults to `/js-tracing-channels-proposals/`. Override via env for a
custom domain: `SITE_BASE=/ SITE_URL=https://example.com pnpm build`.
