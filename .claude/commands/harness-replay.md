---
description: Replay a past harness run from its JSONL events (no tokens spent)
argument-hint: <runId | path> [--summary | --json]
---

Replay a past run's events.jsonl through `scripts/replay-run.ts`.

**Resolve `$ARGUMENTS`:**
- If it's a plain run id (e.g. `20260409063145-90g0i8`), prefix with `runs/`.
- If it starts with `runs/` or `demo-runs/`, use as-is.
- If it points to `golden-success` or similar, try `demo-runs/<arg>`.
- If empty: list the 5 newest folders in `runs/` by mtime (with their `run.end` outcome from each `events.jsonl`) and ask the user to pick one.

Forward `--summary` or `--json` flags if present.

**Run:**
```bash
cd C:/Users/Alex/Projects/intrahealth/intrahealth-harness
npm run harness:replay -- <resolved-path> [flags]
```

This spends no tokens — it just re-renders the captured events. After the replay, point the user at `<path>/events.jsonl` and `<path>/transcript.md` if they want the raw artifacts.
