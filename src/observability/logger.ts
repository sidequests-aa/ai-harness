import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RunEvent } from './schema';

/**
 * Distributive Omit — strips `runId` and `ts` from EACH member of the
 * RunEvent discriminated union individually, preserving the discriminator.
 * Without this, `Omit<RunEvent, ...>` collapses the union and breaks the
 * discriminated checking at call sites.
 */
type LogInput = RunEvent extends infer R
  ? R extends RunEvent
    ? Omit<R, 'runId' | 'ts'>
    : never
  : never;

/**
 * Append-only JSONL logger. One file per run at
 * `runs/<runId>/events.jsonl`. Synchronous writes — we want events to land
 * even if the harness crashes mid-run.
 *
 * Use the helpers (`logRunStart`, `logStageEnter`, etc.) instead of calling
 * `log` directly so the discriminator + timestamp are filled in
 * consistently.
 */
export class RunLogger {
  readonly runDir: string;
  readonly eventsPath: string;
  readonly transcriptPath: string;

  constructor(
    private readonly runsRoot: string,
    private readonly runId: string,
  ) {
    this.runDir = resolve(runsRoot, runId);
    this.eventsPath = resolve(this.runDir, 'events.jsonl');
    this.transcriptPath = resolve(this.runDir, 'transcript.md');
    mkdirSync(this.runDir, { recursive: true });
    // Touch the files so they exist even if the run aborts early.
    writeFileSync(this.eventsPath, '');
    writeFileSync(this.transcriptPath, `# Run ${runId}\n\n`);
  }

  /** Append one event. The runId/ts fields are filled in here. */
  log(event: LogInput): void {
    const full = {
      runId: this.runId,
      ts: new Date().toISOString(),
      ...event,
    } as RunEvent;
    try {
      appendFileSync(this.eventsPath, `${JSON.stringify(full)}\n`);
    } catch (err) {
      // Don't let logging failures crash a run; just emit to stderr.
      // eslint-disable-next-line no-console
      console.error('[logger] write failed:', (err as Error).message);
    }
  }

  /** Append a human-readable line to the transcript markdown. */
  transcript(line: string): void {
    try {
      appendFileSync(this.transcriptPath, `${line}\n`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[logger] transcript write failed:', (err as Error).message);
    }
  }

  /**
   * Write a pretty-printed JSON file alongside the events. Used for the
   * plan, gate results, reviewer verdict — anything we want to inspect
   * standalone without parsing JSONL.
   */
  writeJson(filename: string, data: unknown): void {
    const path = resolve(this.runDir, filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  }
}

/**
 * Generate a run id. Format: ISO timestamp without separators + 6-char
 * random suffix. Sortable by date, no collisions.
 */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${ts}-${suffix}`;
}
