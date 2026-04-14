---
description: Sync a ticket markdown file to its matching GitHub issue (find-or-create, idempotent)
argument-hint: [ticket-path]
---

Push a ticket's content to GitHub as an issue. One-way sync: the `.md` is the source of truth; the issue is a mirror.

**Resolve `$ARGUMENTS`:**
- If a path ending in `.md`, use it.
- Otherwise, default to `tickets/001-interaction-review-panel.md`.

**Behavior:**
- Strips the first `# H1` → issue title. Rest of file → issue body.
- Finds an existing issue with the **exact matching title** (pull requests filtered out). If found, PATCHes the body; if the body already matches, prints `unchanged` with no API write. Otherwise POSTs a new issue.

**Run from the harness root:**

```bash
npm run harness -- sync-ticket --ticket <path> --owner sidequests-aa --repo ai-harness
```

The `--owner` / `--repo` flags fall back to `HARNESS_TARGET_OWNER` / `HARNESS_TARGET_REPO` env vars. `GH_PAT` must be in the environment.

**On completion, report:**
- The action (`created` / `updated` / `unchanged`)
- The issue number and URL

If the repo already had an issue with a different title, this command will create a *second* issue — title drift is the one edge case to watch. Tell the user to rename the stale issue or delete it manually before rerunning.
