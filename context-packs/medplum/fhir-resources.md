# FHIR Resources — `MedicationRequest`, `AllergyIntolerance`, `DetectedIssue`

The seed imports types from `@medplum/fhirtypes`. Always import the resource
type rather than redeclaring it:

```ts
import type { MedicationRequest, AllergyIntolerance, DetectedIssue } from '@medplum/fhirtypes';
```

## `MedicationRequest`

The patient's prescriptions — the ones already on file and the proposed
new one. Fields the InteractionReviewPanel cares about:

```ts
interface MedicationRequest {
  resourceType: 'MedicationRequest';
  id?: string;
  status?: 'active' | 'on-hold' | 'cancelled' | 'completed' | 'entered-in-error' | 'stopped' | 'draft' | 'unknown';
  intent?: 'proposal' | 'plan' | 'order' | 'original-order' | 'reflex-order' | 'filler-order' | 'instance-order' | 'option';
  subject: { reference: string }; // 'Patient/<id>'

  // The medication itself — one of these two will be populated:
  medicationCodeableConcept?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  medicationReference?: { reference: string };

  // Dosage instructions
  dosageInstruction?: Array<{
    text?: string;
    timing?: { repeat?: { frequency?: number; period?: number; periodUnit?: string } };
    doseAndRate?: Array<{ doseQuantity?: { value?: number; unit?: string } }>;
  }>;
}
```

**Display name pattern** — *always* be null-safe; the agent's most common
crash is calling `.display` on undefined:

```tsx
const name =
  med.medicationCodeableConcept?.coding?.[0]?.display ??
  med.medicationCodeableConcept?.text ??
  med.medicationReference?.reference ??
  'Unknown medication';
```

## `AllergyIntolerance`

The patient's known allergies and reactions. Severity is a per-reaction
field, not a top-level field — be careful.

```ts
interface AllergyIntolerance {
  resourceType: 'AllergyIntolerance';
  id?: string;
  patient: { reference: string };
  code?: { coding?: Array<{ display?: string }>; text?: string };
  criticality?: 'low' | 'high' | 'unable-to-assess';
  reaction?: Array<{
    manifestation?: Array<{ coding?: Array<{ display?: string }>; text?: string }>;
    severity?: 'mild' | 'moderate' | 'severe';
  }>;
}
```

For the InteractionReviewPanel, treat `criticality === 'high'` as a strong
signal that an interaction with the proposed med is likely critical.

## `DetectedIssue`

The result of a drug-interaction check. The Drug Interaction API returns
an array of these.

```ts
interface DetectedIssue {
  resourceType: 'DetectedIssue';
  id?: string;
  status: 'preliminary' | 'final' | 'entered-in-error' | 'mitigated';

  // Severity drives which visual state we render — see mapping below.
  severity?: 'high' | 'moderate' | 'low';

  code?: { coding?: Array<{ display?: string }>; text?: string };

  // Human-readable description of the issue
  detail?: string;

  // The medications involved in the interaction
  implicated?: Array<{ reference: string; display?: string }>;

  // Recommended action(s)
  mitigation?: Array<{
    action?: { coding?: Array<{ display?: string }>; text?: string };
    date?: string;
    author?: { reference: string };
  }>;
}
```

## Severity → visual state mapping

The InteractionReviewPanel must surface five visual states (loading,
no-interactions, minor, critical, api-error). For the two interaction
states the rule is:

| Detected severity | Visual state | `data-testid` |
|---|---|---|
| any `DetectedIssue` with `severity === 'high'` | critical | `state-critical` |
| at least one issue, none `'high'` | minor | `state-minor` |
| no issues at all | no-interactions | `state-no-interactions` |

In short: **`high` always wins.** Iterate the list once, set a flag if any
high is found, render `state-critical`. Otherwise if length > 0, render
`state-minor`. Otherwise `state-no-interactions`.

## Gotchas

- `DetectedIssue.severity` is **optional** — treat missing as `low`.
- `DetectedIssue.detail` is a free-text string, not a CodeableConcept. Render
  it directly.
- `medicationCodeableConcept` *or* `medicationReference` — never both, and
  one may be missing on draft prescriptions. Default to a sensible fallback.
- Don't generate `DetectedIssue` resources locally — they come from the
  injected `DrugInteractionApi`. Your job is to render them.
- The FHIR R4 spec lists severity as `'high' | 'moderate' | 'low'`. Anything
  else returned by the API should be treated as `'low'`.
