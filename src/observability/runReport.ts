import type { Ticket } from '../types';
import type { AgentRunResult } from '../runAgent';
import type { ReviewVerdict } from '../runReviewer';

/**
 * Builds the structured PR description that the human reviewer sees when
 * they open the harness's PR. This is the primary observability artifact
 * for the demo — graders will read this in lieu of (or alongside) the
 * actual diff.
 *
 * Sections, in order:
 * - Status header (cost, turns, wall time, run id, escalation reason)
 * - Acceptance criteria checklist with reviewer verdict per item
 * - Quality gate ladder result table
 * - Plan (sub-task DAG from the ticket)
 * - Notable agent decisions (extracted from the agent's final summary)
 * - Out-of-scope requests (scope-guard denials)
 * - Replay command + run id
 *
 * Density matters — graders should be able to read this and know what to
 * scrutinize first without opening the diff.
 */
export interface RunReportInput {
  ticket: Ticket;
  runId: string;
  branch: string;
  agentResult: AgentRunResult;
  reviewerVerdict: ReviewVerdict | null;
  reviewerCostUsd: number;
  reviewerDurationMs: number;
  /** True if the run is being escalated (gates failed or budget exceeded). */
  escalated: boolean;
  escalationReason?: string;
}

export function buildPrTitle(input: RunReportInput): string {
  const tag = input.escalated ? '[harness escalation]' : '[harness]';
  return `${tag} ${input.ticket.title}`;
}

