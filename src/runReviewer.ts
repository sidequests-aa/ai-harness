import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ticket } from './types';

// `z` is referenced via the schema definition below; the import is needed
// for the value-position usage. Suppress an unused-import warning here so
// we can keep the explicit import.
void z;

/**
 * The reviewer subagent (Phase 4 — Quality Gate G11).
 *
 * Runs as a separate top-level `query()` invocation AFTER the implementer
 * agent has finished and `run_gates` has reported pass. The reviewer is
 * given the worktree (read-only) and the ticket's acceptance criteria, and
 * its job is to decide met / partial / unmet for each criterion with a
 * file:line citation.
 *
 * Why a separate query and not a subagent invoked by the implementer:
 * - The implementer cannot be trusted to call its own reviewer (it'll
 *   either skip review when it shouldn't or self-flatter).
 * - Running review as the harness's own pipeline stage makes the
 *   "harness orchestrates" framing visible in logs and the demo.
 * - The reviewer gets a fresh context window, so it isn't biased by the
 *   implementer's reasoning chain.
 *
 * The reviewer's tools are read-only: Read, Grep, Glob, plus Bash for
 * `git diff` so it can see what changed without re-walking the worktree.
 */

export const ReviewVerdictSchema = z.object({
  approved: z
    .boolean()
    .describe('True only if every acceptance criterion is met. Partial or unmet → false.'),
  criterionResults: z
    .array(
      z.object({
        id: z.string().describe('Acceptance criterion id, e.g. "AC1"'),
        status: z
          .enum(['met', 'partial', 'unmet'])
          .describe('Whether this criterion is satisfied by the diff.'),
        evidence: z
          .string()
          .describe('File:line citation or short explanation. Required for both met and unmet.'),
      }),
    )
    .describe('One entry per acceptance criterion in the ticket. Order matches the ticket.'),
  comments: z
    .string()
    .describe('Brief overall summary — what the implementer did well and what still needs work.'),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

interface RunReviewerOpts {
  ticket: Ticket;
  /** Absolute path the reviewer should run inside (the seed root in the worktree). */
  cwd: string;
  /**
   * Implementer's final summary text. Passed into the reviewer's prompt so
   * the reviewer doesn't have to re-derive context cold.
   */
  implementerSummary?: string;
  /** Optional model override. */
  model?: string;
}

export interface ReviewerRunResult {
  verdict: ReviewVerdict | null;
  costUsd: number;
  turns: number;
  durationMs: number;
  /** Raw text the reviewer produced if structured output failed. */
  rawText: string;
}

export async function runReviewer({
  ticket,
  cwd,
  implementerSummary,
  model,
}: RunReviewerOpts): Promise<ReviewerRunResult> {
  const start = Date.now();

  const systemPrompt = buildReviewerPrompt(ticket);

  let verdict: ReviewVerdict | null = null;
  let costUsd = 0;
  let turns = 0;
  let rawText = '';

  // eslint-disable-next-line no-console
  console.log(`[reviewer] starting in ${cwd}`);

  const userPrompt = `Review the implementer's work against the acceptance criteria below.

## Acceptance criteria
${ticket.acceptanceCriteria.map((ac) => `- **${ac.id}**: ${ac.text}`).join('\n')}

${implementerSummary ? `## What the implementer claims it did\n\n${implementerSummary.slice(0, 2000)}\n\n` : ''}## How to investigate

1. Run \`git diff main --stat\` (from this directory) to see what files changed.
2. Run \`git diff main\` to see the full diff.
3. \`Read\` the changed files to verify each criterion.
4. **Be efficient.** You have a turn budget. Don't re-read the same file twice; don't grep for things you can see in the diff.

## Output

When you're ready (and **only** when you're ready — do not output JSON during exploration), respond with EXACTLY one fenced code block tagged \`json\` containing your verdict, and nothing else outside the fence:

\`\`\`json
{
  "approved": boolean,
  "criterionResults": [
    { "id": "AC1", "status": "met" | "partial" | "unmet", "evidence": "file:line — short explanation" }
  ],
  "comments": "one-paragraph overall summary"
}
\`\`\`

The harness parses your final message for that fenced JSON. If \`approved\` is false because of any partial/unmet criterion, the PR opens as a draft escalation.`;

  // Wrap the iterator in try/catch so SDK errors (e.g. maxTurns reached)
  // don't crash the harness — the cli will surface a "no verdict" reason
  // in the escalation PR rather than blowing up.
  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        cwd,
        systemPrompt,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        permissionMode: 'default',
        // 12 ACs to verify, each potentially 1-2 file reads, plus the
        // formulation of the JSON verdict at the end.
        maxTurns: 30,
        ...(model ? { model } : {}),
      },
    })) {
      const m = message as Record<string, unknown> & { type: string };
      if (m.type === 'result') {
        const r = m as {
          subtype?: string;
          result?: string;
          total_cost_usd?: number;
          num_turns?: number;
        };
        costUsd = r.total_cost_usd ?? 0;
        turns = r.num_turns ?? 0;
        rawText = r.result ?? '';
        // Parse a fenced ```json block from the result text. Robust to the
        // model wrapping it in extra prose despite our instructions.
        const parsed = parseFencedJson(rawText);
        if (parsed) {
          const validated = ReviewVerdictSchema.safeParse(parsed);
          if (validated.success) {
            verdict = validated.data;
          } else {
            // eslint-disable-next-line no-console
            console.warn(
              '[reviewer] fenced JSON failed schema validation:',
              validated.error.message,
            );
          }
        } else {
          // eslint-disable-next-line no-console
          console.warn('[reviewer] no fenced ```json block found in result text');
        }
      }
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // eslint-disable-next-line no-console
    console.warn(`[reviewer] SDK error: ${message}`);
    // verdict stays null; cli sees this and opens a draft escalation PR
  }

  // eslint-disable-next-line no-console
  console.log(
    `[reviewer] verdict: ${verdict ? (verdict.approved ? 'APPROVED' : 'CHANGES REQUESTED') : 'NO VERDICT'} ` +
      `cost=$${costUsd.toFixed(4)} turns=${turns}`,
  );

  return {
    verdict,
    costUsd,
    turns,
    durationMs: Date.now() - start,
    rawText,
  };
}

