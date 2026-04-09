# intrahealth-harness

An AI engineering harness — the orchestration layer that takes a ticket, feeds it to coding agents with the right context, runs quality gates, and opens a PR.

Built for the Intrahealth (HEALWELL AI) interview take-home. The drug interaction checker (`InteractionReviewPanel` React component) is the *work order* the harness consumes; **the harness itself is the deliverable**.

## Repo layout

A single repo with the harness at the root and the seed it operates on as a subfolder:

```
intrahealth-harness/                ← this repo, the deliverable
├── README.md
├── DESIGN.md                       ← architecture writeup (graded)
├── src/                            ← harness source (the orchestrator)
│   ├── cli.ts                      ← `npm run harness -- run --ticket ...`
│   ├── parseTicket.ts              ← markdown → typed Ticket (no LLM)
│   ├── runAgent.ts                 ← Claude Agent SDK wrapper
│   ├── git.ts                      ← worktree helpers
│   └── github.ts                   ← Octokit wrapper
├── tests/                          ← harness unit tests
├── tickets/                        ← work orders the harness consumes
│   └── 001-interaction-review-panel.md
├── seed/                           ← target the agent operates inside
│   ├── package.json                ← Vite + React + TS + Medplum + Mantine
│   ├── src/components/InteractionReviewPanel/  ← placeholder + failing test
│   └── ...
└── .harness-worktrees/             ← (gitignored, sibling to this repo) per-run worktrees
```

The harness creates an isolated git worktree of *this* repo, the agent runs inside the worktree's `seed/` subfolder, the PR is opened against this same repo with changes confined to `seed/`.

## What this is

A pipeline that:

1. Reads a structured ticket markdown file
2. Plans sub-tasks via a planner subagent _(Phase 2)_
3. Assembles curated context (packs + repo map + on-demand retrieval — no RAG) _(Phase 2)_
4. Runs an implementer agent inside an isolated git worktree, with **PreToolUse hooks** enforcing scope and import correctness _(Phase 3)_
5. Runs an 11-gate quality ladder (prettier, eslint, tsc, vitest, RTL smoke, FHIR shape, scope/import audits, reviewer subagent) _(Phase 3-4)_
6. Self-corrects on gate failures with a bounded retry budget _(Phase 3)_
7. Opens a structured PR — green if all gates pass, draft escalation otherwise

Phase 1 (current): the skeleton — CLI, ticket parser, worktree creation, agent invocation, simple PR opener. No hooks, no gates, no reviewer. The flow is end-to-end so later phases can deepen each axis without restructuring.

## Architecture

Full design in [DESIGN.md](./DESIGN.md). The four graded axes:

- **Harness Architecture** — 7-stage pipeline with named SDK primitives per stage
- **Task Decomposition** — pre-decomposed ticket with DAG sub-tasks, refined by the planner
- **Quality Gates** — hooks for cheap gates, custom MCP tool for expensive gates, reviewer subagent for completeness
- **Failure Modes & Observability** — context blowup, hallucination, scope tangent, stuck loops, cost — each with detection + fallback. Structured JSONL logs, replayable.

## Run

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and GH_PAT.

npm install
cd seed && npm install && cd ..

# Run from the harness root. Defaults: --target=. --cwd-subdir=seed
npm run harness -- run --ticket ./tickets/001-interaction-review-panel.md

# Local-only iteration (skips push + PR creation):
npm run harness -- run --ticket ./tickets/001-interaction-review-panel.md --no-pr
```

## Tech

- **Harness**: TypeScript, `@anthropic-ai/claude-agent-sdk`, `@octokit/rest`, `zod`, `ts-morph`, `vitest`. ESM, Node ≥20.
- **Seed**: Vite 8 + React 19 + TypeScript, `@medplum/{core,react,mock,fhirtypes}`, `@mantine/core` (transitively required), vitest + `@testing-library/react`.
