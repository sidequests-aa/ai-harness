---
description: Compact status report — runs, worktrees, git, latest verdict
---

Produce a one-shot status report for the harness repo.

**Collect (in parallel where possible):**

1. **Git state:**
   - Current branch, `git status --short`, ahead/behind `origin/main`.
   - Last 5 commits, oneline.

2. **Runs (`runs/`):**
   - Total count.
   - For the 3 newest folders (by mtime): run id, outcome (tail `events.jsonl` for `run.end.outcome`), cost (last `budget.tick.costUsd` or the `run.end` tick), duration.

3. **Worktrees (`../.harness-worktrees/`):**
   - Total count.
   - Latest (by mtime): folder name + whether its `seed/InteractionReviewPanel.tsx` is the placeholder (17 lines, throws) or a real implementation (>100 lines).

4. **Latest reviewer verdict:**
   - Find the newest `runs/*/reviewer-verdict.json` (if any).
   - Report `approved` + counts of `met` / `partial` / `unmet` criteria.

**Format** as markdown sections with a single summary table at the top:

```
| | |
|---|---|
| Branch | main (clean, up to date) |
| Last run | <runId> — pr-opened — $X.XX — N turns |
| Runs total | N |
| Worktrees total | N (latest: <name>, feature: placeholder/implemented) |
| Latest verdict | approved (12/0/0) |
```

Then details below. Keep the whole report under ~40 lines.
