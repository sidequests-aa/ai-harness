#!/usr/bin/env tsx
/**
 * scripts/replay-run.ts — re-render a past harness run from its events.jsonl.
 *
 * Reads `runs/<runId>/events.jsonl` and produces a human-readable transcript
 * to stdout. Does NOT re-execute the agent — this is purely for debugging
 * and demoing past runs (no API cost).
 *
 * Usage:
 *   npx tsx scripts/replay-run.ts runs/<runId>
 *   npx tsx scripts/replay-run.ts runs/<runId> --json     # raw events
 *   npx tsx scripts/replay-run.ts runs/<runId> --summary  # one-line per event
 *
 * Why this matters: a recorded run with a clean transcript is what we use
 * during the live demo if the on-stage `npm run harness` flakes. Replay is
 * deterministic and instant.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunEvent } from '../src/observability/schema';
import { assertNever } from '../src/observability/schema';

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: replay-run.ts <run-dir> [--json|--summary]');
    process.exit(1);
  }
  const runDir = resolve(args[0]!);
  const mode: 'pretty' | 'json' | 'summary' =
    args.includes('--json') ? 'json' : args.includes('--summary') ? 'summary' : 'pretty';

  const eventsPath = resolve(runDir, 'events.jsonl');
  if (!existsSync(eventsPath)) {
    console.error(`No events.jsonl at ${eventsPath}`);
    process.exit(1);
  }

  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const events: RunEvent[] = lines.map((l) => JSON.parse(l) as RunEvent);

  if (mode === 'json') {
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }

  if (mode === 'summary') {
    for (const e of events) console.log(`${e.ts}  ${e.t}`);
    return;
  }

  // Pretty mode — render as a readable transcript.
  console.log(`# Replay: ${runDir}`);
  console.log(`Events: ${events.length}`);
  console.log('');
  for (const e of events) {
    renderEvent(e);
  }
}

function renderEvent(e: RunEvent): void {
  const ts = e.ts.slice(11, 19); // HH:MM:SS
  switch (e.t) {
    case 'run.start':
      console.log(`[${ts}] 🚀 RUN START`);
      console.log(`        ticket: ${e.ticketTitle}`);
      console.log(`        branch: ${e.branch}`);
      if (e.model) console.log(`        model: ${e.model}`);
      console.log('');
      break;
    case 'stage.enter':
      console.log(`[${ts}] ── enter ${e.stage}`);
      break;
    case 'stage.exit':
      console.log(
        `[${ts}] ── exit  ${e.stage} (${(e.durationMs / 1000).toFixed(1)}s, ${e.ok ? 'ok' : 'FAILED'})`,
      );
      break;
    case 'context.loaded':
      console.log(
        `[${ts}] 📦 context loaded: ${e.packsLoaded}/${e.packsRequested} packs (${e.packsTotalChars} chars), ${e.repoMapFiles} files in repo map`,
      );
      break;
    case 'agent.message':
      console.log(`[${ts}] 💬 ${e.role}: ${e.preview}`);
      break;
    case 'tool.call':
      console.log(`[${ts}] 🔧 → ${e.tool}  ${e.inputPreview}`);
      break;
    case 'hook.deny':
      console.log(`[${ts}] 🛑 ${e.hook} DENIED`);
      console.log(`        reason: ${e.reason.slice(0, 120)}${e.reason.length > 120 ? '…' : ''}`);
      if (e.targetPath) console.log(`        target: ${e.targetPath}`);
      if (e.command) console.log(`        command: ${e.command}`);
      if (e.specifier) console.log(`        specifier: ${e.specifier}`);
      break;
    case 'hook.fast-gate':
      console.log(`[${ts}] ⚠ fast-gate ${e.gate} failed: ${e.filePath}`);
      break;
    case 'gate.result':
      console.log(`[${ts}] 🚦 run_gates #${e.invocation}: ${e.ok ? 'ALL PASS' : 'FAILURES'}`);
      for (const g of e.gates) {
        console.log(`        ${g.ok ? '✅' : '❌'} ${g.name} ${g.label} — ${g.details}`);
      }
      break;
    case 'reviewer.verdict':
      console.log(`[${ts}] 👨‍⚖️ reviewer: ${e.approved ? 'APPROVED' : 'CHANGES REQUESTED'}`);
      const counts = countByStatus(e.criterionResults);
      console.log(
        `        ${counts.met} met / ${counts.partial} partial / ${counts.unmet} unmet of ${e.criterionResults.length}`,
      );
      console.log(`        comments: ${e.comments}`);
      break;
    case 'budget.tick':
      console.log(
        `[${ts}] 💰 cost=$${e.costUsd.toFixed(4)} turns=${e.turns} duration=${(e.durationMs / 1000).toFixed(1)}s`,
      );
      break;
    case 'error':
      console.log(`[${ts}] ❌ ERROR in ${e.where}: ${e.message}`);
      break;
    case 'run.end':
      console.log(`[${ts}] 🏁 RUN END — outcome: ${e.outcome}`);
      if (e.prUrl) console.log(`        PR: ${e.prUrl}`);
      if (e.reason) console.log(`        reason: ${e.reason}`);
      console.log('');
      break;
    default:
      assertNever(e);
  }
}

function countByStatus(items: Array<{ status: 'met' | 'partial' | 'unmet' }>) {
  return items.reduce(
    (acc, i) => ({ ...acc, [i.status]: acc[i.status] + 1 }),
    { met: 0, partial: 0, unmet: 0 },
  );
}

main();
