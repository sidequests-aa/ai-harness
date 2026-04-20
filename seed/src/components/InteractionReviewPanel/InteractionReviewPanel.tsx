import { Alert, Badge, Button, Group, Skeleton, Stack, Textarea } from '@mantine/core';
import { useSearchResources } from '@medplum/react';
import type { AllergyIntolerance, DetectedIssue, MedicationRequest } from '@medplum/fhirtypes';
import { useCallback, useEffect, useState } from 'react';
import type { CheckInteractionsInput, DrugInteractionApi } from '../../types/drugInteractionApi';

export interface InteractionReviewPanelProps {
  /** The patient ID to check interactions for */
  patientId: string;
  /** The proposed new medication to check */
  proposedMedication: MedicationRequest;
  /** The injected drug interaction API (dependency injection) */
  drugInteractionApi: DrugInteractionApi;
  /** Called when the user acknowledges the interactions */
  onAcknowledge: (issues: DetectedIssue[]) => void;
  /** Called when the user overrides the interactions with a reason */
  onOverride: (issues: DetectedIssue[], reason: string) => void;
}

export function InteractionReviewPanel({
  patientId,
  proposedMedication,
  drugInteractionApi,
  onAcknowledge,
  onOverride,
}: InteractionReviewPanelProps) {
  // Fetch the patient's current medications and allergies using Medplum hooks
  const [medications, medicationsLoading] = useSearchResources<MedicationRequest>(
    'MedicationRequest',
    {
      patient: `Patient/${patientId}`,
      status: 'active',
    },
  );

  const [allergies, allergiesLoading] = useSearchResources<AllergyIntolerance>(
    'AllergyIntolerance',
    { patient: `Patient/${patientId}` },
  );

  // Local state for interaction results and API errors
  const [detectedIssues, setDetectedIssues] = useState<DetectedIssue[] | undefined>(undefined);
  const [apiError, setApiError] = useState<Error | undefined>(undefined);
  const [overrideReason, setOverrideReason] = useState('');

  // Call the drug interaction API once both medications and allergies are loaded
  useEffect(() => {
    if (medicationsLoading || allergiesLoading) {
      return;
    }

    let cancelled = false;

    const checkInteractions = async () => {
      try {
        const input: CheckInteractionsInput = {
          proposedMedication,
          currentMedications: medications ?? [],
          allergies: allergies ?? [],
        };
        const issues = await drugInteractionApi.checkInteractions(input);
        if (!cancelled) {
          setDetectedIssues(issues);
          setApiError(undefined);
        }
      } catch (error) {
        if (!cancelled) {
          setApiError(error instanceof Error ? error : new Error('Unknown error'));
          setDetectedIssues(undefined);
        }
      }
    };

    checkInteractions();

    return () => {
      cancelled = true;
    };
  }, [
    medicationsLoading,
    allergiesLoading,
    medications,
    allergies,
    proposedMedication,
    drugInteractionApi,
  ]);

  // Determine the loading state (not loading if we have an error or results)
  const isLoading =
    (medicationsLoading || allergiesLoading || detectedIssues === undefined) && !apiError;

  // Determine if there are any high-severity issues
  const hasCriticalIssues = (detectedIssues ?? []).some((issue) => issue.severity === 'high');

  // Determine if we should show the override button (only in critical state)
  const isOverrideEnabled = overrideReason.length >= 10 && hasCriticalIssues && !apiError;

  // Determine the visual state to render
  const handleAcknowledgeClick = useCallback(() => {
    if (detectedIssues !== undefined) {
      onAcknowledge(detectedIssues);
    }
  }, [detectedIssues, onAcknowledge]);

  const handleOverrideClick = useCallback(() => {
    if (detectedIssues !== undefined) {
      onOverride(detectedIssues, overrideReason);
    }
  }, [detectedIssues, overrideReason, onOverride]);

  // Render loading state
  if (isLoading) {
    return (
      <Stack data-testid="state-loading" gap="md">
        <Skeleton height={100} radius="md" visible />
      </Stack>
    );
  }

  // Render API error state
  if (apiError) {
    return (
      <Alert data-testid="state-api-error" color="red" title="Could not check interactions">
        {apiError.message}
      </Alert>
    );
  }

  // Render no interactions state
  if (!detectedIssues || detectedIssues.length === 0) {
    return (
      <Alert data-testid="state-no-interactions" color="green" title="No interactions found">
        This medication does not interact with the patient's current medications or allergies.
      </Alert>
    );
  }

  // Render critical state (high severity issues present)
  if (hasCriticalIssues) {
    return (
      <Stack data-testid="state-critical" gap="md">
        <Alert color="red" title="Critical interactions detected" variant="filled">
          <Stack gap="sm">
            <span>
              This medication has critical interactions with the patient's current medications or
              allergies. Review the details below and either acknowledge or override with a
              documented reason.
            </span>
            {detectedIssues.map((issue, index) => (
              <div key={issue.id ?? `issue-${index}`} style={{ marginTop: '12px' }}>
                <Group justify="space-between" wrap="nowrap">
                  <span style={{ flex: 1 }}>
                    <strong>
                      {issue.code?.coding?.[0]?.display ?? issue.code?.text ?? 'Interaction'}
                    </strong>
                    {issue.detail && (
                      <div style={{ marginTop: '4px', fontSize: '0.9em' }}>{issue.detail}</div>
                    )}
                  </span>
                  <Badge
                    color={issue.severity === 'high' ? 'red' : 'yellow'}
                    variant="light"
                    style={{ marginLeft: '8px' }}
                  >
                    {issue.severity === 'high' ? 'Critical' : 'Minor'}
                  </Badge>
                </Group>
              </div>
            ))}
          </Stack>
        </Alert>

        <Stack gap="sm">
          <Textarea
            label="Override reason (required for critical interactions)"
            placeholder="Document the clinical justification for proceeding despite interactions..."
            minRows={3}
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.currentTarget.value)}
          />
          <Group>
            <Button variant="default" onClick={handleAcknowledgeClick}>
              Acknowledge
            </Button>
            <Button color="red" onClick={handleOverrideClick} disabled={!isOverrideEnabled}>
              Override ({Math.max(0, 10 - overrideReason.length)} characters required)
            </Button>
          </Group>
        </Stack>
      </Stack>
    );
  }

  // Render minor state (some non-critical issues)
  return (
    <Stack data-testid="state-minor" gap="md">
      <Alert color="yellow" title="Minor interactions detected">
        <Stack gap="sm">
          <span>
            This medication has minor interactions with the patient's current medications or
            allergies. Review the details below.
          </span>
          {detectedIssues.map((issue, index) => (
            <div key={issue.id ?? `issue-${index}`} style={{ marginTop: '12px' }}>
              <Group justify="space-between" wrap="nowrap">
                <span style={{ flex: 1 }}>
                  <strong>
                    {issue.code?.coding?.[0]?.display ?? issue.code?.text ?? 'Interaction'}
                  </strong>
                  {issue.detail && (
                    <div style={{ marginTop: '4px', fontSize: '0.9em' }}>{issue.detail}</div>
                  )}
                </span>
                <Badge color="yellow" variant="light" style={{ marginLeft: '8px' }}>
                  Minor
                </Badge>
              </Group>
            </div>
          ))}
        </Stack>
      </Alert>
      <Button onClick={handleAcknowledgeClick}>Acknowledge</Button>
    </Stack>
  );
}

export default InteractionReviewPanel;
