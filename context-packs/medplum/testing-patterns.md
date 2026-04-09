# Testing Patterns — vitest + @testing-library/react + @medplum/mock

The seed uses **vitest** as its test runner with **jsdom** for the DOM
environment. Component tests live colocated with the implementation
(`<Component>.test.tsx`), not in a separate `__tests__/` directory.

## What's already set up — DON'T touch

`seed/vitest.setup.ts` already does the following. Do **not** modify it
from a ticket — the file is outside the InteractionReviewPanel scope:

- Imports `@testing-library/jest-dom/vitest` (so matchers like
  `.toBeInTheDocument()` work)
- Polyfills `window.matchMedia` for Mantine (jsdom doesn't implement it,
  and Mantine reads matchMedia at render time — without the polyfill any
  test that mounts a Mantine component throws)
- Auto-cleans the rendered DOM between tests via `cleanup()` in `afterEach`

The polyfill matters: every Mantine `<Alert>`, `<Button>`, `<Stack>` will
crash without it. **You don't need to add it** — it's already there.

## Test file shape

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MedplumProvider } from '@medplum/react';
import { MockClient } from '@medplum/mock';
import { MantineProvider } from '@mantine/core';
import { InteractionReviewPanel } from './InteractionReviewPanel';
import type { DrugInteractionApi } from '../../types/drugInteractionApi';

function renderPanel(overrides: Partial<Parameters<typeof InteractionReviewPanel>[0]> = {}) {
  const medplum = new MockClient();
  const drugInteractionApi: DrugInteractionApi = {
    checkInteractions: vi.fn().mockResolvedValue([]),
  };
  return render(
    <MantineProvider>
      <MedplumProvider medplum={medplum}>
        <InteractionReviewPanel
          patientId="test-patient"
          drugInteractionApi={drugInteractionApi}
          onAcknowledge={vi.fn()}
          onOverride={vi.fn()}
          {...overrides}
        />
      </MedplumProvider>
    </MantineProvider>,
  );
}

describe('InteractionReviewPanel', () => {
  // tests below
});
```

The `renderPanel` helper is the heart of the test file: every test starts
from a fresh `MockClient` and a fresh `vi.fn()` for the API. Don't share
state between tests.

## Seeding FHIR data on the MockClient

`MockClient` stores resources in memory. Create them with `createResource`
*before* rendering:

```tsx
it('renders state-no-interactions when there are no detected issues', async () => {
  const medplum = new MockClient();
  await medplum.createResource<MedicationRequest>({
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/test-patient' },
    medicationCodeableConcept: { text: 'warfarin 5mg' },
  });

  // ... render with this MockClient and assert state-no-interactions
});
```

For tests that don't need real FHIR data (most of them), an empty
`MockClient` is fine — `useSearchResources` will resolve with `[]`.

## Testing async data fetching

The component fetches medications, then calls the drug-interaction API.
Tests need to wait for both to settle before asserting. Use
`findByTestId` (which retries) instead of `getByTestId`:

```tsx
it('renders state-critical when severity high', async () => {
  const drugInteractionApi: DrugInteractionApi = {
    checkInteractions: vi.fn().mockResolvedValue([
      { resourceType: 'DetectedIssue', status: 'final', severity: 'high', detail: 'aspirin + warfarin' },
    ]),
  };
  renderPanel({ drugInteractionApi });

  expect(await screen.findByTestId('state-critical')).toBeInTheDocument();
});
```

`findByTestId` polls every 50ms for up to 1 second. Plenty of time for an
in-memory `MockClient` + a resolved `vi.fn()`.

## Testing the API-error state

```tsx
it('renders state-api-error when checkInteractions rejects', async () => {
  const drugInteractionApi: DrugInteractionApi = {
    checkInteractions: vi.fn().mockRejectedValue(new Error('upstream 500')),
  };
  renderPanel({ drugInteractionApi });

  expect(await screen.findByTestId('state-api-error')).toBeInTheDocument();
});
```

Don't `console.error.mockImplementation` to silence the error log — let
React print it. It's expected for an error state test.

## Testing acknowledge / override

`userEvent` (not `fireEvent`) for clicks and typing — it dispatches the
full sequence of events a real user would, which catches things like
`input → change → blur` order bugs:

```tsx
it('disables override until reason has 10+ chars', async () => {
  const user = userEvent.setup();
  // ... render with critical issues
  const overrideBtn = await screen.findByRole('button', { name: /override/i });
  expect(overrideBtn).toBeDisabled();

  const reason = screen.getByRole('textbox', { name: /reason/i });
  await user.type(reason, 'too short');
  expect(overrideBtn).toBeDisabled();

  await user.type(reason, ' but now long enough');
  expect(overrideBtn).toBeEnabled();
});
```

## Required test coverage (the harness checks)

The visual-state coverage gate requires at least one test that asserts
each `data-testid` is present. The required testids are:
`state-loading`, `state-no-interactions`, `state-minor`, `state-critical`,
`state-api-error`. **All five.** Plus tests for acknowledge and override
(at least one each).

## Gotchas

- **Always wrap in `<MantineProvider>` AND `<MedplumProvider>`.** Mantine
  components throw without a Mantine context; Medplum hooks throw without
  a Medplum context. Both are needed.
- **`vi.fn().mockResolvedValue(value)` returns a `Promise<value>`** — that
  matches the `DrugInteractionApi.checkInteractions` signature. Use
  `mockRejectedValue` for the error path.
- **Tests must be async** when they use `findBy*` queries. The
  `findByTestId` returns a Promise; awaiting it is mandatory.
- **Don't import `screen` from `@testing-library/dom`** — use the one from
  `@testing-library/react`. They're functionally identical but the dom one
  isn't a direct dep, only transitive, and your editor may auto-import the
  wrong path.
- **Don't add a `__tests__/` directory.** Colocated `*.test.tsx` only.
