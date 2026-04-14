# Presentation script — ~18 min, natural voice

Read this out. It's written to sound like you're just talking — contractions, hedges, mid-sentence corrections where they help. Don't recite it word-for-word; let yourself wander a few seconds then come back to the next paragraph.

Line breaks are breath marks. Em-dashes are short pauses.

---

## 1 · Framing (≈ 1:30)

Okay — so the brief was pretty specific. "Build the machinery that builds the drug interaction checker." Not the checker itself. The harness is the deliverable, the checker is just the work order I feed in to prove the machinery works.

So that's what I built. It's a TypeScript pipeline that takes a ticket — a markdown file or a GitHub issue — and does seven things with it. Parses it, plans, assembles context, runs an agent inside an isolated git worktree, runs a stack of quality gates, gets a reviewer subagent to do a completeness pass, and opens a pull request. Or a draft PR with escalation notes if something went wrong.

I picked TypeScript because the target codebase is TypeScript-React — that lets me use one `tsc`, one `eslint`, one `vitest` for both the harness and the seed it operates on. And I lean on `ts-morph` pretty heavily for the import-audit hook, which I'll get to.

Let me show you the ticket first.

---

## 2 · The ticket (≈ 3:00)

This is `tickets/001-interaction-review-panel.md`. Same content lives on GitHub as Issue #1.

I wrote this ticket to be — machine-parseable where it matters, human where it matters. So the summary at the top is prose, it's what a product person would write. But then the `Context Packs` section is a list of named packs the harness loads. The `File Scope` is a fenced code block that the scope-guard hook reads directly with picomatch. No LLM parsing — it's a regex. That was deliberate. The brief says *"too prescriptive and you've written the code yourself; too vague and the agent hallucinates."* My line is: the human decomposes at the epic level, the agent refines at the file level. The human ticket author knows the product intent. The agent knows the codebase structure. That's the split.

The acceptance criteria — I tried to make as many of these machine-checkable as possible. Like AC2 through AC6 — every visual state has to have a specific `data-testid="state-<name>"` attribute. That turns "does the component show the right thing for critical interactions" — which is a judgment call — into a grep. Same for AC9: no hardcoded URLs in the component file. That's another grep. The test-count requirement in AC11 — also countable. The reviewer subagent still does the judgment-heavy ones, but I wanted to cut down on the surface area it has to reason about.

And the Sub-Tasks section is a directed acyclic graph. Each task has an explicit `depends: [ST2]` or whatever. Which means the planner can validate there are no cycles.

The budgets at the bottom — `maxTurns: 40`, `maxCostUSD: 3.00`, `maxWallSeconds: 600` — those are the escalation triggers. If any of those goes over, the PR opens as a draft.

OK — so how does the harness consume this.

---

## 3 · Pipeline architecture (≈ 4:30)

This is `DESIGN.md`. The mermaid diagram at the top of section 2 is the seven stages. Let me walk through them quickly.

Stage 1 is the parser — pure regex, zero LLM calls. I have nine unit tests on that parser that run in milliseconds.

Stage 2 is the planner. Right now it's a stub — it just echoes the ticket's own DAG back out. In a future phase a planner subagent refines it, but for this exercise the human-authored DAG is good enough, and I didn't want to pay for a planner call I didn't need yet.

Stage 3 is context assembly. This is one of the places the brief asks hard questions about. "How do you prevent context window blowup." My answer is: three layers. Layer A is hand-written context packs — there are five of them in `context-packs/medplum/`, each covers a specific pattern (react conventions, FHIR resources, Medplum hooks, loading/error patterns, testing). Total budget is about five to ten thousand tokens. Layer B is a compiled repo map — I use ts-morph to walk the seed's source and emit a compact symbol index. And Layer C — not built yet — would be on-demand retrieval tools the agent calls when it decides it needs more context.

I deliberately did not use RAG or embeddings. For a thirty-file seed, vector search is strictly worse than curated packs. Opaque relevance, infra cost, hallucinated "related" hits. The pack is the lever.

Stage 4 is the actual agent run. This uses the Claude Agent SDK — `query()` is the entry point. I pass in `cwd`, `systemPrompt`, `allowedTools`, `mcpServers`, `hooks`, and a few other options. The agent runs inside a git worktree — that's important — so every edit is reversible, and if the run blows up, the main branch is untouched.

The hooks are where the interesting stuff happens — `src/hooks/`. There are four of them. `scopeGuard` is a PreToolUse hook that uses picomatch against the ticket's file scope — if the agent tries to write outside scope, the hook denies, and the deny reason goes back to the agent as the tool result. So the agent learns from it and retries. Same with `importAudit` — that's a ts-morph-based PreToolUse hook that parses every write the agent attempts, walks the import declarations, and makes sure every specifier resolves. Relative paths have to exist on disk, bare specifiers have to be in the seed's package.json. If the agent tries to import a package that doesn't exist, the hook catches it *before* the file is even written.

