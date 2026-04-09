# React Conventions — `seed/`

## File / folder layout

```
seed/src/
├── components/<ComponentName>/
│   ├── <ComponentName>.tsx          ← implementation
│   ├── <ComponentName>.test.tsx     ← colocated test (NOT __tests__/)
│   └── index.ts                     ← named + default re-exports
├── types/<domainObject>.ts          ← shared TS interfaces (no React)
└── App.tsx, main.tsx                ← demo wiring (do NOT touch from a ticket)
```

Every component lives in its **own folder** with at least three files:
implementation, test, and an `index.ts` re-export. The re-export is both a
named export and a default export — many imports use the default form
(`import X from '...'`), and many use the named form
(`import { X } from '...'`); supporting both is non-negotiable.

## Component signature

Functional components, no `React.FC`. Props are an explicit interface
declared above the function. Destructure props in the parameter list.

```tsx
// ❌ avoid
const InteractionReviewPanel: React.FC<Props> = (props) => { ... };

// ✅ prefer
export interface InteractionReviewPanelProps {
  drugInteractionApi: DrugInteractionApi;
  patientId: string;
  onAcknowledge: (issues: DetectedIssue[]) => void;
  onOverride: (issues: DetectedIssue[], reason: string) => void;
}

export function InteractionReviewPanel(props: InteractionReviewPanelProps) {
  const { drugInteractionApi, patientId, onAcknowledge, onOverride } = props;
  // ...
}

export default InteractionReviewPanel;
```

## Hook order

Inside a component body, hooks appear in this order (it makes the file
scannable and matches eslint-plugin-react-hooks's expectations):

1. `useMedplum()` and other Medplum hooks (`useResource`, `useSearchResources`)
2. `useState` for local UI state
3. `useMemo` / `useCallback` for derived values and stable refs
4. `useEffect` for side effects (data fetching from injected APIs, subscriptions)
5. Conditional early returns (`if (loading) return ...`) **after** all hooks

Never put a hook inside a conditional or early-return — React will throw
"rendered fewer hooks than expected" on subsequent renders.

## Dependency injection

Anything that talks to an external service (a REST API, an external SDK,
the network) is **injected via props or React context**, never imported
directly into the component module. The component must be testable with a
mock implementation. Example:

```tsx
// ❌ avoid — unmockable, hardcoded URL, not swappable
import { realDrugInteractionApi } from '../../services/realDrugInteractionApi';

// ✅ prefer — swappable, mock-friendly
export function InteractionReviewPanel({
  drugInteractionApi,
  // ...
}: InteractionReviewPanelProps) {
  // ...
}
```

## Mantine UI primitives

`@mantine/core` is already a transitive dependency (via `@medplum/react`).
Prefer Mantine primitives over hand-rolled markup so the visual language
matches the rest of the seed:

| Need | Use |
|---|---|
| Vertical stack of children | `<Stack>` |
| Horizontal row | `<Group>` |
| Severity-coloured banner | `<Alert color="red\|yellow\|gray" title="..."/>` |
| Status pill | `<Badge color="..." variant="light"/>` |
| Action | `<Button>` |
| Free-text input | `<Textarea>` / `<TextInput>` |
| Loading skeleton | `<Skeleton visible/>` |

Import them from `@mantine/core` directly (NOT through `@medplum/react`).

## Gotchas

- **Do NOT use React.FC.** It implicitly types children and conflicts with
  the seed's eslint config.
- **Do NOT add new top-level exports to `App.tsx` or `main.tsx`.** Those
  files are demo wiring — the harness ticket scope explicitly excludes them.
- **Do NOT introduce a router.** The seed has no `react-router` dependency.
  Single-page demo by design.
- **The `index.ts` must export both named and default.** Use the form
  `export { ComponentName, default } from './ComponentName';` — re-exporting
  the default with the same name is the gotcha that burns agents most.
