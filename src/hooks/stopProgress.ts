import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Stop hook — stuck-loop detection.
 *
 * Fires when the agent decides to stop (either because it thinks it's done
 * or because nothing remains to do). We compute a hash of `git diff` of the
 * agent's worktree and compare it to the hash from the previous Stop event.
 *
 * Behaviour:
 *
 * - **First stuck strike** (same diff hash as last time): return
 *   `{ decision: 'block', reason: ... }`. The SDK passes the reason back
 *   to the agent, which gets one more turn to make progress or articulate
 *   what's blocking it. Forcing a verbal summary often unsticks the loop.
 *
 * - **Second stuck strike**: allow the stop, but invoke `onStuck(2)` so the
 *   harness knows to escalate the resulting PR to draft with reason
 *   `stuck-loop`. We don't try to second-block the agent — at that point the
 *   agent has demonstrated it has nothing more to add.
 *
 * - **Diff changed** since last Stop: reset the counter. We only flag
 *   loops where the agent made literally zero changes between attempts.
 *
 * Why hash the diff and not just count tool calls: an agent that reads the
 * same files in a loop without writing anything is the *exact* failure mode
 * we want to catch. Tool-call counting would let "100 reads then stop"
 * pass; a stable diff hash catches it on the second iteration.
 */
export interface StopProgressOpts {
  /** Absolute path to the git worktree the agent is operating in. */
  worktreePath: string;
  /**
   * Called when the stuck counter increments. Use this to record the event
   * in the run log and to influence the run's escalation flag.
   */
  onStuck?: (info: { strike: 1 | 2; diffHash: string }) => void;
}

export function createStopProgressHook(opts: StopProgressOpts): HookCallback {
  let prevHash: string | null = null;
  let stuckCount = 0;

  return async (input) => {
    if (input.hook_event_name !== 'Stop') return {};

    const diffHash = computeDiffHash(opts.worktreePath);

    if (prevHash === null) {
      // First Stop of the run — record the baseline and let it stop.
      prevHash = diffHash;
      return {};
    }

    if (diffHash === prevHash) {
      stuckCount++;
      const strike = stuckCount as 1 | 2;
      opts.onStuck?.({ strike, diffHash });
      if (stuckCount === 1) {
        return {
          decision: 'block',
          reason:
            'The harness has detected zero diff progress since your last Stop. Before stopping again, do ONE of the following: (1) make a concrete change toward the unmet acceptance criteria, OR (2) explicitly summarize what you tried, what is blocking you, and what you would need to proceed. Then call `mcp__harness__run_gates` to re-check.',
        };
      }
      // Second strike — let stop happen, the harness will escalate.
      return {};
    }

    // Diff moved → progress was made; reset.
    prevHash = diffHash;
    stuckCount = 0;
    return {};
  };
}

function computeDiffHash(worktreePath: string): string {
  try {
    const out = execFileSync('git', ['diff', 'HEAD', '--'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!out) return 'empty';
    return createHash('sha256').update(out).digest('hex').slice(0, 16);
  } catch {
    return 'error';
  }
}
