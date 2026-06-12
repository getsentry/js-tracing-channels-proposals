// @ts-check
import { defineConfig } from 'astro/config';

// Project GitHub Pages site → served under /<repo>/.
// Override with SITE_BASE / SITE_URL env vars (e.g. for a custom domain set SITE_BASE=/).
const base = process.env.SITE_BASE ?? '/js-tracing-channels-proposals/';
const site = process.env.SITE_URL ?? 'https://getsentry.github.io';

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  vite: {
    // The canonical data file lives at the repo root (../data), outside this
    // Astro project root. Allow Vite to read it during dev + build.
    server: { fs: { allow: ['..'] } },
  },
});
