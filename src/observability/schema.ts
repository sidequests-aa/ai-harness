/**
 * Discriminated-union schema for the events that flow through `events.jsonl`.
 *
 * Every line of every run's events.jsonl is one of these. New event kinds
 * get added here first; the logger will reject anything that doesn't match
 * a known `t` discriminator at compile time.
 *
 * Why JSONL: append-friendly (no rewriting on every event), grep-friendly,
 * and trivially streamable to the replay-run.ts script. The discriminated
 * union means TypeScript can narrow on `t` and the replay renderer gets
 * exhaustiveness checking for free.
 */

export type StageName =
  | 'parse-ticket'
  | 'plan'
  | 'context'
  | 'execute'
  | 'gate'
  | 'review'
  | 'open-pr';

export type RunOutcome = 'pr-opened' | 'escalated' | 'failed';

export type GateName = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11';

export type ReviewStatus = 'met' | 'partial' | 'unmet';

export interface BaseEvent {
  /** Run id this event belongs to. */
  runId: string;
  /** ISO timestamp the event was emitted. */
  ts: string;
}

export type RunEvent =
  | (BaseEvent & {
      t: 'run.start';
      ticketTitle: string;
      ticketPath: string;
      branch: string;
      model: string | undefined;
    })
  | (BaseEvent & {
      t: 'stage.enter';
      stage: StageName;
    })
  | (BaseEvent & {
      t: 'stage.exit';
      stage: StageName;
      durationMs: number;
      ok: boolean;
    })
  | (BaseEvent & {
      t: 'context.loaded';
      packsLoaded: number;
      packsRequested: number;
      packsMissing: string[];
      packsTotalChars: number;
      repoMapFiles: number;
    })
  | (BaseEvent & {
      t: 'agent.message';
      role: 'assistant' | 'user' | 'system';
      /** Truncated text content (first ~500 chars). */
      preview: string;
    })
  | (BaseEvent & {
      t: 'tool.call';
      tool: string;
      /** Truncated input JSON (first ~200 chars). */
      inputPreview: string;
    })
  | (BaseEvent & {
      t: 'hook.deny';
      hook: 'scope-guard' | 'import-audit';
      /** What the hook was protecting against. */
      reason: string;
      targetPath?: string;
      command?: string;
      specifier?: string;
    })
  | (BaseEvent & {
      t: 'hook.fast-gate';
      filePath: string;
      gate: 'prettier' | 'eslint';
      output: string;
    })
  | (BaseEvent & {
      t: 'gate.result';
      invocation: number;
      ok: boolean;
      gates: Array<{ name: GateName; label: string; ok: boolean; details: string }>;
    })
  | (BaseEvent & {
      t: 'reviewer.verdict';
      approved: boolean;
      criterionResults: Array<{ id: string; status: ReviewStatus; evidence: string }>;
      comments: string;
    })
  | (BaseEvent & {
      t: 'budget.tick';
      costUsd: number;
      turns: number;
      durationMs: number;
    })
  | (BaseEvent & {
      t: 'error';
      where: string;
      message: string;
      stack?: string;
    })
  | (BaseEvent & {
      t: 'run.end';
      outcome: RunOutcome;
      prUrl?: string;
      reason?: string;
    });

export type EventKind = RunEvent['t'];

/** Compile-time exhaustiveness helper for switch(event.t) consumers. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled event kind: ${JSON.stringify(x)}`);
}