/**
 * Extract the first fenced ```json block from a chunk of text and parse it.
 * Returns the parsed object, or null if no valid block was found.
 *
 * The model is instructed to wrap its verdict in exactly one such block.
 * In practice it may also include prose or extra blocks; we take the first
 * fenced block tagged `json` (or unlabelled if none) and try to parse it.
 */
function parseFencedJson(text: string): unknown | null {
  if (!text) return null;
  // Try `json`-tagged fences first.
  const labelled = text.match(/```json\s*\n([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (labelled?.[1]) candidates.push(labelled[1]);
  // Fallback: any fenced block.
  const unlabelled = text.match(/```\s*\n([\s\S]*?)```/);
  if (unlabelled?.[1]) candidates.push(unlabelled[1]);
  // Last resort: try the whole text.
  candidates.push(text);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  return null;
}

function buildReviewerPrompt(ticket: Ticket): string {
  return `You are the **reviewer** in an AI engineering harness pipeline. The implementer
agent has finished its work and the cheap quality gates have passed; your job is to
decide whether the implementer actually delivered what the ticket asked for.

You are **read-only**. Do not write, edit, or run any mutating commands. Use \`git diff\`,
\`Read\`, \`Grep\`, \`Glob\` to investigate, then return your verdict as structured JSON.

## Your job

For **each** acceptance criterion in the ticket, decide one of:
- **met** — the implementer's diff genuinely satisfies this criterion. Cite the file and
  approximate line where you can see the evidence.
- **partial** — partially satisfied. Be specific about what's missing.
- **unmet** — not satisfied at all.

If **any** criterion is partial or unmet, set \`approved: false\`.

## What to look for

- Does the criterion's required behavior actually appear in the diff?
- Are tests covering it (where the criterion implies a test)?
- Is the implementation null-safe / well-typed / consistent with the seed's conventions?
- Beware of **fake passes**: code that uses the right \`data-testid\` but renders
  something meaningless, or tests that pass but don't assert what the criterion requires.

## Output format

Return JSON matching this schema:

\`\`\`
{
  "approved": boolean,
  "criterionResults": [
    { "id": "AC1", "status": "met" | "partial" | "unmet", "evidence": "file:line — short explanation" }
  ],
  "comments": "one-paragraph overall summary"
}
\`\`\`

Order \`criterionResults\` in the same order as the ticket. The harness uses your verdict
to either open a clean PR (if approved) or escalate to a draft PR with your comments.

## The ticket title

${ticket.title}`;
}
