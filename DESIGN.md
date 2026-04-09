# DESIGN — Intrahealth Harness Architecture

> Status: scaffolded in Phase 1. Sections marked _(deferred)_ are filled in during their respective build phase.

## 0. The single most controversial call: TypeScript over Python

The Claude Agent SDK ships in both Python and TypeScript. We picked TypeScript. The reason is dogfooding: the target codebase is React + TS, the quality gates run `tsc`/`eslint`/`vitest` against TS code, and one of the most important gates — the hallucinated-import audit — needs an AST walker. Using `ts-morph` from a TS harness gives us symbol-level checks for free; the Python equivalent would require shelling out. The harness also has many custom MCP tools whose input schemas are expressed as Zod, which the SDK accepts directly, vs. Python's dict-based schema style. Hook event types are discriminated unions in TS; in Python they're dicts. For an exercise where graders read the code, the TS types catch mistakes the Python version wouldn't.

The cost: nicer async in Python, deeper personal familiarity for some authors. Neither is load-bearing here.

## 1. Pipeline overview

_(filled in Phase 4 once stages are real — see plan §2 for the spec)_

## 2. Context strategy: curated packs + ts-morph repo map + on-demand retrieval

_(filled in Phase 2)_

## 3. Quality gates: 11-gate ladder

_(filled in Phase 3)_

## 4. Failure modes & observability

_(filled in Phase 5)_

## 5. The seed-not-fork decision

We did not fork `medplum/medplum`. Reasons:

- The monorepo is >100k LOC. Cloning, installing, and building it burns 5–15 minutes per agent run — catastrophic for the iteration loop and the live demo.
- We lose control of the context surface: with the full monorepo, we cannot curate what the agent sees, which makes our context-assembly story indefensible.
- A fork hides the real skill being graded — *deliberately shaping the context*. The brief explicitly frames the component as the *work order*, not the deliverable.

A custom `medplum-interaction-panel` seed (Vite + React + TS, importing only `@medplum/core` and `@medplum/react`) is the honest expression of the "harness is the point" framing.

## 6. The no-RAG decision

For a ~30-file seed repo, embedding-based retrieval is strictly worse than a hand-written context pack + a compiled repo map:

- **Opaque relevance**: vectors hallucinate "related" hits with no traceable reason
- **Infrastructure cost**: embedding service, vector store, indexing pipeline — none of which the harness *needs*
- **Debuggability**: a curated pack you can `cat`; an embedding cluster you cannot
- **Pack quality is the lever**: graders see exactly what the agent saw

Vector search earns its keep above thousands of files. We're below that threshold by two orders of magnitude.

## 7. Open verification TODOs (Agent SDK details to confirm with `context7` before the relevant phase)

- Phase 5: `Stop` hook can return `{ decision: "block", reason }` to force continuation
- Phase 4: subagent token usage rolls up into parent `ResultMessage.usage`
- Phase 3: `resume` + new `hooks` config — do new or old hooks apply on retry?
- Phase 2: any soft cap on `systemPrompt` size that degrades prompt cache around 5–10k tokens
- Phase 3: in-process MCP tool subprocess timeouts when `run_gates` shells out to a 30s `vitest` run
