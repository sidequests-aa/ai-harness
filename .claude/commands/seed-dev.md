---
description: Boot the seed's Vite dev server (placeholder by default; --latest for completed feature)
argument-hint: [--latest | <runId>]
---

Start the seed React app in dev mode.

**Mode selection:**

- **Default (no arg):** run the seed at `intrahealth-harness/seed/`. This is the placeholder state — the `InteractionReviewPanel` throws, and `App.tsx`'s error boundary shows a "Component not yet implemented" message. Useful for seeing the "before" the agent ran.

- **`--latest`:** find the newest folder under `C:/Users/Alex/Projects/intrahealth/.harness-worktrees/` by mtime, `cd` into its `seed/` subfolder. This is the "after" — the agent-completed `InteractionReviewPanel`.

- **`<runId>` (e.g. `20260409063145-90g0i8`):** match the worktree whose folder contains that run id and use its `seed/`.

**Steps:**

1. Resolve the target `seed/` directory per the mode above.
2. If `node_modules/` is missing in that folder, run `npm install` first (will take ~30-90s for a fresh worktree).
3. Run `npm run dev`.
4. Watch for vite's "Local: http://localhost:<port>" line and report it to the user.
5. Leave the process running.

If the target directory doesn't exist (e.g. no worktrees yet for `--latest`), stop and tell the user to run `/harness-run` first.