`fastGate` is a PostToolUse hook — runs prettier and eslint after every successful write. `stopProgress` is a Stop hook — it hashes `git diff HEAD` at every Stop event, and if the diff hasn't changed in two Stops, the agent is stuck, and the hook forces the agent to either move forward or verbalize what's blocking it.

Then there's the `run_gates` custom MCP tool — that's in `src/tools/`. This is where the expensive gates live — full vitest, FHIR shape checks, visual-state coverage grep. The agent is *required* to call this tool before declaring complete. The system prompt is explicit about that.

And then stage 6 is the reviewer subagent. That's a separate top-level `query()` — fresh context window, read-only tools, uses `outputFormat: { type: 'json_schema' }` to get typed structured output. It goes through each acceptance criterion and marks it met, partial, or unmet, with evidence. The reviewer can't be biased by the implementer's reasoning because it doesn't see it.

Eleven gates total. The table in section 4 walks through each one. The thing I'd point out is — the gates are wired three different ways deliberately. PreToolUse hooks block bad actions. PostToolUse hooks verify after a write. The run_gates MCP tool runs once against final state. The reviewer is a completely separate query. Different failure modes want different mechanisms.

OK — let's watch one run.

---

## 4 · Gates in action (≈ 3:30)

So I'm going to run the replay command — `npm run harness:replay -- demo-runs/golden-success`. This re-renders a captured run's JSONL events. It does not spend tokens. There's no API call. I'm just replaying what happened.

There's the run-start event. Context loaded — you can see the five packs, the repo map. Then the agent's tool calls start streaming. Every Write, every Edit, every Bash command. And each one is evaluated by the hooks before it applies.

*[If there are hook.deny events: point to one.]* See this hook.deny — that's the scope-guard or the import-audit catching something. If that's scope-guard, the agent asked to edit a file outside the ticket scope, the hook said no, and the deny reason went back to the agent as the tool result. Which means the agent *knows* why it was denied and self-corrects on the next turn.

Then the agent calls `run_gates`. This is the expensive-gate MCP tool. It runs tsc, full vitest, FHIR shape, API contract check, visual-state coverage — all in about ten seconds. Returns a structured pass/fail report. If anything fails, the agent iterates.

And then the reviewer runs at the end. Here's the verdict JSON. You can see the per-AC breakdown — each criterion is `met` or `partial` or `unmet` with evidence. On this run — approved.

Okay — PR opens. Let me show you what it built, live.

---

## 5 · Live portal demo (≈ 3:00)

This is running at localhost 5181. It's the completed `InteractionReviewPanel` mounted inside a real Medplum `AppShell` — that's Medplum's own portal chrome. The logo, the search bar, the navbar — those are Medplum's React components. The profile in the top right is the default MockClient profile, Alice Smith. The PatientHeader below — that's Medplum's `PatientHeader` component — showing Eleanor Voss, DOB, age 67, female.

These two cards — Active medications and Allergies — are pulling data through `useSearchResources`. That's Medplum's own hook. It goes through `MedplumProvider`, which is wired to `MockClient` in main.tsx. So what you're seeing is real data flow — the resources were seeded into MockClient in `App.tsx`'s useEffect, and they come back through the SDK into these tables. This is legitimate Medplum integration.

*[One caveat worth mentioning openly:]* I'll say — I found that MockClient v4.5.2's search filters don't actually apply in-memory, which is a Medplum SDK quirk, not a harness thing. So in the tables I do an unfiltered search and filter client-side. Against a real Medplum server the filtered form would work. I documented it in the findings doc.

Down here is the draft order — Aspirin 81mg, a classic warfarin-plus-aspirin bleeding-risk scenario. I'm going to click Review interactions.

*[Wait for the loader, ~850ms.]*

There it is. Critical interactions detected — that's the state-critical visual state. Below that, two alerts — the HIGH severity warfarin-aspirin bleeding risk, and the MODERATE metoprolol-aspirin blood pressure interaction. Both come back from the injected `DrugInteractionApi`. I wrote a `MockDrugInteractionApi` that implements the interface — returns hand-crafted FHIR DetectedIssue resources after an 850ms delay to exercise the loading state.

The component is telling me I need to override. Button's disabled. Let me type a rationale. *[Type.]* Now it's enabled. *[Click override.]*

