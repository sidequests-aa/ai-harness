# Finding 01 — App-shell scope gap

> A concrete demonstration of a class of harness failure the current gate ladder cannot detect: the agent's component is internally correct and fully tested, but depends on providers and props the *app shell* (out of scope for the agent) must supply. Every gate passes. The feature can't actually render.

This finding emerged from exercising the harness's completed `InteractionReviewPanel` inside a real Medplum `AppShell` + `MedplumProvider` + `MockClient` setup — i.e. a faithful clinical-portal context rather than the isolated unit-test harness.

Relevant to:
- [DESIGN §4 — Quality Gates → Completeness Assessment](../../DESIGN.md#4-quality-gates--the-11-gate-ladder)
- [DESIGN §5 — Failure Modes → Tangent / scope creep](../../DESIGN.md#51-failure-modes--detection-and-fallback)

---

## What was observed

Harness run `20260409063145-90g0i8` completed with:
- `reviewer.verdict.approved = true` (G11)
- All 11 gates green
- PR opened against the old remote

When the component was mounted in a real Medplum portal (not the test environment), it threw at render in two distinct ways, in sequence:

| # | Symptom at runtime | Thrown by |
|---|---|---|
| 1 | `@mantine/core: MantineProvider was not found in component tree` | Mantine's `<Alert>` inside the panel |
| 2 | `TypeError: Cannot read properties of undefined (reading 'checkInteractions')` | Panel's own `drugInteractionApi.checkInteractions(...)` |

Both are **integration** failures. The component itself is internally correct. The missing pieces live in files the agent was not allowed to touch.

---

## The trace

1. The ticket's `## File Scope` section listed:
   ```
   src/components/InteractionReviewPanel/**
   src/types/drugInteractionApi.ts
   ```
2. The scope-guard hook (G5) — **correctly** — denied any agent `Write` or `Edit` against `src/main.tsx` or `src/App.tsx`.
3. The agent implemented `InteractionReviewPanel.tsx` using `@mantine/core` primitives (`Alert`, `Button`, `Textarea`) per the ticket's "Human Notes": *"Prefer `@mantine/core` UI primitives where they exist."*
4. The agent's test file (`InteractionReviewPanel.test.tsx`) wraps each render in its own `<MantineProvider>` and `<MedplumProvider medplum={new MockClient()}>`, and passes a hand-rolled `MockDrugInteractionApi` directly via props.
5. Every gate evaluated the component *in isolation*:
   - G6 (vitest) ran the component's tests, which wrapped their own providers and supplied their own props → all passed.
   - G10 (visual-state coverage) grepped the test file for `data-testid="state-*"` → all five found.
   - G11 (reviewer subagent) evaluated acceptance criteria against the diff (read-only; no runtime) → approved.
6. Nowhere in the gate ladder does the app's `main.tsx` / `App.tsx` actually render the component in the configuration a real clinician would see.

So: **tests passed on an app shell the agent tests built themselves, not on the shell that will ship.**

---

## Why each gate slipped

| Gate | Why it didn't catch this | Could it have? |
|---|---|---|
| G4 import-audit (PreToolUse, ts-morph) | Audits the agent's *own* imports. All resolve. `@mantine/core` is a real package. | No — imports are legitimate. |
| G5 scope-guard (PreToolUse, picomatch) | The agent never tried to edit `main.tsx`. The deny never fired. Correct behavior — the scope was respected. | No — and it *shouldn't*. Expanding scope silently would undermine the whole guarantee. |
| G6 vitest | Tests render the component with self-wrapped providers. No integration-level render is asserted. | Only if we add an integration-level test that renders from the real `main.tsx` path. |
| G10 visual-state coverage | Grep for `state-*` testids finds them in the unit tests. | No — the grep has no knowledge of render context. |
| G11 reviewer subagent | Read-only over the diff + AC list. It approved because the diff satisfies every AC *literally*. | Potentially — if the reviewer's prompt explicitly asked "does the app shell supply every non-optional prop and every required provider?" (see mitigation below). |

The scope-guard's denial is the right default. The miss is that the **human-authored app shell** (out of ticket scope, not inside any hook's responsibility) evolved out of step with the component.

---

## Rubric mapping

This is exactly the class of problem the brief's four graded areas ask about:

- **§3 Quality Gates → "Completeness assessment: How does the harness know the ticket is 'done' vs 'the agent gave up and produced something incomplete'?"**
  The harness said *done*. The reviewer said *approved*. The feature cannot render. Current definition of done is `unit-tests-pass + reviewer-approved`. That's not tight enough for components with provider/prop dependencies.

- **§4 Failure Modes → "Tangent detection: How do you bound its scope? ... The agent goes off-track (e.g., refactoring unrelated code, or trying to solve a problem it should ask about)."**
  The inverse failure: the agent correctly stays in scope, but the scope was too tight to deliver a *runnable* feature. There's a real place in the harness for a `request_scope_expansion` tool — the agent records that an extra file needs editing, the harness surfaces it to the human reviewer without granting access.

---

## Mitigations (not yet implemented — for discussion)

### 1 · A G12 render-smoke gate

A new gate that actually imports the component from the shipping `main.tsx` path and mounts it, asserting no throw. This would have caught both failures.

- Add a vitest integration test in `seed/tests/integration/render-smoke.test.tsx`:
  ```ts
  import App from '../../src/App';
  import { render, screen } from '@testing-library/react';
  // full MedplumProvider + MantineProvider wrap identical to main.tsx
  it('renders App without throwing', async () => {
    render(<ProvidersFromMain><App /></ProvidersFromMain>);
    await screen.findByTestId(/state-/);
  });
  ```
- Wire into `run_gates` after G6, before G11.
- **Cost:** ~2–5s per run; integration tests amortize well.
- **Caveat:** requires the harness to know what a "shipping app shell" is for the target. For the seed that's `src/App.tsx`; for a different target it would be a config entry.

### 2 · Reviewer subagent prompted for app-shell integration

Cheapest change. Extend the reviewer's system prompt with a clause:

> Before marking `approved`, verify that every **required** prop on the ticket's component is supplied somewhere in the shipping app (not just in tests), and every **context provider** the component depends on is installed at the app root. If either is missing, mark the AC unmet and name the gap.

- **Cost:** one prompt edit. A few hundred output tokens per reviewer run.
- **Caveat:** LLM-as-judge is probabilistic; may miss for complex dependency graphs. Worth pairing with (1).

### 3 · Materialize `request_scope_expansion`

A real custom MCP tool the agent can call when it realizes a file outside its scope needs a companion change. Today the scope-guard's deny reason *mentions* such a tool, but it doesn't exist. Materializing it would:

- Log the agent's attempted companion edit without applying it
- Surface a dedicated "Out-of-scope requests" section in the PR description (already scaffolded — see `src/observability/runReport.ts`)
- Let the human reviewer decide whether to expand scope and rerun

For this finding specifically, the agent would have logged: *"Needs `<MantineProvider>` + `<InteractionReviewPanel drugInteractionApi=... />` in src/main.tsx and src/App.tsx"* — which the reviewer would have seen before merging.

---

## Evidence

- Broken-render screenshots: see the review panel rendered in the Medplum AppShell in `docs/findings/01-screenshots/` *(not included — reproduced live in the walkthrough)*.
- Run id where this was discovered: `20260409063145-90g0i8` (latest "approved" run in `runs/`).
- Completed-component source: `.harness-worktrees/harness__20260409063145-90g0i8-*/seed/src/components/InteractionReviewPanel/`.
- App-shell wiring fix (not committed back into the worktree PR — it's out of ticket scope by design): documented conceptually at the end of this file.

### App-shell changes required to make the feature render

Only three files outside the ticket scope need edits:

**`seed/src/main.tsx`** — wrap in `MantineProvider`, import mantine styles:
```tsx
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
// ...
<MantineProvider>
  <MedplumProvider medplum={medplum}>
    <App />
  </MedplumProvider>
</MantineProvider>
```

**`seed/src/App.tsx`** — instantiate a `DrugInteractionApi` implementation, seed the `MockClient`, supply the component's required props.

**`seed/package.json`** — no change; `@mantine/core` is already a dependency (transitively via `@medplum/react`, and declared directly).

None of these are component-logic changes. They are provider / dependency-injection wiring.

---

## One-line takeaway for the walkthrough

> "The scope-guard kept the agent in its lane. The tests wrapped their own providers. The reviewer read the diff. Every gate passed. The feature couldn't render in prod. That's the gap the harness doesn't yet close — and closing it is worth at least one new gate + one reviewer-prompt clause."
