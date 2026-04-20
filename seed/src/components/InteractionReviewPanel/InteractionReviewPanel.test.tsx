import { MantineProvider } from '@mantine/core';
import { MedplumProvider } from '@medplum/react';
import { MockClient } from '@medplum/mock';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DetectedIssue, MedicationRequest } from '@medplum/fhirtypes';
import { describe, expect, it, vi } from 'vitest';
import { InteractionReviewPanel } from './InteractionReviewPanel';
import type { DrugInteractionApi } from '../../types/drugInteractionApi';

function renderPanel(overrides: Partial<React.ComponentProps<typeof InteractionReviewPanel>> = {}) {
  const medplum = new MockClient();
  const drugInteractionApi: DrugInteractionApi = {
    checkInteractions: vi.fn().mockResolvedValue([]),
  };

  const defaultProps = {
    patientId: 'test-patient',
    proposedMedication: {
      resourceType: 'MedicationRequest' as const,
      status: 'draft' as const,
      intent: 'order' as const,
      subject: { reference: 'Patient/test-patient' },
      medicationCodeableConcept: { text: 'New medication' },
    } as MedicationRequest,
    drugInteractionApi,
    onAcknowledge: vi.fn(),
    onOverride: vi.fn(),
    ...overrides,
  };

  return {
    ...render(
      <MantineProvider>
        <MedplumProvider medplum={medplum}>
          <InteractionReviewPanel {...defaultProps} />
        </MedplumProvider>
      </MantineProvider>,
    ),
    medplum,
    drugInteractionApi,
    onAcknowledge: defaultProps.onAcknowledge,
    onOverride: defaultProps.onOverride,
  };
}

