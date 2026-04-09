import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { loadPacks, renderPacks, type LoadPacksResult } from './contextPacks';
import { buildRepoMap, renderRepoMap } from './repoMap';
import type { Ticket } from './types';

export interface AgentRunResult {
  /** Number of turns the agent took. */
  numTurns: number;
  /** Total cost in USD reported by the SDK in the final ResultMessage. */
  totalCostUsd: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Final result text the agent returned (if any). */
  finalText: string;
  /** True if the SDK reported a successful (non-error) result subtype. */
  ok: boolean;
}

interface RunAgentOpts {
  ticket: Ticket;
  /**
   * Absolute path the agent should run inside. Usually the seed subfolder of
   * the harness's worktree (so the agent's `npm test` runs in the seed root)
   * but can be the worktree root for repos without a seed subdir.
   */
  cwd: string;
  /**
   * Absolute path to the directory containing curated context packs.
   * Defaults to `<harness-root>/context-packs/medplum`.
   */
  packsDir: string;
  /**
   * Absolute path to the directory the repo map indexes (usually the seed's
   * `src/` directory inside the agent's worktree).
   */
  repoMapRoot: string;
  /** Optional model override (e.g. 'claude-haiku-4-5' for cheap dev runs). */
  model?: string;
}

/**
 * Phase 1: thinnest possible agent invocation.
 *
 * Wraps the Claude Agent SDK `query()` with:
 * - a minimal system prompt that frames the job
 * - the ticket markdown as the user prompt
 * - native tools (Read, Write, Edit, Glob, Grep, Bash) only — no custom MCP
 *   tools, no hooks, no subagents (those land in Phases 2-4)
 * - the worktree as cwd
 * - permissionMode `acceptEdits` so writes don't block on prompts
 * - maxTurns from the ticket's budget
 *
 * Streams messages to stdout as they arrive. Returns a summary at the end.
 */
export async function runAgent({
  ticket,
  cwd,
  packsDir,
  repoMapRoot,
  model,
}: RunAgentOpts): Promise<AgentRunResult> {
  const start = Date.now();

  // ── Layer A: curated context packs (eager) ───────────────────────────────
  const packsResult = loadPacks(packsDir, ticket.contextPacks);
  // eslint-disable-next-line no-console
  console.log(
    `[context] loaded ${packsResult.packs.length}/${ticket.contextPacks.length} packs ` +
      `(${packsResult.totalChars} chars)` +
      (packsResult.missing.length > 0 ? `, missing: ${packsResult.missing.join(', ')}` : ''),
  );

  // ── Layer B: repo map (eager, compact) ───────────────────────────────────
  const repoMap = buildRepoMap(repoMapRoot);
  // eslint-disable-next-line no-console
  console.log(`[context] indexed ${repoMap.files.length} files via ts-morph`);

  const systemPrompt = buildSystemPrompt(ticket, packsResult, renderRepoMap(repoMap));

  let numTurns = 0;
  let totalCostUsd = 0;
  let finalText = '';
  let ok = false;

  // eslint-disable-next-line no-console
  console.log(`[agent] starting in ${cwd}`);
  // eslint-disable-next-line no-console
  console.log(`[agent] model=${model ?? 'default'} maxTurns=${ticket.budgets.maxTurns}`);

  for await (const message of query({
    prompt: ticket.raw,
    options: {
      cwd,
      systemPrompt,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'acceptEdits',
      maxTurns: ticket.budgets.maxTurns,
      ...(model ? { model } : {}),
    },
  })) {
    // Discriminate on message.type — every shape we care about lives there.
    // We deliberately don't import the SDK's Message types in Phase 1 because
    // their shape is still moving; we narrow at use-sites instead.
    const m = message as Record<string, unknown> & { type: string };

    if (m.type === 'assistant') {
      numTurns++;
      const content = (m as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            const b = block as { type?: string; text?: string; name?: string };
            if (b.type === 'text' && b.text) {
              process.stdout.write(`[agent] ${truncate(b.text, 240)}\n`);
            } else if (b.type === 'tool_use' && b.name) {
              process.stdout.write(`[agent] → tool ${b.name}\n`);
            }
          }
        }
      }
    } else if (m.type === 'result') {
      const r = m as {
        subtype?: string;
        result?: string;
        total_cost_usd?: number;
        num_turns?: number;
      };
      ok = r.subtype === 'success';
      totalCostUsd = r.total_cost_usd ?? 0;
      finalText = r.result ?? '';
      if (typeof r.num_turns === 'number') numTurns = r.num_turns;
      // eslint-disable-next-line no-console
      console.log(
        `[agent] result subtype=${r.subtype} turns=${r.num_turns} cost=$${totalCostUsd.toFixed(4)}`,
      );
    }
  }

  return {
    numTurns,
    totalCostUsd,
    durationMs: Date.now() - start,
    finalText,
    ok,
  };
}

function buildSystemPrompt(
  ticket: Ticket,
  packs: LoadPacksResult,
  repoMapRendered: string,
): string {
  return `You are an AI engineer working on a TypeScript + React + Vite project (the seed
target inside an AI engineering harness's monorepo).

Your job is to satisfy **every** acceptance criterion in the ticket below. The placeholder
component currently throws on render — your task is to replace it with a real implementation.

## Constraints

- Only modify files inside the **File Scope** listed in the ticket. Do not touch anything
  outside that scope (no edits to App.tsx, main.tsx, vite.config.ts, package.json,
  vitest.setup.ts, etc.). The vitest setup file already includes the matchMedia polyfill
  Mantine needs — you don't need to add it.
- The component must be exported as both a named export and a default export from
  \`src/components/InteractionReviewPanel/InteractionReviewPanel.tsx\`. The
  \`src/components/InteractionReviewPanel/index.ts\` re-export already exists.
- Tests use **vitest** + **@testing-library/react** + **@medplum/mock**. Run them with
  \`npm test\` (from this directory, which is the seed root) to verify your work.
- The Drug Interaction API is **injected**, not imported. Define the interface at
  \`src/types/drugInteractionApi.ts\` and accept it via props or React context.
- Use \`@mantine/core\` UI primitives where they exist (Alert, Badge, Button, Stack) — they
  are already a dependency via @medplum/react.
- Every visual state must have a \`data-testid="state-<name>"\` attribute so the harness's
  visual-state coverage gate (a grep-based check) can find them. The five state names are:
  \`loading\`, \`no-interactions\`, \`minor\`, \`critical\`, \`api-error\`.

## Workflow

1. Read the existing placeholder and tests so you understand the starting state.
2. Define the DrugInteractionApi interface first (sub-task ST1).
3. Implement the component, then the tests.
4. Run \`npm test\` and iterate until **every** test passes.
5. When complete, write a brief summary of what changed and why.

You have access to: Read, Write, Edit, Glob, Grep, Bash. Use Bash for \`npm test\` and
similar verification commands. The current working directory is the seed root inside the
harness's worktree.

## Curated context (Layer A — packs)

The ticket opted into ${packs.packs.length} context pack(s). These are the patterns and
gotchas the harness considers load-bearing for this kind of work. Treat them as
authoritative for *this* codebase — don't apply generic React or Medplum advice that
contradicts them.

${renderPacks(packs.packs)}

## Repo map (Layer B — compact structural index)

Every \`.ts/.tsx\` file under \`src/\` and the symbols it exports. Use this to navigate
without burning turns on \`Glob\`/\`Grep\`. If a symbol isn't here, it doesn't exist.

${repoMapRendered}

## The ticket

The ticket markdown follows in the user message.`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
