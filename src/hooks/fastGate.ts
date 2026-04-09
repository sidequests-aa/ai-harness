import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Post-write fast-gate hook (G1 prettier + G2 eslint).
 *
 * Runs each time the agent successfully writes or edits a TypeScript file.
 * If formatting or lint errors are present, the failure is fed back via the
 * `additionalContext` field — the agent sees it as part of the next turn's
 * input and self-corrects.
 *
 * What runs here:
 * - prettier --check on the touched file (~10ms)
 * - eslint on the touched file with `--max-warnings=0` (~100ms)
 *
 * What does NOT run here:
 * - tsc — too slow per-write (1-3s); runs once via the `run_gates` MCP tool
 * - vitest — too slow per-write; runs in `run_gates`
 *
 * The hook only operates on .ts/.tsx files inside the agent's CWD. Edits to
 * markdown, JSON, or anything outside CWD are passed through silently.
 */

export interface FastGateOpts {
  /** Absolute path to the agent's CWD (the seed root). */
  agentCwd: string;
  /** Called when the gate finds problems. Useful for run reports. */
  onFailure?: (info: { filePath: string; gate: 'prettier' | 'eslint'; output: string }) => void;
}

export function createFastGateHook(opts: FastGateOpts): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') return {};

    const ti = (input.tool_input ?? {}) as Record<string, unknown>;
    const filePath = ti.file_path as string | undefined;
    if (!filePath) return {};
    if (!/\.(ts|tsx)$/i.test(filePath)) return {};

    const absPath = resolve(filePath);
    if (!existsSync(absPath)) return {};

    const failures: string[] = [];

    // ── G1: prettier ──────────────────────────────────────────────────────
    const prettierResult = runQuiet('npx', ['prettier', '--check', absPath], opts.agentCwd);
    if (!prettierResult.ok) {
      opts.onFailure?.({ filePath, gate: 'prettier', output: prettierResult.output });
      failures.push(
        `❌ G1 prettier failed for \`${filePath}\`:\n\`\`\`\n${prettierResult.output.trim()}\n\`\`\`\nFix with: \`npx prettier --write ${filePath}\``,
      );
    }

    // ── G2: eslint ────────────────────────────────────────────────────────
    const eslintResult = runQuiet(
      'npx',
      ['eslint', '--max-warnings=0', '--no-error-on-unmatched-pattern', absPath],
      opts.agentCwd,
    );
    if (!eslintResult.ok) {
      opts.onFailure?.({ filePath, gate: 'eslint', output: eslintResult.output });
      failures.push(
        `❌ G2 eslint failed for \`${filePath}\`:\n\`\`\`\n${eslintResult.output.trim().slice(0, 2000)}\n\`\`\``,
      );
    }

    if (failures.length === 0) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: `[harness] G1 prettier ✓ G2 eslint ✓ on ${filePath}`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse' as const,
        additionalContext: failures.join('\n\n'),
      },
    };
  };
}

interface RunResult {
  ok: boolean;
  output: string;
}

function runQuiet(cmd: string, args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { ok: true, output: stdout };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '');
    return { ok: false, output: out || e.message || 'unknown error' };
  }
}
