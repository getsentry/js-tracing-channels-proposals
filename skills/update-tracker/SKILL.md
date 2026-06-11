# Skill: Update TracingChannel Migration Tracker

Update `TRACKER.md` with the current progress of all TracingChannel proposals and PRs.

## When This Skill Applies

Use when asked to update the tracker, sync progress, or refresh the status of TracingChannel migration work.

## Steps

### 1. Gather current state from proposals

Read every file in `proposals/` to understand what libraries have proposals drafted.

### 2. Check upstream PR status

For every PR link in `TRACKER.md`, fetch the PR page to determine current status:

- **Merged** — PR has been merged (include merge date if visible)
- **PR open** — PR is open and awaiting review (note any approvals or review comments)
- **PR open — changes requested** — Maintainer requested changes
- **Draft** — PR is in draft state
- **Closed** — PR was closed without merging (note reason if visible)

Use `gh pr view <url>` or `WebFetch` to check each PR.

### 3. Check for new upstream PRs or issues

For libraries that have proposals in `proposals/` but no PR link in the tracker, check if a PR or issue has been opened upstream:
- Search the target repo for issues/PRs mentioning `TracingChannel` or `diagnostics_channel` or `tracing channel`
- Also search the target repo for recent issues/PRs created by the current user (`--author=@me`) to catch issues that may use different wording
- If found, add the link to the tracker

### 4. Update the tracker tables

Update each row in `TRACKER.md` with the latest status. Follow these status conventions:

| Emoji | Status | Meaning |
|---|---|---|
| ⬜ | Not started | No proposal or PR exists |
| 📝 | Proposal drafted | Proposal exists in `proposals/` but no upstream PR |
| 💬 | In discussion | Issue/discussion open but no PR yet |
| 🟡 | PR open | Upstream PR exists and is open |
| 🟡 | PR open — approved by X | PR has approvals |
| 🟡 | PR open — changes requested | Maintainer requested changes |
| ✅ | **Merged** (YYYY-MM-DD) | PR merged, include date |
| ✅ | **Merged & released** (vX.Y.Z, YYYY-MM-DD) | Merged AND shipped in a release. Confirm the release version by checking the PR milestone and which release tag contains the merge commit (`gh api repos/<owner>/<repo>/compare/<tag>...<sha>` → status `behind` means the tag includes it). Flag pre-releases (e.g. `v17.0.0-rc.0`) explicitly — they are not adoptable by most users yet. |

### 5. Recalculate the Progress Summary

Recount all rows and update the Progress Summary table at the bottom of `TRACKER.md`. The categories are:

- **OTel-provided** (24 total)
- **Sentry-built** (11 total)
- **Other (non-Sentry)** — count may grow as new libraries are added

Count each row into exactly one bucket: Merged, PR Open, In Discussion, Not Started. "Proposal drafted" counts as "In Discussion". Libraries that ship the channel natively without our involvement (e.g. fastify, undici) count as Merged.

### 6. Refresh the Ecosystem Reach section (optional — only if asked or numbers are stale)

The `📊 Ecosystem Reach (rough)` section translates the checklist into download-weighted footprint. It is NOT auto-synced; only refresh when explicitly asked or when statuses changed materially.

- Pull rough monthly downloads with `curl -s https://api.npmjs.org/downloads/point/last-month/<pkg>` (scoped packages must be fetched individually; the API rate-limits bursts — space requests out or it returns `error code: 1015`). Round to the nearest million for the `~DL/mo` column.
- **Preserve the caveats verbatim** — they are the point. The numbers are a footprint, NOT adoption:
  - downloads ≠ apps (libraries are co-used, so sums double-count the same apps);
  - version lag (channel only in newest release; download counts include all old versions, so a freshly-shipped or pre-release channel has ~0 real adoption — call these out by name, e.g. graphql v17-rc);
  - transitive/CI pulls inflate counts.
- **Attribution discipline.** "Sentry-driven" = a proposal authored in this repo (`proposals/`) that merged. Do NOT claim independent (`fastify`, `undici`, `pino`) or unjs/community (`h3`, `srvx`, `unstorage`, `nitro`) work as Sentry's. Note that independent work (chiefly undici, Node core) dominates the "exists upstream" bucket.
- **Do not resurrect a single headline coverage-% (e.g. "90% covered").** It conflates footprint with adoption and is indefensible. Prefer the concrete "Sentry merged native tracing into libraries pulling ~XXXM downloads/mo, of which ~YYYM is in stable releases today" framing.

### 7. Report changes

After updating, show the user a brief summary of what changed:
- Any status changes (e.g., "pg: PR open -> Merged")
- Any new PRs or proposals discovered
- Updated progress summary numbers
