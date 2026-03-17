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
- Search the target repo for issues/PRs mentioning `TracingChannel` or `diagnostics_channel`
- If found, add the link to the tracker

### 4. Update the tracker tables

Update each row in `TRACKER.md` with the latest status. Follow these status conventions:

| Status | Meaning |
|---|---|
| Not started | No proposal or PR exists |
| Proposal drafted | Proposal exists in `proposals/` but no upstream PR |
| PR open | Upstream PR exists and is open |
| PR open — approved by X | PR has approvals |
| PR open — changes requested | Maintainer requested changes |
| **Merged** (YYYY-MM-DD) | PR merged, include date |
| In discussion | Issue/discussion open but no PR yet |

### 5. Recalculate the Progress Summary

Recount all rows and update the Progress Summary table at the bottom of `TRACKER.md`. The categories are:

- **OTel-provided** (24 total)
- **Sentry-built** (13 total)
- **Other (non-Sentry)** — count may grow as new libraries are added

Count each row into exactly one bucket: Merged, PR Open, In Discussion, Not Started. "Proposal drafted" counts as "In Discussion".

### 6. Report changes

After updating, show the user a brief summary of what changed:
- Any status changes (e.g., "pg: PR open -> Merged")
- Any new PRs or proposals discovered
- Updated progress summary numbers
