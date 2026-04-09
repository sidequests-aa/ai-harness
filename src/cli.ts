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
import { randomUUID } from 'node:crypto';
import { parseTicket } from './parseTicket';
import { runAgent } from './runAgent';
import {
  commitAll,
  createWorktree,
  diffVsBase,
  hasChanges,
  pushBranch,
} from './git';
import { GitHubClient } from './github';
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

  const runId = randomUUID().slice(0, 8);
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

  // eslint-disable-next-line no-console
  console.log(
    `[stage 1] parsed: title="${ticket.title}", subtasks=${ticket.subTasks.length}, ` +
      `acs=${ticket.acceptanceCriteria.length}, scope=${ticket.fileScope.length} globs, ` +
      `budget=$${ticket.budgets.maxCostUSD}/${ticket.budgets.maxTurns}turns`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 2: (stub) Plan = identity transform of ticket sub-tasks
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`[stage 2] plan: ${state.plan!.subTasks.map((t) => t.id).join(' → ')} (stub)`);

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3: (stub) Context assembly — Phase 2 will inject curated packs.
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('[stage 3] context: (stub — Phase 2 will inject curated packs + repo map)');

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

  const result = await runAgent({
    ticket,
    cwd: agentCwd,
    ...(process.env.HARNESS_MODEL ? { model: process.env.HARNESS_MODEL } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[stage 4] agent done: ok=${result.ok} turns=${result.numTurns} ` +
      `cost=$${result.totalCostUsd.toFixed(4)} duration=${(result.durationMs / 1000).toFixed(1)}s`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 5: (stub) Quality gates — Phase 3 will run the 11-gate ladder.
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('[stage 5] gates: (stub — Phase 3 will run the 11-gate ladder)');

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 6: (stub) Reviewer subagent — Phase 4.
  // ─────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('[stage 6] reviewer: (stub — Phase 4 will spawn a read-only reviewer subagent)');

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 7: Open PR (or print diff if --no-pr / no PAT)
  // ─────────────────────────────────────────────────────────────────────────
  state.producedChanges = hasChanges(wt.path);
  if (!state.producedChanges) {
    // eslint-disable-next-line no-console
    console.log('[stage 7] no changes in worktree — nothing to commit. Run complete.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log('[stage 7] worktree has changes — committing');
  commitAll(wt.path, `harness(${runId}): ${ticket.title}`);

  if (args.noPr || !process.env.GH_PAT) {
    const reason = args.noPr ? '--no-pr flag' : 'GH_PAT not set';
    // eslint-disable-next-line no-console
    console.log(`[stage 7] skipping PR creation (${reason})`);
    // eslint-disable-next-line no-console
    console.log(`[stage 7] worktree branch: ${branch} at ${wt.path}`);
    // eslint-disable-next-line no-console
    console.log('[stage 7] diff vs base:');
    process.stdout.write(diffVsBase(wt.path, args.base));
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
  const prBody = buildSimplePrBody(state, result);
  // eslint-disable-next-line no-console
  console.log(`[stage 7] opening PR on ${owner}/${repo}`);
  const url = await gh.openPr({
    coords: { owner, repo },
    branch,
    baseBranch: args.base,
    title: `[harness] ${ticket.title}`,
    body: prBody,
  });
  state.prUrl = url;
  // eslint-disable-next-line no-console
  console.log(`[stage 7] PR opened: ${url}`);
}

function buildSimplePrBody(state: RunState, result: { numTurns: number; totalCostUsd: number; durationMs: number; ok: boolean; finalText: string }): string {
  // Phase 1 PR body. Phases 4-5 replace this with the structured run report
  // including gate results, AC verdict, and the full transcript.
  return `# Harness Run (Phase 1 skeleton)

**Run ID**: \`${state.runId}\`
**Status**: ${result.ok ? 'agent reported success' : 'agent reported error'}
**Turns**: ${result.numTurns}
**Cost**: $${result.totalCostUsd.toFixed(4)}
**Wall**: ${(result.durationMs / 1000).toFixed(1)}s

## Ticket
**${state.ticket.title}**

${state.ticket.summary}

## Sub-tasks (from ticket)
${state.ticket.subTasks.map((t) => `- \`${t.id}\` ${t.title}`).join('\n')}

## Agent's final summary
${result.finalText || '_(no summary returned)_'}

---
*This PR was opened by intrahealth-harness Phase 1 skeleton. No quality gates, hooks, or
reviewer subagent ran — those are added in Phases 2–5.*
`;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[harness] fatal:', err);
  process.exit(1);
});
