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

### 6. Refresh the Ecosystem Coverage section (monthly — download numbers drift)

The `📊 Ecosystem Coverage` section is **generated** by `scripts/coverage.py`. Do not hand-edit the block between the `<!-- COVERAGE:START -->` / `<!-- COVERAGE:END -->` markers.

```
python3 scripts/coverage.py --write
```

This refetches weekly npm downloads, recomputes the adoption-aware coverage, and rewrites the block in place. Run it **once a month** (a scheduled agent does this — see below) and whenever a new channel merges.

**When a new channel merges,** edit the data at the top of `scripts/coverage.py`:
- Add the library to `COVERED` as `pkg: ("<introducing_version>", "sentry"|"other")`. Find the introducing version by checking the first stable release published after the merge date (`gh api repos/<o>/<r>/compare/<tag>...<sha>` → status `behind` means the tag contains the merge; or the PR milestone). For pre-release-only channels (e.g. graphql v17.0.0-rc.0) use the base version (`17.0.0`) — the script strips prereleases so the rc counts as capable.
- Keep `ECOSYSTEM` in sync if a brand-new library is being tracked.

**Methodology guardrails (don't regress these):**
- Denominator = whole ecosystem, **all versions**; numerator = only **channel-capable versions** (real adoption, not "exists upstream"). This is why the script needs the per-version endpoint (`https://api.npmjs.org/versions/<pkg>/last-week`; only `last-week` works, not `last-month`).
- **Attribution discipline.** `"sentry"` = a proposal authored in this repo (`proposals/`) that merged. Never tag independent (`fastify`, `undici`, `pino`) or unjs/community (`h3`, `srvx`, `unstorage`, `nitro`) as Sentry's.
- **Report the diff (Sentry's effect) + the ceiling, never a single inflated coverage-%.** "Sentry merged native tracing into libraries representing ~X% of weekly downloads; ~Y points adopted today" is the defensible framing.

### 7. Report changes

After updating, show the user a brief summary of what changed:
- Any status changes (e.g., "pg: PR open -> Merged")
- Any new PRs or proposals discovered
- Updated progress summary numbers