describe('InteractionReviewPanel', () => {
  describe('state-loading', () => {
    it('renders state-loading while interactions are being fetched', async () => {
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn(
          () =>
            new Promise(() => {
              /* never resolves */
            }),
        ),
      };

      renderPanel({ drugInteractionApi });

      const loadingElement = await screen.findByTestId('state-loading');
      expect(loadingElement).toBeInTheDocument();
    });
  });

  describe('state-no-interactions', () => {
    it('renders state-no-interactions when there are no detected issues', async () => {
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue([]),
      };

      renderPanel({ drugInteractionApi });

      const noInteractionsElement = await screen.findByTestId('state-no-interactions');
      expect(noInteractionsElement).toBeInTheDocument();
      expect(noInteractionsElement).toHaveTextContent('No interactions found');
    });

    it('displays message about no interactions', async () => {
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue([]),
      };

      renderPanel({ drugInteractionApi });

      expect(
        await screen.findByText(
          "This medication does not interact with the patient's current medications or allergies.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe('state-minor', () => {
    it('renders state-minor when there are non-critical issues', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'moderate',
          code: {
            coding: [
              {
                display: 'Potential drug interaction',
              },
            ],
          },
          detail: 'Monitor for increased side effects',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      const minorElement = await screen.findByTestId('state-minor');
      expect(minorElement).toBeInTheDocument();
      expect(minorElement).toHaveTextContent('Minor interactions detected');
    });

    it('displays issue details in minor state', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'moderate',
          code: {
            coding: [
              {
                display: 'Aspirin + Warfarin interaction',
              },
            ],
          },
          detail: 'Increased bleeding risk',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      expect(await screen.findByText('Aspirin + Warfarin interaction')).toBeInTheDocument();
      expect(await screen.findByText('Increased bleeding risk')).toBeInTheDocument();
    });

    it('displays acknowledge button in minor state', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'low',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      const acknowledgeBtn = await screen.findByRole('button', {
        name: /acknowledge/i,
      });
      expect(acknowledgeBtn).toBeInTheDocument();
    });
  });

  describe('state-critical', () => {
    it('renders state-critical when severity is high', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'high',
          code: {
            coding: [
              {
                display: 'Critical interaction',
              },
            ],
          },
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      const criticalElement = await screen.findByTestId('state-critical');
      expect(criticalElement).toBeInTheDocument();
      expect(criticalElement).toHaveTextContent('Critical interactions detected');
    });

    it('shows override button disabled until reason is 10+ chars', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'high',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      const overrideBtn = await screen.findByRole('button', {
        name: /override/i,
      });
      expect(overrideBtn).toBeDisabled();

      const reasonField = await screen.findByRole('textbox', {
        name: /override reason/i,
      });
      const user = userEvent.setup();

      // Type 5 characters
      await user.type(reasonField, 'short');
      expect(overrideBtn).toBeDisabled();

      // Type 5 more characters to reach 10
      await user.type(reasonField, 'longer');
      expect(overrideBtn).toBeEnabled();
    });

    it('calls onAcknowledge with issues when acknowledge button is clicked', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'high',
          id: 'issue-1',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      const { onAcknowledge } = renderPanel({
        drugInteractionApi,
      });

      const acknowledgeBtn = await screen.findByRole('button', {
        name: /acknowledge/i,
      });
      const user = userEvent.setup();
      await user.click(acknowledgeBtn);

      expect(onAcknowledge).toHaveBeenCalledWith(issues);
    });

    it('calls onOverride with issues and reason when override button is clicked', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'high',
          id: 'issue-1',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      const { onOverride } = renderPanel({
        drugInteractionApi,
      });

      const reasonField = await screen.findByRole('textbox', {
        name: /override reason/i,
      });
      const overrideBtn = await screen.findByRole('button', {
        name: /override/i,
      });

      const user = userEvent.setup();
      await user.type(reasonField, 'Clinical justification required');
      await user.click(overrideBtn);

      expect(onOverride).toHaveBeenCalledWith(issues, 'Clinical justification required');
    });

    it('displays multiple critical issues with severity badges', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'high',
          code: {
            coding: [
              {
                display: 'High severity interaction 1',
              },
            ],
          },
        },
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'moderate',
          code: {
            coding: [
              {
                display: 'Lower severity interaction',
              },
            ],
          },
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      renderPanel({ drugInteractionApi });

      expect(await screen.findByText('High severity interaction 1')).toBeInTheDocument();
      expect(await screen.findByText('Lower severity interaction')).toBeInTheDocument();
    });
  });

  describe('state-api-error', () => {
    it('renders state-api-error when checkInteractions rejects', async () => {
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockRejectedValue(new Error('API failed')),
      };

      renderPanel({ drugInteractionApi });

      const errorElement = await screen.findByTestId('state-api-error');
      expect(errorElement).toBeInTheDocument();
      expect(errorElement).toHaveTextContent('Could not check interactions');
    });

    it('displays the error message from the API', async () => {
      const errorMessage = 'Service temporarily unavailable';
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockRejectedValue(new Error(errorMessage)),
      };

      renderPanel({ drugInteractionApi });

      expect(await screen.findByText(errorMessage)).toBeInTheDocument();
    });
  });

  describe('null-safe rendering', () => {
    it('handles missing medication coding gracefully', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'low',
          code: {
            text: 'Some interaction',
            /* coding is undefined */
          },
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      const { container } = renderPanel({ drugInteractionApi });

      expect(await screen.findByTestId('state-minor')).toBeInTheDocument();
      expect(container).not.toBeNull();
    });

    it('handles missing detail gracefully', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'low',
          code: { text: 'Interaction without detail' },
          /* detail is undefined */
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      const { container } = renderPanel({ drugInteractionApi });

      expect(await screen.findByTestId('state-minor')).toBeInTheDocument();
      expect(container).not.toBeNull();
    });
  });

  describe('acknowledge in minor state', () => {
    it('calls onAcknowledge in minor state', async () => {
      const issues: DetectedIssue[] = [
        {
          resourceType: 'DetectedIssue',
          status: 'final',
          severity: 'moderate',
        },
      ];

      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue(issues),
      };

      const { onAcknowledge } = renderPanel({
        drugInteractionApi,
      });

      const acknowledgeBtn = await screen.findByRole('button', {
        name: /acknowledge/i,
      });
      const user = userEvent.setup();
      await user.click(acknowledgeBtn);

      expect(onAcknowledge).toHaveBeenCalledWith(issues);
    });
  });

  describe('empty state handling', () => {
    it('handles zero-length issues array as no-interactions', async () => {
      const drugInteractionApi: DrugInteractionApi = {
        checkInteractions: vi.fn().mockResolvedValue([]),
      };

      renderPanel({ drugInteractionApi });

      expect(await screen.findByTestId('state-no-interactions')).toBeInTheDocument();
    });
  });
});
