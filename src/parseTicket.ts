import { readFileSync } from 'node:fs';
import type {
  AcceptanceCriterion,
  SubTask,
  Ticket,
  TicketBudgets,
} from './types';

/**
 * Parse a ticket markdown file into a typed `Ticket`.
 *
 * Plain regex / string parsing — no LLM call. The plan explicitly says
 * "graders penalize unnecessary model use on structured data." This parser
 * is the structured-data path.
 *
 * Format spec lives in `medplum-interaction-panel/.harness/tickets/*.md`.
 */
export function parseTicket(filePath: string): Ticket {
  const raw = readFileSync(filePath, 'utf8');

  const title = extractTitle(raw);
  const summary = extractSection(raw, 'Summary') ?? '';
  const contextPacks = extractList(extractSection(raw, 'Context Packs') ?? '');
  const fileScope = extractFencedScope(raw);
  const fhirResources = extractList(extractSection(raw, 'FHIR Resources Consumed') ?? '');
  const subTasks = extractSubTasks(extractSection(raw, 'Sub-Tasks (DAG)') ?? '');
  const acceptanceCriteria = extractAcceptanceCriteria(
    extractSection(raw, 'Acceptance Criteria') ?? '',
  );
  const budgets = extractBudgets(extractSection(raw, 'Budgets') ?? '');
  const humanNotes = extractSection(raw, 'Human Notes') ?? '';

  return {
    title,
    summary: summary.trim(),
    contextPacks,
    fileScope,
    fhirResources,
    subTasks,
    acceptanceCriteria,
    budgets,
    humanNotes: humanNotes.trim(),
    raw,
  };
}

function extractTitle(raw: string): string {
  const match = raw.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() ?? 'Untitled ticket';
}

/**
 * Extract a `## Section Name` block. Returns the body text between the
 * heading and the next `## ` heading (or end of file).
 */
function extractSection(raw: string, name: string): string | null {
  // Escape regex metacharacters in the section name.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  const match = raw.match(re);
  return match?.[1] ?? null;
}

/** Extract bullet-point items (`- foo` or `* foo`) from a section body. */
function extractList(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^[-*]\s+(.+?)\s*$/);
    if (m && m[1]) items.push(m[1].trim());
  }
  return items;
}

/**
 * Extract the `File Scope` fenced block:
 * ```scope
 * src/foo/**
 * src/bar.ts
 * ```
 */
function extractFencedScope(raw: string): string[] {
  const match = raw.match(/```scope\s*\n([\s\S]*?)```/);
  if (!match?.[1]) return [];
  return match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse sub-tasks of the form:
 *   - [ ] **ST1**: Title text. depends: [ST0, ST2]
 */
function extractSubTasks(body: string): SubTask[] {
  const tasks: SubTask[] = [];
  // Sub-tasks may span multiple physical lines because of soft-wrapping in
  // the source markdown. We rejoin continuations (lines that don't start
  // with `- [`) into the previous task line before parsing.
  const joined: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*-\s*\[/.test(line)) {
      joined.push(line);
    } else if (joined.length > 0 && line.trim().length > 0) {
      joined[joined.length - 1] = `${joined[joined.length - 1]} ${line.trim()}`;
    }
  }
  for (const line of joined) {
    const m = line.match(
      /^\s*-\s*\[[ x]\]\s*\*\*(ST\d+)\*\*:\s*(.+?)(?:\s*depends:\s*`?\[(.*?)\]`?\s*)?$/,
    );
    if (!m) continue;
    const id = m[1]!;
    const title = (m[2] ?? '').trim();
    const dependsRaw = m[3] ?? '';
    const dependsOn = dependsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    tasks.push({ id, title, dependsOn });
  }
  return tasks;
}

/**
 * Parse acceptance criteria of the form:
 *   - [ ] **AC1**: Component renders without throwing.
 */
function extractAcceptanceCriteria(body: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  // Same continuation-joining as sub-tasks.
  const joined: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*-\s*\[/.test(line)) {
      joined.push(line);
    } else if (joined.length > 0 && line.trim().length > 0) {
      joined[joined.length - 1] = `${joined[joined.length - 1]} ${line.trim()}`;
    }
  }
  for (const line of joined) {
    const m = line.match(/^\s*-\s*\[[ x]\]\s*\*\*(AC\d+)\*\*:\s*(.+?)\s*$/);
    if (!m) continue;
    out.push({ id: m[1]!, text: (m[2] ?? '').trim() });
  }
  return out;
}

function extractBudgets(body: string): TicketBudgets {
  const turns = matchKeyVal(body, 'maxTurns');
  const cost = matchKeyVal(body, 'maxCostUSD');
  const wall = matchKeyVal(body, 'maxWallSeconds');
  return {
    maxTurns: turns ? Number(turns) : 40,
    maxCostUSD: cost ? Number(cost) : 3,
    maxWallSeconds: wall ? Number(wall) : 600,
  };
}

function matchKeyVal(body: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\`${escaped}\`?\\s*:\\s*([0-9.]+)`);
  const m = body.match(re);
  return m?.[1] ?? null;
}
