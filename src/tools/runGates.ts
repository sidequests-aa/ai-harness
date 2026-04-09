import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

/**
 * `run_gates` — the custom MCP tool the agent is instructed to call before
 * declaring its work complete. Runs the expensive end-of-pipeline gates
 * (G6-G10) and returns a structured pass/fail report the agent iterates
 * against.
 *
 * Why a custom tool and not just hooks: hooks fire on every Write/Edit and
 * are great for cheap, blocking checks; expensive checks (vitest, RTL,
 * shape validation, coverage scan) need to run *once* against the final
 * state of the worktree. The agent calling `run_gates` itself produces a
 * clean "I think I'm done — am I?" semantic the harness can observe.
 */

export interface RunGatesContext {
  /** Absolute path to the seed root (the agent's CWD). */
  agentCwd: string;
  /** The five visual-state testids the visual-state coverage gate enforces. */
  expectedStateTestids: string[];
  /** Glob-style file scope from the ticket — used by G9 to find the component file. */
  componentDir: string;
  /** Called once per gate run with the structured result for observability. */
  onResult?: (result: GateLadderResult) => void;
}

export type GateName = 'G6' | 'G7' | 'G8' | 'G9' | 'G10';

export interface GateResult {
  name: GateName;
  label: string;
  ok: boolean;
  /** Short human-readable summary. */
  details: string;
}

export interface GateLadderResult {
  ok: boolean;
  gates: GateResult[];
}

/**
 * Build the in-process MCP server containing the `run_gates` tool. The
 * returned config object is dropped into `ClaudeAgentOptions.mcpServers`.
 *
 * The tool's display name is `mcp__harness__run_gates` (the SDK prefixes
 * custom tools with `mcp__<server-name>__`); the implementer's system
 * prompt must reference it by that fully qualified name.
 */
