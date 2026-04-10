#!/usr/bin/env tsx
/**
 * intrahealth-harness CLI — Phase 1 skeleton.
 *
 * Reads a ticket markdown file, runs the Claude Agent SDK in an isolated git
 * worktree of the harness repo, and (if a GitHub PAT is configured) pushes
 * the branch and opens a PR. Phase 1 has no quality gates, no hooks, no
 * reviewer subagent — those land in Phases 2-5.
 *
 * The harness and the seed it builds against live in a single repo:
 *   intrahealth-harness/        ← this repo, the deliverable
 *   ├── src/                    ← harness source (the orchestrator)
 *   ├── seed/                   ← target the agent operates inside
 *   └── tickets/                ← work orders the harness consumes
 *
 * Usage (run from intrahealth-harness/):
 *   npm run harness -- run \\
 *     --target ./seed \\
 *     --ticket ./tickets/001-interaction-review-panel.md
 *
 * Optional flags:
 *   --no-pr   Skip the push + PR-creation step (local-only run for iteration)
 *   --owner   GitHub owner (defaults to env HARNESS_TARGET_OWNER)
 *   --repo    GitHub repo (defaults to env HARNESS_TARGET_REPO)
 *   --base    Base branch for the worktree + PR (default: main)
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTicket } from './parseTicket';
import { runAgent } from './runAgent';
import { runReviewer } from './runReviewer';
import {
  commitAll,
  createWorktree,
  diffVsBase,
  hasChanges,
  pushBranch,
} from './git';
import { GitHubClient } from './github';
import { newRunId, RunLogger } from './observability/logger';
import { buildPrBody, buildPrTitle } from './observability/runReport';
import type { RunState } from './types';

interface CliArgs {
  command: 'run';
  /** Path to the git repo root (the harness repo). Defaults to '.'. */
  target: string;
  /** Subdir within the worktree the agent runs inside. Defaults to 'seed'. */
  cwdSubdir: string;
  /** Path to the ticket markdown file. */
  ticket: string;
  noPr: boolean;
  owner: string | undefined;
  repo: string | undefined;
  base: string;
}

function parseArgs(argv: string[]): CliArgs {
  let target = '.';
  let cwdSubdir = 'seed';
  let ticket: string | undefined;
  let owner: string | undefined;
  let repo: string | undefined;
  let noPr = false;
  let base = 'main';

  if (argv[0] !== 'run') {
    fail(`Unknown command: ${argv[0] ?? '(none)'}. Expected: run`);
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--target':
        target = requireNext(argv, ++i, '--target');
        break;
      case '--cwd-subdir':
        cwdSubdir = requireNext(argv, ++i, '--cwd-subdir');
        break;
      case '--ticket':
        ticket = requireNext(argv, ++i, '--ticket');
        break;
      case '--no-pr':
        noPr = true;
        break;
      case '--owner':
        owner = requireNext(argv, ++i, '--owner');
        break;
      case '--repo':
        repo = requireNext(argv, ++i, '--repo');
        break;
      case '--base':
        base = requireNext(argv, ++i, '--base');
        break;
      default:
        fail(`Unknown flag: ${a}`);
    }
  }
  if (!ticket) fail('Missing required --ticket <path-to-ticket-md>');
  return { command: 'run', target, cwdSubdir, ticket, noPr, owner, repo, base };
}

