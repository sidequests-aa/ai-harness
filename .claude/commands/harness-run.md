---
description: Run the harness on a ticket — spawns agent, runs gates, opens PR
argument-hint: [ticket-path] [--no-pr]
---

Run the intrahealth-harness pipeline on a ticket.

**Resolve the ticket path from `$ARGUMENTS`:**
- If it's a path ending in `.md`, use it.
- Otherwise, default to `tickets/001-interaction-review-panel.md`.
- Forward any other flags the user passed (e.g. `--no-pr`, `--cwd-subdir=seed`) unchanged.

**Before starting:**
- Confirm the working directory is the harness root (`C:/Users/Alex/Projects/intrahealth/intrahealth-harness`). If not, `cd` there.
- Verify `.env` exists and contains `ANTHROPIC_API_KEY` and `GH_PAT`. If either is missing, stop and tell the user.
- Confirm `node_modules/` exists in both the harness root and `seed/`. If missing, `npm install` in each first.

**Then run:**
```bash
npm run harness -- run --ticket <ticket-path> [forwarded flags]
```

Stream output. When it finishes, parse the tail for the run id and outcome (`pr-opened` / `escalated` / `failed`) and report:
- The run id + folder (`runs/<runId>/`)
- The outcome + PR URL (if opened) or escalation reason
- Pointer to `npm run harness:replay -- runs/<runId>` for inspection

If the run errors before completing, surface the error and suggest the replay command plus `runs/<runId>/events.jsonl` for inspection.
