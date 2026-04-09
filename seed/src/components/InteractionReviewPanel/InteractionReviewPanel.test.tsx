import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InteractionReviewPanel } from './InteractionReviewPanel';

describe('InteractionReviewPanel — failing baseline', () => {
  // This test exists so that `npm test` shows a failing baseline before the
  // harness runs. After the harness builds the real component, this file is
  // replaced by the agent with the full visual-state coverage suite (per
  // Acceptance Criteria AC2-AC6 in Issue #1).
  it('renders without throwing (will fail until the harness implements the component)', () => {
    expect(() => render(<InteractionReviewPanel />)).not.toThrow();
  });
});