export function buildPrBody(input: RunReportInput): string {
  const lines: string[] = [];
  const ar = input.agentResult;

  // ── Header ────────────────────────────────────────────────────────────
  const status = input.escalated
    ? `🚧 **escalated**${input.escalationReason ? ` — ${input.escalationReason}` : ''}`
    : input.reviewerVerdict?.approved
    ? '✅ **approved by reviewer**'
    : input.reviewerVerdict
    ? '⚠️ **reviewer requested changes**'
    : '❓ no reviewer verdict';

  lines.push(`# Harness Run`);
  lines.push('');
  lines.push(`**Status**: ${status}`);
  lines.push(`**Run ID**: \`${input.runId}\``);
  lines.push(`**Branch**: \`${input.branch}\``);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Implementer cost | $${ar.totalCostUsd.toFixed(4)} |`);
  lines.push(`| Reviewer cost | $${input.reviewerCostUsd.toFixed(4)} |`);
  lines.push(`| Total cost | $${(ar.totalCostUsd + input.reviewerCostUsd).toFixed(4)} |`);
  lines.push(`| Implementer turns | ${ar.numTurns} / ${input.ticket.budgets.maxTurns} budget |`);
  lines.push(`| Implementer wall | ${(ar.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Reviewer wall | ${(input.reviewerDurationMs / 1000).toFixed(1)}s |`);
  lines.push(`| run_gates invocations | ${ar.gateInvocations} |`);
  lines.push('');

  // ── Acceptance criteria ───────────────────────────────────────────────
  lines.push('## Acceptance Criteria');
  lines.push('');
  if (input.reviewerVerdict) {
    const byId = new Map(input.reviewerVerdict.criterionResults.map((c) => [c.id, c]));
    for (const ac of input.ticket.acceptanceCriteria) {
      const v = byId.get(ac.id);
      if (!v) {
        lines.push(`- [ ] **${ac.id}** ${ac.text} _(reviewer skipped this criterion)_`);
      } else {
        const box = v.status === 'met' ? '[x]' : '[ ]';
        const badge =
          v.status === 'met' ? '✅ met' : v.status === 'partial' ? '⚠️ partial' : '❌ unmet';
        lines.push(`- ${box} **${ac.id}** — ${badge} — ${v.evidence}`);
      }
    }
  } else {
    for (const ac of input.ticket.acceptanceCriteria) {
      lines.push(`- [ ] **${ac.id}** ${ac.text} _(no reviewer verdict)_`);
    }
  }
  if (input.reviewerVerdict?.comments) {
    lines.push('');
    lines.push(`> **Reviewer notes:** ${input.reviewerVerdict.comments}`);
  }
  lines.push('');

  // ── Gates ─────────────────────────────────────────────────────────────
  lines.push('## Quality Gates');
  lines.push('');
  lines.push('| Gate | Result | Details |');
  lines.push('|---|---|---|');
  // G1, G2, G3 reported via fast-gate hook collector
  const fastGate = ar.hookEvents.fastGateFailures;
  const g1Failed = fastGate.some((f) => f.gate === 'prettier');
  const g2Failed = fastGate.some((f) => f.gate === 'eslint');
  lines.push(`| G1 prettier | ${g1Failed ? '❌' : '✅'} | runs as PostToolUse hook on every Write/Edit |`);
  lines.push(`| G2 eslint | ${g2Failed ? '❌' : '✅'} | runs as PostToolUse hook on every Write/Edit |`);
  // G3 tsc lives inside run_gates in this build (deferred from per-write to once)
  lines.push(`| G3 tsc --noEmit | ⏭ | (not run in Phase 4 — too slow per-write; future phase) |`);
  // G4 import-audit
  const g4Failed = ar.hookEvents.importDenials.length > 0;
  lines.push(`| G4 import-audit | ${g4Failed ? '❌ ' + ar.hookEvents.importDenials.length + ' denials' : '✅ no hallucinated imports'} | PreToolUse hook, ts-morph based |`);
  // G5 scope-guard
  const g5Failed = ar.hookEvents.scopeDenials.length > 0;
  lines.push(`| G5 scope-guard | ${g5Failed ? '⚠️ ' + ar.hookEvents.scopeDenials.length + ' denials' : '✅ no scope violations'} | PreToolUse hook, picomatch globs |`);
  // G6-G10 from run_gates
  const finalGates = ar.finalGateResult?.gates ?? [];
  for (const g of finalGates) {
    const icon = g.ok ? '✅' : '❌';
    lines.push(`| ${g.name} ${g.label} | ${icon} | ${g.details} |`);
  }
  if (finalGates.length === 0) {
    lines.push('| G6-G10 | ⏭ | run_gates was not invoked by the agent |');
  }
  // G11 reviewer
  const g11 = input.reviewerVerdict
    ? input.reviewerVerdict.approved
      ? '✅ approved'
      : '⚠️ changes requested'
    : '⏭ not run';
  lines.push(`| G11 reviewer subagent | ${g11} | LLM-as-judge on AC checklist, read-only Read/Grep/Glob |`);
  lines.push('');

  // ── Plan ──────────────────────────────────────────────────────────────
  lines.push('## Plan (from ticket)');
  lines.push('');
  for (const st of input.ticket.subTasks) {
    const deps = st.dependsOn.length > 0 ? ` _(depends: ${st.dependsOn.join(', ')})_` : '';
    lines.push(`- **${st.id}** ${st.title}${deps}`);
  }
  lines.push('');

  // ── Out-of-scope requests ─────────────────────────────────────────────
  if (ar.hookEvents.scopeDenials.length > 0) {
    lines.push('## Out-of-scope requests');
    lines.push('');
    lines.push('The agent attempted these and was blocked by the scope-guard hook. Review and decide if any should be allowed in a follow-up.');
    lines.push('');
    for (const d of ar.hookEvents.scopeDenials) {
      lines.push(
        `- **${d.tool}** ${d.targetPath ? `→ \`${d.targetPath}\`` : `→ \`${d.command}\``}`,
      );
      lines.push(`  - ${d.reason.split('\n')[0]}`);
    }
    lines.push('');
  }

  // ── Hallucinated imports caught ───────────────────────────────────────
  if (ar.hookEvents.importDenials.length > 0) {
    lines.push('## Hallucinated imports caught');
    lines.push('');
    for (const d of ar.hookEvents.importDenials) {
      lines.push(`- \`${d.specifier}\` in \`${d.filePath}\``);
      lines.push(`  - ${d.reason}`);
    }
    lines.push('');
  }

  // ── Agent's final summary ─────────────────────────────────────────────
  if (ar.finalText && ar.finalText.trim().length > 0) {
    lines.push("## Agent's final summary");
    lines.push('');
    lines.push(ar.finalText.trim());
    lines.push('');
  }

  // ── Reproduce ─────────────────────────────────────────────────────────
  lines.push('## Reproduce locally');
  lines.push('');
  lines.push('```bash');
  lines.push(`# Replay the structured event log for this run`);
  lines.push(`npm run harness:replay -- runs/${input.runId}`);
  lines.push('```');
  lines.push('');
  lines.push(`Full event log: \`runs/${input.runId}/events.jsonl\``);
  lines.push(`Run transcript: \`runs/${input.runId}/transcript.md\``);
  lines.push('');
  lines.push('---');
  lines.push('🤖 *PR opened by [intrahealth-harness](https://github.com/sideprojects-aa/intrahealth-harness).*');

  return lines.join('\n');
}