export function createRunGatesServer(ctx: RunGatesContext) {
  const runGates = tool(
    'run_gates',
    'Run the harness quality-gate ladder (G6 vitest, G7 RTL smoke, G8 FHIR shape, G9 API gate contract, G10 visual-state coverage) against the current state of the worktree. Returns a pass/fail report. You MUST call this before declaring your work complete and you MUST iterate until it returns ok:true.',
    {
      // No input args — gates run against the worktree as-is.
      reason: z
        .string()
        .optional()
        .describe('Optional one-line reason you are running gates now (for logs).'),
    },
    async (_args, _extra) => {
      const ladder = runLadder(ctx);
      ctx.onResult?.(ladder);

      const lines: string[] = [];
      lines.push(`# run_gates result — ${ladder.ok ? 'ALL PASS ✓' : 'FAILURES ✗'}`);
      lines.push('');
      for (const g of ladder.gates) {
        lines.push(`- **${g.name}** ${g.label}: ${g.ok ? '✅ pass' : '❌ fail'} — ${g.details}`);
      }
      if (!ladder.ok) {
        lines.push('');
        lines.push(
          '**Iterate.** Fix the failing gates above and call `mcp__harness__run_gates` again. Do not declare your work complete while any gate is failing.',
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        ...(ladder.ok ? {} : { isError: true }),
      };
    },
  );

  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: [runGates],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate ladder
// ─────────────────────────────────────────────────────────────────────────────

function runLadder(ctx: RunGatesContext): GateLadderResult {
  const gates: GateResult[] = [];

  const g6 = runVitest(ctx.agentCwd);
  gates.push(g6);

  // G7 — RTL smoke is structurally covered by G6 since the seed's tests
  // use @testing-library/react. We surface it as a separate gate so the
  // PR table reads correctly; if G6 passes, G7 passes by construction.
  gates.push({
    name: 'G7',
    label: 'RTL smoke',
    ok: g6.ok,
    details: g6.ok ? 'covered by G6 (vitest uses @testing-library/react)' : 'blocked by G6 failure',
  });

  gates.push(runFhirShape(ctx));
  gates.push(runApiContract(ctx));
  gates.push(runVisualStateCoverage(ctx));

  return {
    ok: gates.every((g) => g.ok),
    gates,
  };
}

// ── G6: vitest ─────────────────────────────────────────────────────────────

function runVitest(cwd: string): GateResult {
  try {
    const out = execFileSync('npm', ['test', '--silent'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    // Parse vitest summary line: "Tests  16 passed (16)"
    const m = out.match(/Tests\s+(\d+)\s+passed/);
    return {
      name: 'G6',
      label: 'vitest unit',
      ok: true,
      details: m ? `${m[1]} tests passed` : 'all tests passed',
    };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '');
    const failedMatch = out.match(/Tests\s+(\d+)\s+failed.*?(\d+)\s+passed/s);
    const summary = failedMatch
      ? `${failedMatch[1]} failed, ${failedMatch[2]} passed`
      : 'see output below';
    // Extract first failing test name and snippet
    const firstFail =
      out.match(/FAIL\s+([^\n]+)/)?.[0] ?? out.match(/×\s+([^\n]+)/)?.[0] ?? '';
    return {
      name: 'G6',
      label: 'vitest unit',
      ok: false,
      details: `${summary}${firstFail ? ` — ${firstFail.trim().slice(0, 200)}` : ''}`,
    };
  }
}

// ── G8: FHIR shape ─────────────────────────────────────────────────────────

function runFhirShape(ctx: RunGatesContext): GateResult {
  // Light structural check: any DetectedIssue mock data found in test files
  // must include resourceType + status (the only two strictly-required FHIR
  // R4 fields for a DetectedIssue). Full schema validation against the FHIR
  // R4 JSON schema is overkill for this exercise; the structural check
  // catches the common "agent forgot resourceType" failure mode.
  const fixturePaths = findFiles(ctx.agentCwd, /\.test\.tsx?$/);
  if (fixturePaths.length === 0) {
    return { name: 'G8', label: 'FHIR shape', ok: false, details: 'no test files found' };
  }

  const errors: string[] = [];
  for (const p of fixturePaths) {
    const content = readFileSync(p, 'utf8');
    // Find DetectedIssue object literals — naive but effective.
    const objects = extractObjectLiteralsContaining(content, "resourceType: 'DetectedIssue'");
    for (const obj of objects) {
      if (!obj.includes('status:')) {
        errors.push(`${p}: DetectedIssue mock missing required field "status"`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      name: 'G8',
      label: 'FHIR shape',
      ok: false,
      details: errors.slice(0, 3).join('; '),
    };
  }
  return { name: 'G8', label: 'FHIR shape', ok: true, details: 'DetectedIssue fixtures conform' };
}

// ── G9: API gate contract ──────────────────────────────────────────────────

function runApiContract(ctx: RunGatesContext): GateResult {
  const componentDir = resolve(ctx.agentCwd, ctx.componentDir);
  if (!existsSync(componentDir)) {
    return {
      name: 'G9',
      label: 'API gate contract',
      ok: false,
      details: `component directory not found: ${ctx.componentDir}`,
    };
  }

  // Check 1 — no hardcoded http/https URLs in the component .tsx files.
  const componentFiles = findFiles(componentDir, /\.tsx?$/, { exclude: /\.test\./ });
  for (const f of componentFiles) {
    const content = readFileSync(f, 'utf8');
    // Allow comments, but flag actual string literals containing a URL.
    const stringLiterals = content.match(/(['"`])https?:\/\/[^'"`]+\1/g);
    if (stringLiterals && stringLiterals.length > 0) {
      return {
        name: 'G9',
        label: 'API gate contract',
        ok: false,
        details: `${f} contains hardcoded URL(s): ${stringLiterals.slice(0, 2).join(', ')}`,
      };
    }
  }

  // Check 2 — at least one test file imports a `DrugInteractionApi` type and
  // constructs a mock implementation (vi.fn / mock object).
  const testFiles = findFiles(componentDir, /\.test\.tsx?$/);
  let mockSeen = false;
  for (const f of testFiles) {
    const c = readFileSync(f, 'utf8');
    if (
      c.includes('DrugInteractionApi') &&
      (c.includes('vi.fn(') || c.includes('mock') || c.includes('Mock'))
    ) {
      mockSeen = true;
      break;
    }
  }
  if (!mockSeen) {
    return {
      name: 'G9',
      label: 'API gate contract',
      ok: false,
      details: 'no test file mocks DrugInteractionApi — the component must be tested with an injected mock',
    };
  }

  return { name: 'G9', label: 'API gate contract', ok: true, details: 'no hardcoded URLs; mock injection verified' };
}

// ── G10: visual-state coverage ─────────────────────────────────────────────

function runVisualStateCoverage(ctx: RunGatesContext): GateResult {
  const componentDir = resolve(ctx.agentCwd, ctx.componentDir);
  const testFiles = findFiles(componentDir, /\.test\.tsx?$/);
  if (testFiles.length === 0) {
    return {
      name: 'G10',
      label: 'visual-state coverage',
      ok: false,
      details: 'no test files in component directory',
    };
  }

  const allText = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const missing: string[] = [];
  for (const id of ctx.expectedStateTestids) {
    // Match either `data-testid="state-foo"` (component side) or
    // `getByTestId('state-foo')` / `findByTestId("state-foo")` (test side).
    const re = new RegExp(`(?:data-testid|getByTestId|findByTestId|queryByTestId)\\s*[=(]\\s*['"\`]${id}['"\`]`);
    if (!re.test(allText)) missing.push(id);
  }

  if (missing.length > 0) {
    return {
      name: 'G10',
      label: 'visual-state coverage',
      ok: false,
      details: `missing test coverage for: ${missing.join(', ')}`,
    };
  }
  return {
    name: 'G10',
    label: 'visual-state coverage',
    ok: true,
    details: `all ${ctx.expectedStateTestids.length} state testids covered`,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function findFiles(
  root: string,
  match: RegExp,
  opts: { exclude?: RegExp } = {},
): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  walk(root);
  return out;

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = require('node:fs').readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      const full = join(dir, e);
      let stat;
      try {
        stat = require('node:fs').statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (match.test(e) && (!opts.exclude || !opts.exclude.test(e))) out.push(full);
    }
  }
}

function extractObjectLiteralsContaining(source: string, needle: string): string[] {
  // Naive: find each occurrence of `needle` and walk backwards to the
  // matching `{`, then forwards to the matching `}`. Good enough for the
  // structural check we want.
  const out: string[] = [];
  let idx = 0;
  while ((idx = source.indexOf(needle, idx)) !== -1) {
    let start = idx;
    let depth = 0;
    while (start >= 0) {
      const ch = source[start];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) break;
        depth--;
      }
      start--;
    }
    if (start < 0) {
      idx += needle.length;
      continue;
    }
    let end = idx;
    let d = 1;
    while (end < source.length) {
      const ch = source[end];
      if (ch === '{') d++;
      else if (ch === '}') {
        d--;
        if (d === 0) break;
      }
      end++;
    }
    if (end < source.length) out.push(source.slice(start, end + 1));
    idx = end;
  }
  return out;
}
