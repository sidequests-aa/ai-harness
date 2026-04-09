# `@medplum/react` Hooks — Data Fetching Patterns

The seed wires `MedplumProvider` with a `MockClient` in `src/main.tsx`. From
inside any descendant component you can use the hooks below.

## `useMedplum()` — get the client

```tsx
import { useMedplum } from '@medplum/react';

function MyComponent() {
  const medplum = useMedplum();
  // medplum is a MedplumClient (real or mock).
  // Use it for imperative calls: medplum.searchResources, medplum.readResource, etc.
}
```

Use this when you need to call the client imperatively inside an effect or
event handler. Don't use it for declarative fetching — use `useResource` or
`useSearchResources` for that.

## `useResource()` — read a single FHIR resource

```tsx
import { useResource } from '@medplum/react';
import type { Patient } from '@medplum/fhirtypes';

function PatientHeader({ patientId }: { patientId: string }) {
  const patient = useResource<Patient>({ reference: `Patient/${patientId}` });

  if (!patient) return <Skeleton visible />;
  return <h1>{patient.name?.[0]?.family}</h1>;
}
```

- Returns `undefined` while loading, then the resource.
- Errors are not exposed via this hook — wrap the component in an
  ErrorBoundary or use `useMedplum()` + an effect if you need explicit error
  state.
- Pass the reference as a `Reference` object (`{ reference: 'Type/id' }`),
  not a raw string.

## `useSearchResources()` — read multiple resources

```tsx
import { useSearchResources } from '@medplum/react';
import type { MedicationRequest } from '@medplum/fhirtypes';

function CurrentMedications({ patientId }: { patientId: string }) {
  const [meds, loading] = useSearchResources<MedicationRequest>(
    'MedicationRequest',
    { patient: `Patient/${patientId}`, status: 'active' },
  );

  if (loading) return <Skeleton visible data-testid="state-loading" />;
  if (!meds || meds.length === 0) return <Text>None on file</Text>;

  return (
    <Stack>
      {meds.map((m) => <MedRow key={m.id} med={m} />)}
    </Stack>
  );
}
```

- Tuple return: `[results, loading, error]`. Always destructure the
  `loading` flag — that's how you render the `state-loading` testid.
- Search params are FHIR search params, not arbitrary REST query strings.
  Reference fields take a `'Type/id'` string.
- Returns `undefined` initially, then the array. Default to `[]` if you
  need to iterate before the first response.

## Imperative calls via `useMedplum()`

For a one-off call inside an effect — for example, to call an injected API
that needs the patient's allergies — combine the client with `useEffect`:

```tsx
const medplum = useMedplum();
const [allergies, setAllergies] = useState<AllergyIntolerance[]>([]);

useEffect(() => {
  let cancelled = false;
  medplum.searchResources('AllergyIntolerance', { patient: `Patient/${patientId}` })
    .then((results) => {
      if (!cancelled) setAllergies(results);
    });
  return () => { cancelled = true; };
}, [medplum, patientId]);
```

The `cancelled` flag prevents the "set state on unmounted component" warning
under React 19's StrictMode (which double-mounts in dev).

## Choosing the right hook

| You want | Use |
|---|---|
| One resource, by id | `useResource` |
| A search query, declarative | `useSearchResources` |
| To call an injected (non-Medplum) API | `useMedplum()` is irrelevant; call the injected API in `useEffect` |
| To fire an action when the user clicks | `useMedplum()` inside an event handler |

## Gotchas

- **`useResource` returns `undefined`, not `null`, while loading.** Check
  `!resource`, not `resource === null`.
- **`useSearchResources` is tuple-returning.** Don't try to destructure as
  an object. The first element is the array, the second is the loading flag.
- **Pass references as objects to `useResource`**, not strings — the type
  signature accepts both but the string form is deprecated and triggers a
  console warning that pollutes test output.
- **The seed's `MockClient` does not auto-populate FHIR data.** If a test
  needs a patient with active medications, the test must `createResource`
  them on the MockClient before rendering. See `testing-patterns.md`.
