import type { AllergyIntolerance, DetectedIssue, MedicationRequest } from '@medplum/fhirtypes';

/**
 * CheckInteractionsInput — the input payload for drug interaction checks.
 * The API receives the proposed medication, current medications, allergies,
 * and optionally demographic factors to compute interaction risk.
 */
export interface CheckInteractionsInput {
  /** The proposed new medication to check for interactions */
  proposedMedication: MedicationRequest;
  /** The patient's existing medications (may be empty) */
  currentMedications: MedicationRequest[];
  /** The patient's known allergies and intolerances */
  allergies: AllergyIntolerance[];
}

/**
 * DrugInteractionApi — injected service for checking drug interactions.
 * The component does not import a concrete implementation; instead it
 * accepts an instance via props (dependency injection). This allows tests
 * to inject a mock and production code to inject the real service.
 */
export interface DrugInteractionApi {
  /**
   * Checks the proposed medication against the patient's current
   * medications and allergies for interactions.
   *
   * @param input The proposed medication, current medications, and allergies
   * @returns A promise resolving to an array of DetectedIssue resources
   *          (may be empty if no interactions found), or rejecting on error.
   */
  checkInteractions(input: CheckInteractionsInput): Promise<DetectedIssue[]>;
}
