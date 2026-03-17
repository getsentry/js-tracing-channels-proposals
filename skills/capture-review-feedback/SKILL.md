# Skill: Capture Review Feedback

Collect review comments from an upstream TracingChannel PR, analyze each one, and present them to the operator for triage. The operator decides what to act on and replies themselves — this skill only analyzes and suggests.

## When This Skill Applies

Use when the operator wants to process review comments on a TracingChannel implementation PR. Expects a PR URL as argument (e.g. `https://github.com/sidorares/node-mysql2/pull/4178`).

## Steps

### 1. Fetch all review comments

Use `gh pr view <url> --json reviews,comments` and `gh api repos/{owner}/{repo}/pulls/{number}/comments` to collect:

- **PR-level review comments** (approve/request changes/comment)
- **Inline code review comments** (attached to specific lines/files)
- **Issue-style comments** on the PR thread

Collect: author, date, body, file/line (if inline), and review verdict (if part of a review).

### 2. Filter out noise

Skip comments that are:
- Bot-generated (CI status, coverage reports, linting)
- Pure acknowledgements ("LGTM", "thanks", emoji-only reactions)
- Conversations between other contributors unrelated to the TracingChannel changes

### 3. Analyze each substantive comment

For every remaining comment, present to the operator:

---

**Comment #{n}** — by `@{author}` on {date}
> {quoted comment body, truncated if very long}

**What they're asking:** {1-2 sentence plain-English summary of the ask}

**Validity assessment:**
- {Valid / Partially valid / Debatable / Misunderstanding}
- {Why — reference Node.js TracingChannel docs, OTel conventions, or prior art from other proposals if relevant}

**Suggested approach:** {What we could do in response — e.g. "agree and update the payload shape", "push back with rationale X", "ask clarifying question about Y", "already addressed in commit Z"}

**Learning potential:** {None / Low / High} — {If High: what general lesson could be extracted for `LEARNINGS.md`}

---

### 4. Wait for operator decisions

After presenting all comments, **stop and wait for the operator**. Do NOT:
- Reply to any comments on GitHub
- Modify any proposal files
- Write to `LEARNINGS.md`

Ask the operator:
1. **Which comments should we capture as learnings?** (reference by comment number)
2. **Any corrections to the suggested approaches?**

### 5. Write learnings (only after operator approval)

For each comment the operator selects, distill a learning and append it to `LEARNINGS.md` under the appropriate theme section:

| Theme | What goes here |
|---|---|
| Channel Naming | Conventions, naming disputes, prefix rules |
| Payload Shape | What to include/exclude in context objects, field naming |
| API Design | How TracingChannel integrates with library internals, lifecycle questions |
| Maintainer Preferences | Repo-specific conventions, testing requirements, PR style |
| Anti-Patterns | Things reviewers pushed back on that we should avoid repeating |

Each learning entry follows this format:

```markdown
### {Short title} ({library}, {date})

**From:** {PR link}
**Reviewer:** @{author}

{2-4 sentence distilled lesson. Focus on the generalizable principle, not the library-specific detail. Include the "why" so future proposals can judge whether it applies.}
```

### 6. Update the proposal skill's Prior Art table

If the library from this PR isn't already listed in `skills/propose-tracing-channel-pattern/SKILL.md`'s Prior Art table, add it with a note about key patterns learned.

## Important Constraints

- **The operator is always in control.** Never post comments, push code, or modify proposals without explicit approval.
- **Analyze, don't advocate.** Present both sides when a review comment is debatable. The operator decides the stance.
- **Distill, don't dump.** Learnings should be concise, generalizable principles — not copy-pasted reviewer quotes.
- **Tag the source.** Every learning must link back to the PR and reviewer so it can be re-evaluated if context changes.
