# Presentation runbook — what to show, what to click

Companion to `PRESENTATION-SCRIPT.md`. Keep both open. This file is the stage directions (what's on screen, what you type, where to point). The script is what you say.

**Target length:** 15–20 minutes. Timings below are "about when you should be here." Don't rush — if you hit the finding (section 6) with five minutes to spare, good; if you're over, drop section 7 and land clean.

**Pre-flight checklist (do this 10 min before starting):**

- [ ] Harness repo open in VS Code at `C:/Users/Alex/Projects/intrahealth/intrahealth-harness/` — `README.md`, `DESIGN.md`, `tickets/001-interaction-review-panel.md`, `src/cli.ts`, `src/hooks/scopeGuard.ts`, `docs/findings/01-app-shell-scope-gap.md` all open in tabs, in that order
- [ ] Terminal open at the harness root, cleared
- [ ] Chrome open to two tabs: `http://localhost:5181/` (the live portal) and `https://github.com/sidequests-aa/ai-harness/issues/1` (the ticket as a GitHub issue)
- [ ] Vite dev server running on :5181 — if not, run `/seed-dev --latest` in Claude Code from the harness root, wait for `Local: http://localhost:5181/` to print
- [ ] `demo-runs/golden-success/events.jsonl` exists (should — it's committed)
- [ ] Screen recorder set to record the Chrome window + VS Code; terminal visible
- [ ] Don't forget to close Slack / notifications

---

## Segment 1 — Framing (00:00 → 01:30)

**Show:** `README.md` in VS Code, scrolled to the top.

**Do:** Nothing — just leave the README visible for ~20 seconds while you do the opening. Then scroll to the "What this is" section so the 7-step pipeline is visible.

**Point at:**
- Line 1 title: "AI engineering harness"
- The 7-step numbered list under "What this is"

**Transition:** "The work order is a drug interaction checker — here's what a ticket looks like."

---

## Segment 2 — The ticket (01:30 → 04:30)

**Show:** `tickets/001-interaction-review-panel.md` in VS Code, then GitHub Issue #1 in Chrome.

**Do:**
1. In VS Code, open the ticket. Scroll slowly from top to bottom, pausing at each section header (~2–3 sec each): Summary → Context Packs → File Scope → FHIR Resources → Dependencies to Inject → Sub-Tasks DAG → Acceptance Criteria → Budgets.
2. Highlight (drag-select) the `## File Scope` fenced block. Leave it highlighted for 3 seconds.
3. Highlight the `## Acceptance Criteria` AC9 line (the "no hardcoded URLs / injected API" one) and AC11 (tests per state).
4. Alt-tab to Chrome → GitHub Issue #1. Let it render for ~2 sec.
5. Back to VS Code.

**Point at:**
- File scope — "the scope-guard uses these globs directly"
- AC2–AC6 data-testid requirements — "this is what makes G10 a grep instead of a judgment call"
- Sub-Tasks DAG with explicit `depends:` — "DAG is machine-validated"
- Budgets block — "escalation predicate lives here"

**Transition:** "Now how does the harness consume this? Pipeline view."

---

## Segment 3 — Harness architecture (04:30 → 09:00)

**Show:** `DESIGN.md` in VS Code, scrolled to §2.1 Pipeline overview (the mermaid diagram).

**Do:**
1. If the mermaid renders in VS Code's preview, open the preview pane (Ctrl+Shift+V). Otherwise leave it as source.
2. Scroll down to §2.2 Stages table. Let the full table be visible.
3. Open `src/cli.ts` in a new tab. Scroll to the main `run()` function. The 7 stages are literal function calls in order. Highlight each call as you mention it.
4. Open `src/hooks/scopeGuard.ts`. Let the top of the file be visible — the `picomatch` import and the `denyReason` construction.
5. Open `src/tools/runGates.ts` briefly — show the MCP tool registration at the top.
6. Close those files, keep DESIGN.md visible.

**Point at:**
- The mermaid diagram's hook lane (PreToolUse, PostToolUse, Stop)
- `§2.3` key SDK primitives list — specifically `tool()`, `HookCallback`, `outputFormat`
- `§4.3` three different gate wiring strategies — this is the load-bearing table

**Transition:** "So let's see one run actually happen — except we've already run it, and we can replay it without spending any tokens."

---

## Segment 4 — Gates in action via replay (09:00 → 12:30)

**Show:** Terminal at the harness root.

**Do:**
1. Type the replay command character-by-character so graders see it:
   ```
   npm run harness:replay -- demo-runs/golden-success
   ```
2. Press Enter. The replay scrolls — don't try to read every line. Let it run for ~10 seconds, then press Ctrl+C if it gets too long.
3. Run the summary form:
   ```
   npm run harness:replay -- demo-runs/golden-success --summary
   ```
4. This prints one line per event. Scroll through. Point at:
   - `context.loaded` events — "Layer A packs + Layer B repo map"
   - any `hook.deny` events, if present — "the agent tried something out of scope, the hook said no, the deny reason went back as the tool result"
   - `gate.result` event — the 11-gate table
   - `reviewer.verdict` — approved with per-AC breakdown
   - `run.end` — pr-opened outcome

5. Open `demo-runs/golden-success/reviewer-verdict.json` in VS Code briefly — show the structured output (criterionResults array with `met`/`partial`/`unmet` per AC).

**Point at:**
- The JSONL schema discriminated union
- The `hook.deny` event if present (if not, say "we get lucky on this run — no denials — but the cycle still works; I can show a failing run if you want")

**Transition:** "OK so that's the harness building a PR. Let me show you what it actually built, running in a Medplum portal."

---

## Segment 5 — Live portal demo (12:30 → 15:30)

**Show:** Chrome, `http://localhost:5181/`.

**Do:**
1. Alt-tab to Chrome. The portal should already be loaded (refresh if it's been sitting).
2. Let the viewer see the full layout for ~3 seconds: Medplum logo + search + Alice Smith in the top bar; Eleanor Voss PatientHeader below; Active Medications card (Warfarin, Metoprolol, Atorvastatin); Allergies card (Penicillin V · HIGH); yellow Draft Order card.
3. Hover the Active medications card header. Say: "These three meds came in through `useSearchResources` — that's Medplum's SDK hook, pulling from MockClient, wired through MedplumProvider. This is the real data path."
4. Click **Review interactions →** (big button on the yellow card).
5. The panel expands below. You'll see: brief loader (~850ms), then "Critical interactions detected" red banner, then two alert cards (HIGH warfarin×aspirin, MODERATE metoprolol×aspirin), then an Override Reason textbox.
6. Click in the Override Reason field. Type: `Patient has mechanical aortic valve, combination is clinically necessary, will monitor INR weekly.` — about 100 characters.
7. The **Override and Prescribe** button un-disables.
8. Click it. A "Decision log" section appears at the bottom with one row: time / OVERRIDE badge / 2 issues / your rationale.
9. Scroll down to show the log row.

**Point at:**
- Patient data in the cards — "that's through Medplum's SDK"
- The HIGH badge — "this drives `state-critical` per AC5"
- The disabled Override button before typing — "AC8: disabled until ≥10 chars"
- The audit log row — "onOverride(issues, reason) fired, we captured it"

**Transition:** "So every gate passed, the reviewer approved, the component renders, the flow works. Here's what the harness didn't catch."

---

## Segment 6 — The finding (15:30 → 18:00)

**Show:** `docs/findings/01-app-shell-scope-gap.md` in VS Code.

**Do:**
1. Open the file. Scroll slowly through the "What was observed" table (two rows: MantineProvider + drugInteractionApi).
2. Scroll to "The trace" numbered list. Read items 1–5 aloud if time allows, otherwise summarize.
3. Scroll to "Why each gate slipped" table. This is the money table — highlight the G6, G10, G11 rows.
4. Scroll to "Mitigations" → "1 · A G12 render-smoke gate". Read the code example.
5. Scroll to the one-line takeaway at the bottom. Let it sit on screen for ~3 seconds.

**Point at:**
- "Why each gate slipped" table — especially G11: "reviewer read the diff. Diff satisfies every AC literally. Approved."
- G12 code snippet — "this would have caught both failures for ~2–5s of run time"
- `request_scope_expansion` section — "the deny reason already mentions the tool; we just haven't materialized it"

**Transition:** "And that's the honest state of the project."

---

## Segment 7 — Close (18:00 → end)

**Show:** Back to `README.md` or `DESIGN.md` §9 ("What I'd do next").

**Do:** One screen — don't switch anything. Look at camera if possible.

**Optional prop:** Mention the findings doc as the thing graders can read to see how I'd evolve this if given more time.

---

## If anything breaks during the demo

| Break | Recovery |
|---|---|
| Vite server died | `/seed-dev --latest` in Claude — wait 2s — refresh Chrome |
| Chrome shows a different port's app ("AGES ECG" etc.) | Verify the URL is `:5181`, not `:5173`. Hard-refresh (Ctrl+Shift+R). |
| `npm run harness:replay` hangs or errors | The replay is against committed data; if it breaks, fall back to opening `demo-runs/golden-success/transcript.md` directly in VS Code |
| You lose your place in the script | The section headers here match the script exactly — find the segment number, pick up from there |
| Live `/harness-run` flaked (if you do try a live run) | Drop the live run, say "I've got a captured run instead" and replay — don't try to debug on camera |

## Things to NOT do

- Don't open the "chartroom" demo shell or any Fraunces / Vercel version — those are dead ends. The only demo is `:5181` in its current Medplum portal state.
- Don't try to live-run the harness (`/harness-run`) unless you have 5+ minutes of buffer — it's fine when it works, but live API calls against Claude can rate-limit and you'd be mid-presentation troubleshooting.
- Don't explain FHIR. If asked, "It's the healthcare data standard, the brief says I don't need to be an expert."
- Don't oversell. When you hit the finding, lean *into* it. That's the senior-dev tell.
