# CLAUDE.md — intrahealth-harness

## What this project is

An **AI engineering harness** — the deliverable, not the drug interaction checker. It takes a structured ticket, runs a coding agent inside an isolated git worktree with curated context, enforces quality gates via hooks + a custom MCP tool, then opens a PR (or draft escalation).

The `InteractionReviewPanel` React component is the *work order* the harness consumes. The harness itself is what's graded. Full architecture: see `DESIGN.md`.

## Layout

- `src/` — harness source (TypeScript, ESM, Node ≥20)
  - `cli.ts` — entry point (`npm run harness -- run --ticket ...`)
  - `parseTicket.ts` — regex/markdown ticket parser. **No LLM call.**
  - `runAgent.ts` — Claude Agent SDK wrapper (`query()` from `@anthropic-ai/claude-agent-sdk`)
  - `runReviewer.ts` — reviewer subagent (separate top-level `query()`, fresh context, structured output)
  - `contextPacks.ts`, `repoMap.ts` — Layer A (curated packs) + Layer B (ts-morph repo map) context assembly
  - `hooks/` — `importAudit.ts` (G4, PreToolUse, ts-morph), `scopeGuard.ts` (G5, PreToolUse, picomatch), `fastGate.ts` (G1/G2 PostToolUse), `stopProgress.ts` (Stop hook)
  - `tools/` — `mcp__harness__run_gates` custom MCP tool for expensive gates (G6–G10)
  - `observability/` — `schema.ts` (RunEvent discriminated union), `runReport.ts` (PR body builder)
  - `git.ts`, `github.ts` — worktree helpers + Octokit wrapper
- `tests/` — harness unit tests (vitest). `parseTicket.test.ts` (9 tests), `scopeGuard.test.ts`
- `tickets/` — work orders. Canonical: `001-interaction-review-panel.md`
- `context-packs/medplum/` — hand-written context packs, referenced by name from tickets
- `scripts/replay-run.ts` — re-renders `runs/<runId>/events.jsonl` without re-executing the agent (no API cost)
- `seed/` — Vite 8 + React 19 + TS + Medplum + Mantine target the agent operates inside. The agent's `cwd` is set here.
- `runs/<runId>/` — per-run artifacts (JSONL events, transcript). Gitignored.
- `.harness-worktrees/` — per-run git worktrees, sibling to this repo. Gitignored.

## Commands

```bash
npm run harness -- run --ticket ./tickets/001-interaction-review-panel.md
npm run harness -- run --ticket ... --no-pr       # local-only, skips push + PR
npm run harness:replay -- runs/<runId>            # pretty transcript (no LLM call)
npm run harness:replay -- runs/<runId> --summary  # one line per event
npm test                                          # vitest on harness (fast, ms)
npm run typecheck                                 # tsc --noEmit over harness
```

Seed gates (G6–G10) run from inside `seed/` via the `run_gates` MCP tool — not invoked directly from the harness CLI.

## Conventions

- **No LLM for structured data.** `parseTicket.ts` is pure regex. Don't introduce model calls on ticket parsing, file-path matching, or anything else that has a deterministic solution.
- **Three gate wiring strategies, each deliberate:** PreToolUse hooks block bad actions (G4, G5). PostToolUse hooks verify after a write (G1, G2). The `run_gates` MCP tool runs expensive gates once against final state (G6–G10). The reviewer (G11) is a **separate top-level `query()`** — fresh context, read-only tools, structured output via `outputFormat: { type: 'json_schema' }`. Don't collapse these into one mechanism.
- **Hook deny reasons teach the agent.** `PreToolUseHookSpecificOutput.permissionDecisionReason` is fed back as the tool result. Deny messages should name the specific problem (bad import specifier, out-of-scope path) so the agent can self-correct.
- **Pre-decomposed at epic level, refined at file level.** The human ticket author writes `## Sub-Tasks (DAG)`. The planner subagent (Phase 2+) refines into file-level items. Letting the agent choose the coarse decomposition is how scope creep happens.
- **No RAG / no embeddings.** For ~30-file seeds, curated packs + ts-morph repo map beat vector search on every axis (relevance, cost, debuggability). Don't reach for an embedding store.
- **Structured logging is JSONL.** Every event is a discriminated union member in `observability/schema.ts` (narrowed on `t`). Append-friendly, grep-friendly, replayable.
- **PR description is the primary observability surface.** Dense by design — metrics table, AC table, gates table, out-of-scope requests, hallucinated imports. Graders read it before the diff.

## Gotchas

- **Don't fork `medplum/medplum`.** The seed is a custom Vite app that imports `@medplum/core` + `@medplum/react`. A full monorepo clone+install is 5–15 min per run and kills iteration speed + context curation. See DESIGN §6.
- **Two `node_modules` trees:** one at repo root (harness deps), one at `seed/` (seed deps). After cloning: `npm install && (cd seed && npm install)`.
- **Worktrees live outside the repo** (`.harness-worktrees/`, sibling path). The PR opens against this same repo; changes are confined to `seed/` by the scope-guard hook.
- **Cost is post-hoc**, pulled from `ResultMessage.usage` after the run. Mid-run token budgeting is a documented TODO (DESIGN §8) — don't assume it exists.
- **`maxTurns` is SDK-native**; cost and wall time are enforced by the CLI's approval predicate, not by the SDK. Exceeding any of them flips the PR to draft escalation.
- **Reviewer subagent token rollup is unverified** — whether its tokens appear in the implementer's `ResultMessage.usage` is an open question (DESIGN §9.5). If you need accurate total cost, track them separately.
- **Windows + bash here:** use forward slashes and Unix shell syntax in tooling. The harness CLI has been exercised on win32 + bash.

## Where to start reading

1. `DESIGN.md` §0 (the three load-bearing decisions)
2. `src/cli.ts` (the 7-stage pipeline, top-down)
3. `tickets/001-interaction-review-panel.md` (what a ticket looks like in practice)
4. `src/hooks/` (the cheap-gate mechanism)
5. `src/tools/` (the `run_gates` MCP tool — the expensive-gate mechanism)