There's the decision log appearing at the bottom. Time, OVERRIDE badge, issue count, the rationale I typed. That's `onOverride(issues, reason)` firing — the component's override callback.

So — every gate green, reviewer approved, component renders, data flow works. Done, right?

Not quite.

---

## 6 · The finding (≈ 2:30)

This is `docs/findings/01-app-shell-scope-gap.md`. I found this today, running the completed component in a real Medplum portal for the first time. Which I think is actually *the* interesting moment, so I want to spend time on it.

When I first mounted the harness's output in a real app shell, it threw — twice, in sequence. First: `MantineProvider was not found in component tree`. The agent used Mantine components — `Alert`, `Button`, `Textarea` — because the ticket's human notes said to. But `main.tsx` didn't wrap in MantineProvider. Second: `Cannot read properties of undefined — checkInteractions`. The component expects a `drugInteractionApi` prop. `App.tsx` didn't supply one.

Both are integration failures. Both happen in files the agent couldn't touch. And here's the important part — every gate passed anyway.

*[Point at the table.]* Look at why. G4 audits imports — every import resolves, no problem. G5 is the scope-guard — it *correctly* kept the agent out of main.tsx and App.tsx. That's the right behavior. G6 is vitest — the tests pass. They pass because the agent's tests wrap *their own* MantineProvider, instantiate *their own* mock injection. Tests run on an isolated shell the agent built for testing. G10 is visual-state coverage — grep finds all five testids in the test file. G11 is the reviewer — it reads the diff and checks each acceptance criterion. Every AC is literally satisfied in the diff. So it approves.

Every gate passed on code that cannot actually render in production. That's a real gap. And it's exactly the class of thing the brief asks about in section 3 — *"How does the harness know the ticket is done versus the agent gave up and produced something incomplete."* My answer right now is: approved by reviewer plus all gates green plus no scope denials. That's not tight enough when the shipping app shell evolves out of sync with the component.

I've got three proposed mitigations in that doc. The strongest one — I'd add a G12 render-smoke gate. A vitest integration test that actually imports the component from the shipping `main.tsx` path and mounts it with the real provider stack. Asserts no throw. That catches both failures for about two to five seconds of additional run time per gate call. The other two are a reviewer-prompt clause — so the subagent explicitly checks that every required prop is supplied in the shipping app, not just in tests — and materializing the `request_scope_expansion` tool so the agent can log "I need main.tsx edited" without being allowed to do it itself. That gives the human reviewer a signal.

One-liner — *the scope-guard kept the agent in its lane. The tests wrapped their own providers. The reviewer read the diff. Every gate passed. The feature couldn't render in prod.* That's the gap I'd close next.

---

## 7 · Close (≈ 1:00)

If I had another week on this — top of my list is that G12 gate. Then loop the reviewer back into the implementer with retry budget. Then a second ticket with a different shape — probably a non-UI backend ticket — to prove the harness isn't overfit to React components.

I documented all of this — the design, the three load-bearing decisions at the top of DESIGN section zero, the failure-mode table, the findings doc. Happy to walk through any part in more detail. Or answer questions.

*[End.]*

---

## Speaking notes

- **Pace:** ~150 words per minute, natural. The segments above are sized so each one at that pace lands near the target time. If you're running fast, slow down in segments 3 and 6 — those are the highest-signal. If running slow, tighten segment 2 and skip the "per-pack" enumeration in 3.
- **Tone:** You're explaining to a peer, not pitching. Use "I" not "we." Acknowledge limits openly — the finding, the MockClient caveat, the un-built planner. Saying "here's what I didn't build" is a senior-dev tell; hiding it reads junior.
- **Don't read the script verbatim.** Glance down, get the next beat, look back at the screen and say it your way.
- **Hands off the keyboard during explanations** — only touch keys when you're running a command, otherwise people watch the cursor instead of listening.
- **If something breaks on camera** — name it, recover, move on. *"Oh — let me restart that, one sec."* That's more credible than pretending nothing happened.

---

## Time budget quick reference

| Segment | Start | Duration |
|---|---|---|
| 1 · Framing | 00:00 | ≈ 1:30 |
| 2 · The ticket | 01:30 | ≈ 3:00 |
| 3 · Pipeline architecture | 04:30 | ≈ 4:30 |
| 4 · Gates in action | 09:00 | ≈ 3:30 |
| 5 · Live portal demo | 12:30 | ≈ 3:00 |
| 6 · The finding | 15:30 | ≈ 2:30 |
| 7 · Close | 18:00 | ≈ 1:00 |
| **Total** | | **≈ 19:00** |

Hit section 6 no later than 15:45 or cut section 7 short. Section 6 is the senior-dev differentiator.
