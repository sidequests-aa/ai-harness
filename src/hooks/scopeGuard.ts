import { isAbsolute, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Scope-guard PreToolUse hook (G5).
 *
 * Denies any Write/Edit whose target path is outside the ticket's
 * `fileScope` allowlist, and any Bash command that *looks like* it would
 * touch out-of-scope files (rm/mv/cp/git checkout/etc with explicit paths).
 *
 * The reason string is what the agent sees as the "tool result," so it
 * doubles as a hint about how to recover. We tell the agent it can call
 * `request_scope_expansion` (a custom tool added in Phase 4) to record an
 * out-of-scope desire without actually expanding scope — that desire shows
 * up in the PR description for the human reviewer.
 */
export interface ScopeGuardOpts {
  /** Absolute path to the agent's CWD (the seed root inside the worktree). */
  agentCwd: string;
  /**
   * Glob patterns the agent is allowed to write to. Patterns are interpreted
   * relative to `agentCwd`.
   */
  fileScope: string[];
  /**
   * Optional callback fired whenever the guard denies a tool call.
   * The pipeline uses this to surface "out-of-scope requests" in the PR
   * description and to feed the stuck/escalation detector.
   */
  onDeny?: (info: { tool: string; reason: string; targetPath?: string; command?: string }) => void;
}

export function createScopeGuardHook(opts: ScopeGuardOpts): HookCallback {
  const matchers = opts.fileScope.map((p) => picomatch(p, { dot: true }));
  const isInScope = (relPosix: string) => matchers.some((m) => m(relPosix));

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const tool = input.tool_name;
    const ti = (input.tool_input ?? {}) as Record<string, unknown>;

    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      const filePath = (ti.file_path as string | undefined) ?? (ti.notebook_path as string | undefined);
      if (!filePath) return {};

      const rel = toRelPosix(opts.agentCwd, filePath);
      if (rel === null) {
        return deny(
          opts,
          tool,
          filePath,
          undefined,
          `File path "${filePath}" is outside the agent's working directory and therefore outside the ticket's file scope.`,
        );
      }
      if (!isInScope(rel)) {
        return deny(
          opts,
          tool,
          filePath,
          undefined,
          `Write to "${rel}" was blocked by the harness scope-guard. The ticket's File Scope is:\n${opts.fileScope.map((p) => `  - ${p}`).join('\n')}\n\nIf you genuinely need this file expanded into scope, call \`request_scope_expansion\` (which records the request for the human reviewer without actually granting access). Otherwise, find a way to satisfy the acceptance criteria within the existing scope.`,
        );
      }
      return {};
    }

    if (tool === 'Bash') {
      const cmd = (ti.command as string | undefined) ?? '';
      const violation = inspectBashForScope(cmd, opts.agentCwd, isInScope);
      if (violation) {
        return deny(opts, tool, undefined, cmd, violation);
      }
      return {};
    }

    return {};
  };
}

/** Convert any file path to a POSIX path relative to `cwd`, or null if outside. */
function toRelPosix(cwd: string, p: string): string | null {
  const absTarget = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), absTarget).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Heuristic Bash inspection: scan for commands that mutate paths and ensure
 * the paths they reference are inside scope. Conservative — when in doubt,
 * we deny and let the agent rephrase.
 *
 * This is not a real shell parser. It catches the obvious failure modes
 * (rm/mv/cp/git checkout against an explicit path) and lets read-only
 * commands through. Phase 5 can replace it with `shell-parse` if we hit
 * false positives.
 */
function inspectBashForScope(
  cmd: string,
  cwd: string,
  isInScope: (relPosix: string) => boolean,
): string | null {
  // Strip shell line continuations and split on `&&`/`||`/`;`/newline so
  // each subcommand is checked independently.
  const subcommands = cmd
    .replace(/\\\n/g, ' ')
    .split(/(?:&&|\|\||;|\n)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sub of subcommands) {
    // Tokenize naively; preserves quoted strings well enough for our needs.
    const tokens = sub.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (tokens.length === 0) continue;
    const argv0 = tokens[0]!.replace(/^['"]|['"]$/g, '');
    const args = tokens.slice(1).map((t) => t.replace(/^['"]|['"]$/g, ''));

    // Mutating commands that take paths.
    if (
      argv0 === 'rm' ||
      argv0 === 'mv' ||
      argv0 === 'cp' ||
      argv0 === 'rmdir' ||
      argv0 === 'rsync' ||
      argv0 === 'find' && args.includes('-delete')
    ) {
      for (const a of args) {
        if (a.startsWith('-')) continue;
        const rel = toRelPosix(cwd, a);
        if (rel === null || !isInScope(rel)) {
          return `Bash command "${argv0}" targets "${a}" which is outside the ticket's file scope.`;
        }
      }
      continue;
    }

    // git mutating subcommands — block any that would discard work or
    // touch tracked files. The agent gets to use git status / log / diff
    // freely; everything else needs scrutiny.
    if (argv0 === 'git') {
      const sub1 = args[0];
      const dangerous = new Set([
        'reset',
        'restore',
        'checkout',
        'rm',
        'mv',
        'clean',
        'commit',
        'push',
        'rebase',
        'merge',
        'cherry-pick',
      ]);
      if (sub1 && dangerous.has(sub1)) {
        return `Bash command "git ${sub1}" was blocked. The harness manages git state — the agent should only use \`git status\`, \`git diff\`, and \`git log\`.`;
      }
      continue;
    }

    // Package manager mutations — block. The harness pre-installs deps in
    // the worktree before the agent starts. Adding deps mid-run is out of
    // scope unless the ticket explicitly says so.
    if ((argv0 === 'npm' || argv0 === 'pnpm' || argv0 === 'yarn') && args[0]) {
      const sub1 = args[0];
      const dangerous = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade']);
      if (dangerous.has(sub1)) {
        return `Bash command "${argv0} ${sub1}" was blocked. The harness pre-installs dependencies in the worktree before the agent starts; adding new dependencies mid-run is outside scope. If you truly need a new package, call \`request_scope_expansion\`.`;
      }
      continue;
    }
  }

  return null;
}

function deny(
  opts: ScopeGuardOpts,
  tool: string,
  targetPath: string | undefined,
  command: string | undefined,
  reason: string,
) {
  opts.onDeny?.({ tool, reason, ...(targetPath ? { targetPath } : {}), ...(command ? { command } : {}) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}
