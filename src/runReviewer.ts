import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ticket } from './types';

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

export async function runReviewer({ ticket, cwd, model }: RunReviewerOpts): Promise<ReviewerRunResult> {
  const start = Date.now();

  const systemPrompt = buildReviewerPrompt(ticket);

  const schema = z.toJSONSchema(ReviewVerdictSchema);

  let verdict: ReviewVerdict | null = null;
  let costUsd = 0;
  let turns = 0;
  let rawText = '';

  // eslint-disable-next-line no-console
  console.log(`[reviewer] starting in ${cwd}`);

  for await (const message of query({
    prompt: `Review the implementer's work against the acceptance criteria below and return your verdict as structured JSON.

Acceptance criteria:
${ticket.acceptanceCriteria.map((ac) => `- **${ac.id}**: ${ac.text}`).join('\n')}

Use \`git diff main\` (from this directory) to see what changed, then \`Read\`/\`Grep\` the changed files to verify each criterion. Cite file:line in the evidence field.`,
    options: {
      cwd,
      systemPrompt,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      permissionMode: 'default',
      maxTurns: 20,
      outputFormat: { type: 'json_schema', schema },
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
        structured_output?: unknown;
      };
      costUsd = r.total_cost_usd ?? 0;
      turns = r.num_turns ?? 0;
      rawText = r.result ?? '';
      if (r.structured_output) {
        const parsed = ReviewVerdictSchema.safeParse(r.structured_output);
        if (parsed.success) {
          verdict = parsed.data;
        } else {
          // eslint-disable-next-line no-console
          console.warn('[reviewer] structured_output failed schema validation:', parsed.error.message);
        }
      }
    }
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
