import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadPacks, renderPacks, type LoadPacksResult } from './contextPacks';
import { buildRepoMap, renderRepoMap } from './repoMap';
import { buildHooks, createHookCollectors, type HookCollectors } from './hooks';
import { createRunGatesServer, type GateLadderResult } from './tools/runGates';
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
  /** Hook collectors with everything that fired during the run. */
  hookEvents: HookCollectors;
  /** Last gate-ladder result, if the agent ran run_gates at least once. */
  finalGateResult?: GateLadderResult;
  /** Number of times the agent invoked run_gates (proxy for self-correction). */
  gateInvocations: number;
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
  /**
   * Component subdir relative to `cwd`, used by the run_gates tool to scope
   * the API-contract check (G9) and visual-state coverage (G10). Defaults to
   * `src/components/InteractionReviewPanel`.
   */
  componentDir?: string;
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
  componentDir = 'src/components/InteractionReviewPanel',
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

  // ── Hooks (PreToolUse scope-guard + import-audit, PostToolUse fast-gate)
  const hookCollectors = createHookCollectors();
  const hooks = buildHooks({
    agentCwd: cwd,
    fileScope: ticket.fileScope,
    collectors: hookCollectors,
  });

  // ── Custom MCP tool: run_gates (G6-G10) ──────────────────────────────────
  const expectedStateTestids = [
    'state-loading',
    'state-no-interactions',
    'state-minor',
    'state-critical',
    'state-api-error',
  ];
  let finalGateResult: GateLadderResult | undefined;
  let gateInvocations = 0;
  const gatesServer = createRunGatesServer({
    agentCwd: cwd,
    expectedStateTestids,
    componentDir,
    onResult: (r) => {
      gateInvocations++;
      finalGateResult = r;
      // eslint-disable-next-line no-console
      console.log(
        `[gates] invocation #${gateInvocations} → ${r.ok ? 'ALL PASS' : 'FAILURES'} ` +
          `(${r.gates.filter((g) => g.ok).length}/${r.gates.length})`,
      );
    },
  });

  const systemPrompt = buildSystemPrompt(ticket, packsResult, renderRepoMap(repoMap));

  let numTurns = 0;
  let totalCostUsd = 0;
  let finalText = '';
  let ok = false;

  // eslint-disable-next-line no-console
  console.log(`[agent] starting in ${cwd}`);
  // eslint-disable-next-line no-console
  console.log(`[agent] model=${model ?? 'default'} maxTurns=${ticket.budgets.maxTurns}`);
  // eslint-disable-next-line no-console
  console.log(`[agent] hooks: PreToolUse(scope-guard, import-audit) + PostToolUse(fast-gate)`);
  // eslint-disable-next-line no-console
  console.log(`[agent] custom tools: mcp__harness__run_gates`);

  for await (const message of query({
    prompt: ticket.raw,
    options: {
      cwd,
      systemPrompt,
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'mcp__harness__run_gates',
      ],
      permissionMode: 'acceptEdits',
      maxTurns: ticket.budgets.maxTurns,
      hooks,
      mcpServers: { harness: gatesServer },
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

  // eslint-disable-next-line no-console
  console.log(
    `[agent] denials: scope=${hookCollectors.scopeDenials.length} ` +
      `import=${hookCollectors.importDenials.length} ` +
      `fastGate=${hookCollectors.fastGateFailures.length} ` +
      `gateInvocations=${gateInvocations}`,
  );

  return {
    numTurns,
    totalCostUsd,
    durationMs: Date.now() - start,
    finalText,
    ok,
    hookEvents: hookCollectors,
    ...(finalGateResult ? { finalGateResult } : {}),
    gateInvocations,
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
5. **You MUST call \`mcp__harness__run_gates\` before declaring your work complete.**
   This runs the harness quality-gate ladder (G6 vitest, G7 RTL smoke, G8 FHIR shape,
   G9 API gate contract, G10 visual-state coverage). If any gate fails, fix it and
   call \`run_gates\` again. Do not stop while any gate is failing.
6. When all gates pass, write a brief summary of what changed and why.

## Active hooks (the harness will block disallowed actions)

- **Scope-guard (PreToolUse)** — denies any Write/Edit outside the ticket's File Scope
  and any Bash command that mutates out-of-scope paths or calls
  \`npm install\`/\`git checkout\`/\`rm\`. If you need a file outside scope you must
  work around it; the harness will surface scope-expansion requests to the human reviewer.
- **Import-audit (PreToolUse)** — parses your .ts/.tsx writes with ts-morph and denies
  any import that references a package not in the seed's package.json or a relative
  path that does not resolve. Hallucinated imports are caught before the file is
  written.
- **Fast-gate (PostToolUse)** — runs prettier and eslint on every Write/Edit and feeds
  failures back to you in the next turn. Fix them inline, do not ignore.

You have access to: Read, Write, Edit, Glob, Grep, Bash, and the custom tool
\`mcp__harness__run_gates\`. Use Bash for \`npm test\` and other verification. The current
working directory is the seed root inside the harness's worktree.

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
