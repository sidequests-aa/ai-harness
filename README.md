# intrahealth-harness

An AI engineering harness — the orchestration layer that takes a ticket, feeds it to coding agents with the right context, runs quality gates, and opens a PR.

Built for the Intrahealth (HEALWELL AI) interview take-home. The drug interaction checker (`InteractionReviewPanel` React component) is the *work order* the harness consumes; **the harness itself is the deliverable**.

## What this is

A pipeline that:

1. Reads a structured GitHub Issue (the ticket)
2. Plans sub-tasks via a planner subagent
3. Assembles curated context (packs + repo map + on-demand retrieval — no RAG)
4. Runs an implementer agent inside an isolated git worktree, with **PreToolUse hooks** enforcing scope and import correctness
5. Runs an 11-gate quality ladder (prettier, eslint, tsc, vitest, RTL smoke, FHIR shape, scope/import audits, reviewer subagent)
6. Self-corrects on gate failures with a bounded retry budget
7. Opens a structured PR — green if all gates pass, draft escalation otherwise

## Architecture

Full design in [DESIGN.md](./DESIGN.md). The four graded axes:

- **Harness Architecture** — 7-stage pipeline with named SDK primitives per stage
- **Task Decomposition** — pre-decomposed ticket with DAG sub-tasks, refined by the planner
- **Quality Gates** — hooks for cheap gates, custom MCP tool for expensive gates, reviewer subagent for completeness
- **Failure Modes & Observability** — context blowup, hallucination, scope tangent, stuck loops, cost — each with detection + fallback. Structured JSONL logs, replayable.

## Run

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY and GH_PAT
npm install
npm run harness -- run --issue 1
```

## Tech

TypeScript, `@anthropic-ai/claude-agent-sdk`, `@octokit/rest`, `zod`, `ts-morph`, `vitest`. ESM, Node ≥20.
