---
description: Replay the golden-success captured run + summarize outcome
---

Replay the canonical successful run at `demo-runs/golden-success/`.

**Steps:**

1. From the harness root:
   ```bash
   npm run harness:replay -- demo-runs/golden-success
   ```

2. After the replay renders, produce a short summary by reading:
   - `demo-runs/golden-success/reviewer-verdict.json` — pull `approved`, count of `met` / `partial` / `unmet` criteria, and any non-empty `comments`.
   - The last `run.end` event in `demo-runs/golden-success/events.jsonl` — pull `outcome` and `prUrl` if present.
   - Sum the `budget.tick` events for final cost + turn count (or grab the final one).

3. Print a compact markdown summary:

   | Field | Value |
   |---|---|
   | Outcome | pr-opened / escalated |
   | Reviewer verdict | approved / not |
   | AC stats | X met, Y partial, Z unmet |
   | Cost | $X.XX |
   | Turns | N |
   | PR URL | … |

Add a one-line pointer telling the user they can open `demo-runs/golden-success/transcript.md` for the full agent conversation.
