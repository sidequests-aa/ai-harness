# Loading / Error / Empty States

Every UI ticket in this seed expects components to render distinct,
testable visual states. The harness enforces this via the
`visual-state coverage` quality gate, which greps test files for
`data-testid="state-<name>"` tokens.

## The data-testid convention

Each visual state has a stable, lowercased, dash-separated ID:

| State | `data-testid` |
|---|---|
| Loading | `state-loading` |
| No interactions found | `state-no-interactions` |
| Minor interactions only | `state-minor` |
| Critical interaction(s) present | `state-critical` |
| API call failed | `state-api-error` |

Place the testid on the **outermost element** of each visual state, so
tests can `getByTestId('state-critical')` and assert on it without
worrying about which child renders inside.

```tsx
if (apiError) {
  return (
    <Alert
      data-testid="state-api-error"
      color="red"
      title="Could not check interactions"
    >
      {apiError.message}
    </Alert>
  );
}
```

## Order of state checks

Render branches in this order — earliest match wins:

1. `loading` — fetch in flight
2. `api-error` — interaction API rejected (drug-interaction call, not the
   FHIR client)
3. `no-interactions` — fetched OK, zero `DetectedIssue` results
4. `critical` — at least one `DetectedIssue` with `severity === 'high'`
5. `minor` — fetched OK, has issues, none `'high'`

This order matters: a critical interaction during loading should show
*loading*, not *critical*. Don't conflate the dimensions.

## Mantine primitives by state

| State | Recommended primitive |
|---|---|
| Loading | `<Skeleton visible />` or `<Loader />` inside a `<Center>` |
| No interactions | `<Alert color="green" title="No interactions found" />` |
| Minor | `<Alert color="yellow" title="Minor interactions">…</Alert>` |
| Critical | `<Alert color="red" variant="filled" title="Critical interactions">…</Alert>` |
| API error | `<Alert color="red" title="Could not check">{error.message}</Alert>` |

For the critical state, the *filled* variant draws the eye — that's the
whole point of a high-severity warning.

## Loading the data

The "loading" state covers the time between mount and first response from
the **drug interaction API**, not just the FHIR fetches. The cleanest
implementation is a single `useEffect` that:

1. Reads the `MedicationRequest`s and `AllergyIntolerance`s via Medplum hooks
2. Once both are loaded, calls `drugInteractionApi.checkInteractions(...)`
3. Stores the result (success or error) in local state

While any of those are pending, render the `state-loading` element.

```tsx
const [issues, setIssues] = useState<DetectedIssue[] | undefined>(undefined);
const [apiError, setApiError] = useState<Error | undefined>(undefined);

const [meds, medsLoading] = useSearchResources<MedicationRequest>(...);
const [allergies, allergiesLoading] = useSearchResources<AllergyIntolerance>(...);

useEffect(() => {
  if (medsLoading || allergiesLoading) return;
  let cancelled = false;
  drugInteractionApi
    .checkInteractions({ proposedMedication, currentMedications: meds ?? [], allergies: allergies ?? [] })
    .then((res) => { if (!cancelled) { setIssues(res); setApiError(undefined); } })
    .catch((err) => { if (!cancelled) setApiError(err); });
  return () => { cancelled = true; };
}, [medsLoading, allergiesLoading, meds, allergies, drugInteractionApi, proposedMedication]);

const loading = medsLoading || allergiesLoading || (issues === undefined && apiError === undefined);
```

## Gotchas

- **Don't show `loading` and the result simultaneously.** A brief "no
  interactions yet" flash before the API resolves is a regression.
- **`apiError` is for the drug-interaction call only**, not for failed FHIR
  reads. The `useResource`/`useSearchResources` hooks don't surface their
  errors via this hook — see `medplum-react-hooks.md`.
- **The empty-list check is `length === 0`, not `!issues`.** `issues` may
  be `[]` after a successful call — that's the no-interactions case, not
  loading.
