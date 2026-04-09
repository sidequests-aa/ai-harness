# Build InteractionReviewPanel component

## Summary

When a clinician prescribes a new medication, they need to see — at a glance — whether it
interacts dangerously with anything the patient is already taking, with allergies on file,
or with conditions in the chart. The Interaction Review Panel is the surface where that
decision happens. It shows the patient's current medication list, surfaces interaction
warnings ranked by severity, and forces an explicit acknowledge-or-override before the
prescription can be confirmed. This is the kind of friction that catches "warfarin +
aspirin" before it reaches the pharmacy.

## Context Packs

- react-conventions
- fhir-resources
- medplum-react-hooks
- loading-error-patterns
- testing-patterns

## File Scope

```scope
src/components/InteractionReviewPanel/**
src/types/drugInteractionApi.ts
```

## FHIR Resources Consumed

- `MedicationRequest` — the patient's existing prescriptions and the proposed new one
- `AllergyIntolerance` — known allergies with reaction severity
- `DetectedIssue` — interaction findings returned by the Drug Interaction API and persisted

## Dependencies to Inject

- `DrugInteractionApi` interface (new file at `src/types/drugInteractionApi.ts`)
- Must be **swappable**: tests inject a `MockDrugInteractionApi`; production swaps in a
  real provider. The component **must not** import a fixed implementation — it accepts the
  client via props or React context.

## Sub-Tasks (DAG)

- [ ] **ST1**: Define the `DrugInteractionApi` TypeScript interface in
      `src/types/drugInteractionApi.ts`. Methods: `checkInteractions(input) → Promise<DetectedIssue[]>`.
      Input includes: proposed medication, current medications, allergies, demographic factors.
      depends: `[]`
- [ ] **ST2**: Scaffold `InteractionReviewPanel.tsx` with the props contract and a visual
      skeleton. Props: patient context + `drugInteractionApi: DrugInteractionApi` + callbacks.
      depends: `[ST1]`
- [ ] **ST3**: Implement data fetching. Use `useResource` / `useSearchResources` from
      `@medplum/react` to load the patient's `MedicationRequest`s and `AllergyIntolerance`s.
      Call `drugInteractionApi.checkInteractions` to get `DetectedIssue`s.
      depends: `[ST2]`
- [ ] **ST4**: Implement all five visual states (loading, no-interactions, minor, critical,
      api-error). Each state must have its `data-testid="state-<name>"` attribute for the
      visual-state coverage gate.
      depends: `[ST3]`
- [ ] **ST5**: Implement the acknowledge / override flow. Acknowledge calls `onAcknowledge`
      with the full `DetectedIssue[]`. Override is disabled until the clinician types a
      reason of ≥10 characters; calling it submits the reason alongside the issues.
      depends: `[ST4]`
- [ ] **ST6**: Tests covering every visual state, the acknowledge path, the override path,
      and the API-error path. Use `MockClient` from `@medplum/mock` to seed FHIR resources;
      use a hand-rolled `MockDrugInteractionApi` to simulate the interaction service.
      depends: `[ST5]`

## Acceptance Criteria

- [ ] **AC1**: Component renders without throwing when given valid props
      (`MedicationRequest`s, `AllergyIntolerance`s, demographics, `DrugInteractionApi`).
- [ ] **AC2**: Element with `data-testid="state-loading"` is present while interactions are
      being fetched.
- [ ] **AC3**: Element with `data-testid="state-no-interactions"` is present when the
      `DetectedIssue` list is empty.
- [ ] **AC4**: Element with `data-testid="state-minor"` is present when at least one
      `DetectedIssue` has `severity` ≤ `moderate`.
- [ ] **AC5**: Element with `data-testid="state-critical"` is present when any
      `DetectedIssue` has `severity` `high`. Confirming a prescription in this state requires
      an explicit override (the Acknowledge button is hidden or disabled).
- [ ] **AC6**: Element with `data-testid="state-api-error"` is present when
      `drugInteractionApi.checkInteractions` rejects.
- [ ] **AC7**: Acknowledge button calls the `onAcknowledge` prop with the full
      `DetectedIssue[]`.
- [ ] **AC8**: Override button is disabled until the user has typed ≥10 characters in the
      reason field; calling it invokes `onOverride` with `(issues, reason)`.
- [ ] **AC9**: `DrugInteractionApi` is supplied via props or context — **no `import` of a
      fixed implementation**. A grep for hardcoded URLs in the component file finds none.
- [ ] **AC10**: All FHIR resource access paths are null-safe — no throw on missing optional
      fields like `medication?.coding?.[0]?.display`.
- [ ] **AC11**: There is at least one passing test per visual state (5 total) plus one each
      for acknowledge, override, and api-error (8 tests minimum).
- [ ] **AC12**: The component is exported as both a named export
      (`export function InteractionReviewPanel`) and a default export.

## Budgets

- `maxTurns`: 40
- `maxCostUSD`: 3.00
- `maxWallSeconds`: 600

## Human Notes

- Prefer `@mantine/core` UI primitives where they exist (`Alert`, `Badge`, `Button`,
  `Stack`) — they're already a transitive dependency via `@medplum/react`.
- The placeholder `InteractionReviewPanel.tsx` and its test should be replaced wholesale.
- Keep the file scope tight — do not edit `App.tsx`, `main.tsx`, or any CSS file outside
  the `src/components/InteractionReviewPanel/` directory.
