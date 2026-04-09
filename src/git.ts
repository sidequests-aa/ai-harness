import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal git helpers used by Phase 1. We shell out to `git` instead of
 * pulling in a JS git library — `git worktree` is the load-bearing
 * primitive and the CLI is the canonical implementation.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
}

interface CreateWorktreeOpts {
  /** Absolute path to the target repo root (the seed repo). */
  targetRepo: string;
  /** Branch name to create. */
  branch: string;
  /** Base branch to fork from. Defaults to `main`. */
  baseBranch?: string;
  /** Where to put the worktree. Defaults to a sibling `<repo>-worktrees/<branch>`. */
  worktreeRoot?: string;
}

/**
 * Create an isolated git worktree off `baseBranch` so the agent's writes
 * don't pollute the user's checkout. Returns the absolute worktree path.
 *
 * If a stale worktree at the same path already exists it is removed first.
 */
export function createWorktree({
  targetRepo,
  branch,
  baseBranch = 'main',
  worktreeRoot,
}: CreateWorktreeOpts): WorktreeInfo {
  const repoAbs = resolve(targetRepo);
  const root = worktreeRoot ?? resolve(repoAbs, '..', '.harness-worktrees');
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const path = resolve(root, branch.replace(/[\/\\]/g, '__'));

  // Clean up any prior worktree at the same path.
  if (existsSync(path)) {
    try {
      git(repoAbs, ['worktree', 'remove', '--force', path]);
    } catch {
      // Worktree wasn't tracked by git — fall back to plain rmrf.
    }
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }

  // Also nuke any stale ref by the same name (in case a previous run failed
  // before we could remove it). `branch -D` errors if the branch doesn't
  // exist; swallow that.
  try {
    git(repoAbs, ['branch', '-D', branch]);
  } catch {
    // ok
  }

  git(repoAbs, ['worktree', 'add', '-b', branch, path, baseBranch]);

  return { path, branch, baseBranch };
}

/** True if the worktree has any uncommitted/staged changes vs HEAD. */
export function hasChanges(worktreePath: string): boolean {
  const out = git(worktreePath, ['status', '--porcelain']).trim();
  return out.length > 0;
}

/** Stage everything and commit with the given message. */
export function commitAll(worktreePath: string, message: string): void {
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '-m', message]);
}

/** Push the branch to `origin` with the upstream set. */
export function pushBranch(worktreePath: string, branch: string): void {
  git(worktreePath, ['push', '-u', 'origin', branch]);
}

/** Get the most recent commit SHA in the worktree. */
export function headSha(worktreePath: string): string {
  return git(worktreePath, ['rev-parse', 'HEAD']).trim();
}

/** Get the diff of the worktree vs the base branch, as a unified diff string. */
export function diffVsBase(worktreePath: string, baseBranch: string): string {
  return git(worktreePath, ['diff', baseBranch, '--']);
}

/** Run a git command in the given cwd. Throws on non-zero exit. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