function requireNext(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) fail(`Flag ${flag} requires a value`);
  return v;
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`[harness] ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 1: Parse ticket
  // ─────────────────────────────────────────────────────────────────────────
  const ticketPath = resolve(args.ticket);
  // eslint-disable-next-line no-console
  console.log(`[stage 1] parsing ticket from ${ticketPath}`);
  const ticket = parseTicket(ticketPath);

  const runId = newRunId();
  const harnessRoot = process.cwd();
  const logger = new RunLogger(resolve(harnessRoot, 'runs'), runId);
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const branch = `harness/${runId}-${slug}`;

  const state: RunState = {
    runId,
    ticket,
    plan: { subTasks: ticket.subTasks },
    branchName: branch,
  };

  logger.log({
    t: 'run.start',
    ticketTitle: ticket.title,
    ticketPath,
    branch,
    model: process.env.HARNESS_MODEL,
  });
  logger.transcript(`**Ticket**: ${ticket.title}`);
  logger.transcript(`**Branch**: \`${branch}\``);
  logger.transcript('');

  // eslint-disable-next-line no-console
  console.log(`[run] id=${runId}`);
  // eslint-disable-next-line no-console
  console.log(`[run] log dir: runs/${runId}/`);
  // eslint-disable-next-line no-console
  console.log(
    `[stage 1] parsed: title="${ticket.title}", subtasks=${ticket.subTasks.length}, ` +
      `acs=${ticket.acceptanceCriteria.length}, scope=${ticket.fileScope.length} globs, ` +
      `budget=$${ticket.budgets.maxCostUSD}/${ticket.budgets.maxTurns}turns`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 2: Plan — identity transform of the ticket's sub-tasks (the
  // human-authored DAG is the plan; a future planner subagent could refine
  // it into file-level work items).
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`[stage 2] plan: ${state.plan!.subTasks.map((t) => t.id).join(' → ')}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3: Context assembly — runs inside runAgent so the worktree exists.
  // The actual loadPacks + buildRepoMap calls happen there; this log line
  // marks the boundary.
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('[stage 3] context: (assembled inside runAgent — see [context] lines below)');

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 4: Execute — create worktree and run the agent inside it
  // ─────────────────────────────────────────────────────────────────────────
  const targetRepo = resolve(args.target);
  // eslint-disable-next-line no-console
  console.log(`[stage 4] creating worktree of ${targetRepo} on branch ${branch}`);
  const wt = createWorktree({ targetRepo, branch, baseBranch: args.base });
  state.worktreePath = wt.path;

  // The agent's cwd is the seed subdir within the worktree (defaults to "seed").
  // This is what makes a single-repo monorepo work: git worktrees operate at
  // the repo level but the agent only sees / operates inside seed/.
  const agentCwd = args.cwdSubdir ? resolve(wt.path, args.cwdSubdir) : wt.path;
  // eslint-disable-next-line no-console
  console.log(`[stage 4] worktree: ${wt.path}`);
  // eslint-disable-next-line no-console
  console.log(`[stage 4] agent cwd: ${agentCwd}`);

  // Warm up the worktree: node_modules isn't tracked, so the fresh worktree
  // has no installed deps. Run a fast offline install so the agent can run
  // `npm test` immediately instead of thrashing on missing modules. Cache
  // is already populated from the source seed install, so this is quick.
  if (existsSync(resolve(agentCwd, 'package.json'))) {
    // eslint-disable-next-line no-console
    console.log('[stage 4] warming worktree: npm install --prefer-offline --no-audit --no-fund');
    try {
      execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
        cwd: agentCwd,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    } catch (err) {
      fail(`npm install in worktree failed: ${(err as Error).message}`);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    fail('ANTHROPIC_API_KEY is not set in the environment (.env). Aborting before agent run.');
  }

  // Resolve context paths. Packs are read from the harness checkout (NOT
  // the worktree — packs are part of the orchestrator, not the target).
  // The repo map is built from the worktree's seed/src so it reflects the
  // exact files the agent will be editing.
  const packsDir = resolve(harnessRoot, 'context-packs', 'medplum');
  const repoMapRoot = resolve(agentCwd, 'src');

  logger.log({ t: 'stage.enter', stage: 'execute' });
  const stage4Start = Date.now();
  const result = await runAgent({
    ticket,
    cwd: agentCwd,
    worktreePath: wt.path,
    packsDir,
    repoMapRoot,
    ...(process.env.HARNESS_MODEL ? { model: process.env.HARNESS_MODEL } : {}),
  });
  logger.log({
    t: 'stage.exit',
    stage: 'execute',
    durationMs: Date.now() - stage4Start,
    ok: result.ok,
  });
  logger.log({
    t: 'budget.tick',
    costUsd: result.totalCostUsd,
    turns: result.numTurns,
    durationMs: result.durationMs,
  });
  if (result.finalGateResult) {
    logger.log({
      t: 'gate.result',
      invocation: result.gateInvocations,
      ok: result.finalGateResult.ok,
      gates: result.finalGateResult.gates,
    });
  }
  for (const d of result.hookEvents.scopeDenials) {
    logger.log({
      t: 'hook.deny',
      hook: 'scope-guard',
      reason: d.reason,
      ...(d.targetPath ? { targetPath: d.targetPath } : {}),
      ...(d.command ? { command: d.command } : {}),
    });
  }
  for (const d of result.hookEvents.importDenials) {
    logger.log({
      t: 'hook.deny',
      hook: 'import-audit',
      reason: d.reason,
      targetPath: d.filePath,
      specifier: d.specifier,
    });
  }
  for (const f of result.hookEvents.fastGateFailures) {
    logger.log({
      t: 'hook.fast-gate',
      filePath: f.filePath,
      gate: f.gate,
      output: f.output.slice(0, 1000),
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[stage 4] agent done: ok=${result.ok} turns=${result.numTurns} ` +
      `cost=$${result.totalCostUsd.toFixed(4)} duration=${(result.durationMs / 1000).toFixed(1)}s`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 5: Quality gates — already collected during stage 4 via the
  // run_gates MCP tool. Surfaced via result.finalGateResult.
  // ─────────────────────────────────────────────────────────────────────────
  if (result.finalGateResult) {
    // eslint-disable-next-line no-console
    console.log(
      `[stage 5] final gates: ${result.finalGateResult.ok ? 'PASS' : 'FAIL'} ` +
        `(${result.finalGateResult.gates.filter((g) => g.ok).length}/${result.finalGateResult.gates.length})`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('[stage 5] WARNING: agent did not invoke run_gates');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 6: Reviewer subagent (read-only LLM-as-judge on the AC checklist)
  // ─────────────────────────────────────────────────────────────────────────
  logger.log({ t: 'stage.enter', stage: 'review' });
  const stage6Start = Date.now();
  let reviewerVerdict: Awaited<ReturnType<typeof runReviewer>> | null = null;
  try {
    reviewerVerdict = await runReviewer({
      ticket,
      cwd: agentCwd,
      implementerSummary: result.finalText,
      ...(process.env.HARNESS_MODEL ? { model: process.env.HARNESS_MODEL } : {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stage 6] reviewer threw:', (err as Error).message);
    logger.log({
      t: 'error',
      where: 'stage 6 / runReviewer',
      message: (err as Error).message,
      ...((err as Error).stack ? { stack: (err as Error).stack as string } : {}),
    });
  }
  logger.log({
    t: 'stage.exit',
    stage: 'review',
    durationMs: Date.now() - stage6Start,
    ok: !!reviewerVerdict?.verdict,
  });
  if (reviewerVerdict?.verdict) {
    logger.log({
      t: 'reviewer.verdict',
      approved: reviewerVerdict.verdict.approved,
      criterionResults: reviewerVerdict.verdict.criterionResults,
      comments: reviewerVerdict.verdict.comments,
    });
    logger.writeJson('reviewer-verdict.json', reviewerVerdict.verdict);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 7: Open PR (or print diff if --no-pr / no PAT)
  // ─────────────────────────────────────────────────────────────────────────
  state.producedChanges = hasChanges(wt.path);
  if (!state.producedChanges) {
    // eslint-disable-next-line no-console
    console.log('[stage 7] no changes in worktree — nothing to commit. Run complete.');
    logger.log({ t: 'run.end', outcome: 'failed', reason: 'no changes produced by agent' });
    return;
  }

  // eslint-disable-next-line no-console
  console.log('[stage 7] worktree has changes — committing');
  commitAll(wt.path, `harness(${runId}): ${ticket.title}`);

  // Determine escalation status. The PR is "approved" only if every
  // failure-mode signal is clean. Each branch of the reason cascade matches
  // a specific failure mode the harness defends against — explicit signals,
  // not vibes.
  const costOver = result.totalCostUsd > ticket.budgets.maxCostUSD;
  const turnsOver = result.numTurns >= ticket.budgets.maxTurns;
  const wallOver = result.durationMs > ticket.budgets.maxWallSeconds * 1000;
  const stuckHard = result.hookEvents.stuckEvents.some((e) => e.strike >= 2);

  const approved =
    reviewerVerdict?.verdict?.approved === true &&
    (result.finalGateResult?.ok ?? false) &&
    result.hookEvents.scopeDenials.length === 0 &&
    result.hookEvents.importDenials.length === 0 &&
    !costOver &&
    !turnsOver &&
    !wallOver &&
    !stuckHard;

  const escalationReason = !approved
    ? !reviewerVerdict?.verdict
      ? 'no reviewer verdict'
      : !reviewerVerdict.verdict.approved
      ? 'reviewer requested changes'
      : !result.finalGateResult?.ok
      ? 'run_gates ladder failed or was not invoked'
      : result.hookEvents.scopeDenials.length > 0
      ? `${result.hookEvents.scopeDenials.length} scope-guard denials`
      : result.hookEvents.importDenials.length > 0
      ? `${result.hookEvents.importDenials.length} hallucinated imports caught`
      : costOver
      ? `cost $${result.totalCostUsd.toFixed(4)} exceeded budget $${ticket.budgets.maxCostUSD.toFixed(2)}`
      : turnsOver
      ? `turn budget exhausted (${result.numTurns}/${ticket.budgets.maxTurns})`
      : wallOver
      ? `wall budget exceeded (${(result.durationMs / 1000).toFixed(0)}s / ${ticket.budgets.maxWallSeconds}s)`
      : stuckHard
      ? 'stuck-loop (Stop hook detected zero diff progress over 2+ stop attempts)'
      : 'unknown'
    : undefined;

  const reportInput = {
    ticket,
    runId,
    branch,
    agentResult: result,
    reviewerVerdict: reviewerVerdict?.verdict ?? null,
    reviewerCostUsd: reviewerVerdict?.costUsd ?? 0,
    reviewerDurationMs: reviewerVerdict?.durationMs ?? 0,
    escalated: !approved,
    ...(escalationReason ? { escalationReason } : {}),
  };
  const prTitle = buildPrTitle(reportInput);
  const prBody = buildPrBody(reportInput);
  logger.writeJson('final-report.json', { prTitle, prBody, approved, escalationReason });

  if (args.noPr || !process.env.GH_PAT) {
    const reason = args.noPr ? '--no-pr flag' : 'GH_PAT not set';
    // eslint-disable-next-line no-console
    console.log(`[stage 7] skipping PR creation (${reason})`);
    // eslint-disable-next-line no-console
    console.log(`[stage 7] worktree branch: ${branch} at ${wt.path}`);
    // eslint-disable-next-line no-console
    console.log('[stage 7] would-be PR:');
    // eslint-disable-next-line no-console
    console.log(`  title: ${prTitle}`);
    // eslint-disable-next-line no-console
    console.log(`  body length: ${prBody.length} chars`);
    // eslint-disable-next-line no-console
    console.log('[stage 7] diff vs base (truncated):');
    process.stdout.write(diffVsBase(wt.path, args.base).slice(0, 4000));
    logger.log({ t: 'run.end', outcome: 'failed', reason: `${reason}` });
    return;
  }

  const owner = args.owner ?? process.env.HARNESS_TARGET_OWNER;
  const repo = args.repo ?? process.env.HARNESS_TARGET_REPO;
  if (!owner || !repo) {
    fail('PR creation requires --owner and --repo (or HARNESS_TARGET_OWNER/HARNESS_TARGET_REPO env).');
  }

  // eslint-disable-next-line no-console
  console.log(`[stage 7] pushing branch ${branch} to origin`);
  pushBranch(wt.path, branch);

  const gh = new GitHubClient(process.env.GH_PAT);
  // eslint-disable-next-line no-console
  console.log(`[stage 7] opening ${approved ? '' : 'DRAFT '}PR on ${owner}/${repo}`);
  const url = await gh.openPr({
    coords: { owner, repo },
    branch,
    baseBranch: args.base,
    title: prTitle,
    body: prBody,
    draft: !approved,
  });
  state.prUrl = url;
  logger.log({
    t: 'run.end',
    outcome: approved ? 'pr-opened' : 'escalated',
    prUrl: url,
    ...(escalationReason ? { reason: escalationReason } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`[stage 7] ${approved ? 'PR' : 'DRAFT escalation PR'} opened: ${url}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[harness] fatal:', err);
  process.exit(1);
});
