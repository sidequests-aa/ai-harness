import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseTicket } from '../src/parseTicket';

const TICKET_PATH = resolve(__dirname, '../tickets/001-interaction-review-panel.md');

describe('parseTicket', () => {
  const ticket = parseTicket(TICKET_PATH);

  it('extracts the title from the H1', () => {
    expect(ticket.title).toBe('Build InteractionReviewPanel component');
  });

  it('extracts the summary text', () => {
    expect(ticket.summary).toMatch(/clinician prescribes a new medication/);
  });

  it('extracts the five context packs', () => {
    expect(ticket.contextPacks).toEqual([
      'react-conventions',
      'fhir-resources',
      'medplum-react-hooks',
      'loading-error-patterns',
      'testing-patterns',
    ]);
  });

  it('extracts the file scope from the fenced block', () => {
    expect(ticket.fileScope).toContain('src/components/InteractionReviewPanel/**');
    expect(ticket.fileScope).toContain('src/types/drugInteractionApi.ts');
  });

  it('extracts the FHIR resources', () => {
    // Bullets contain backticks + descriptions; the parser keeps the raw bullet text.
    expect(ticket.fhirResources.length).toBeGreaterThanOrEqual(3);
    expect(ticket.fhirResources.join(' ')).toContain('MedicationRequest');
    expect(ticket.fhirResources.join(' ')).toContain('AllergyIntolerance');
    expect(ticket.fhirResources.join(' ')).toContain('DetectedIssue');
  });

  it('extracts six sub-tasks with dependsOn relationships', () => {
    const ids = ticket.subTasks.map((t) => t.id);
    expect(ids).toEqual(['ST1', 'ST2', 'ST3', 'ST4', 'ST5', 'ST6']);
    // ST1 has no deps, ST2 depends on ST1, ST6 depends on ST5
    const st1 = ticket.subTasks.find((t) => t.id === 'ST1');
    const st2 = ticket.subTasks.find((t) => t.id === 'ST2');
    const st6 = ticket.subTasks.find((t) => t.id === 'ST6');
    expect(st1?.dependsOn).toEqual([]);
    expect(st2?.dependsOn).toEqual(['ST1']);
    expect(st6?.dependsOn).toEqual(['ST5']);
  });

  it('extracts twelve acceptance criteria', () => {
    const ids = ticket.acceptanceCriteria.map((a) => a.id);
    expect(ids).toEqual([
      'AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6',
      'AC7', 'AC8', 'AC9', 'AC10', 'AC11', 'AC12',
    ]);
  });

  it('extracts budget values', () => {
    expect(ticket.budgets.maxTurns).toBe(40);
    expect(ticket.budgets.maxCostUSD).toBe(3);
    expect(ticket.budgets.maxWallSeconds).toBe(600);
  });

  it('preserves the raw markdown for the agent prompt', () => {
    expect(ticket.raw).toContain('# Build InteractionReviewPanel component');
    expect(ticket.raw.length).toBeGreaterThan(1000);
  });
});
