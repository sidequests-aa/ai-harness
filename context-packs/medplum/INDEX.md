# Context Packs — Medplum / React Seed

These are hand-authored markdown bundles. The harness loads them into the
implementer agent's `systemPrompt` based on which packs the ticket opts into
(`## Context Packs` section). Each pack is the answer to *"what would you
write down for a new hire on day 1 of working in this codebase?"* — not a
catch-all reference, just the load-bearing patterns.

## Pack inventory

| Pack | When to load | Approx tokens |
|---|---|---|
| `react-conventions` | Any ticket that creates or edits React components | ~600 |
| `fhir-resources` | Any ticket that touches `MedicationRequest`, `AllergyIntolerance`, or `DetectedIssue` | ~900 |
| `medplum-react-hooks` | Tickets that fetch FHIR data via `@medplum/react` hooks | ~700 |
| `loading-error-patterns` | UI tickets where loading/error/empty visual states matter | ~600 |
| `testing-patterns` | Any ticket with a test requirement (effectively all of them) | ~800 |

Total when all packs load: ~3.6k tokens. Well under any soft cache cap.

## Why packs and not RAG

Curated text beats vector retrieval at this scale: it is debuggable
(graders can `cat` it), deterministic (same input → same context), and the
five packs above were chosen because each covers a different *kind* of
recurring decision the agent has to make. We are not trying to flood the
agent with the seed's source — that is what the **repo map** (separate, also
injected eagerly) is for.

## Authoring rules (if you add a new pack)

1. Lead with one or two **bad → good** code snippets specific to this seed.
2. Avoid generic React advice the model already knows.
3. Use the seed's actual file paths so `Grep` and `Read` calls land directly.
4. End each pack with a **gotchas** section — the things that bit the last
   attempt and would otherwise burn agent turns.
