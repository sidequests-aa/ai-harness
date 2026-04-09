/**
 * Phase 1 type definitions. These are the contracts the pipeline stages
 * read and write. Kept deliberately small — they grow as later phases add
 * planner/reviewer/observability state.
 */

export type Severity = 'low' | 'medium' | 'high';

/** A single sub-task from the ticket's `## Sub-Tasks (DAG)` section. */
export interface SubTask {
  id: string;
  title: string;
  dependsOn: string[];
}

/** A single acceptance criterion from `## Acceptance Criteria`. */
export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/** Per-ticket budgets parsed from `## Budgets`. */
export interface TicketBudgets {
  maxTurns: number;
  maxCostUSD: number;
  maxWallSeconds: number;
}

/** A parsed ticket — the typed result of stage 1 (parseTicket). */
export interface Ticket {
  title: string;
  /** The product-level summary. Embedded directly in the agent's prompt. */
  summary: string;
  /** Names of curated context packs the ticket author opted into. */
  contextPacks: string[];
  /** Glob patterns the agent is allowed to write inside. */
  fileScope: string[];
  /** FHIR resource types the component touches. */
  fhirResources: string[];
  /** Sub-tasks as a DAG (depends-on relationships). */
  subTasks: SubTask[];
  /** Acceptance criteria the reviewer subagent will check (Phase 4). */
  acceptanceCriteria: AcceptanceCriterion[];
  budgets: TicketBudgets;
  /** Free-form notes from the human ticket author. */
  humanNotes: string;
  /** The full raw markdown of the ticket — included in the system prompt. */
  raw: string;
}

/**
 * Phase 1: the plan is just an identity transform of the ticket's sub-tasks.
 * Phase 2 will add a planner subagent that refines this with file-level
 * paths and validates the DAG.
 */
export interface Plan {
  subTasks: SubTask[];
}

/** State threaded through every pipeline stage. Append-only. */
export interface RunState {
  runId: string;
  ticket: Ticket;
  plan?: Plan;
  /** Absolute path to the isolated git worktree the agent operates in. */
  worktreePath?: string;
  /** Branch name created for this run. */
  branchName?: string;
  /** True if the agent's turn produced a non-empty diff. */
  producedChanges?: boolean;
  /** PR URL after stage 7. */
  prUrl?: string;
}
