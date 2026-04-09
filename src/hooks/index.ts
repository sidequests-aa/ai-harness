/**
 * Hook builder — composes the three Phase 3 hooks into the discriminated
 * union shape `ClaudeAgentOptions.hooks` expects.
 *
 * Each hook is parameterised by the per-run state it needs (the agent's
 * cwd and the ticket's file scope), so the same module can serve multiple
 * concurrent runs without sharing state.
 *
 * The `denyLog` and `gateLog` collectors give the pipeline a record of
 * what fired during the run. They get folded into the structured PR
 * description in Phase 4.
 */
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { createScopeGuardHook } from './scopeGuard';
import { createImportAuditHook } from './importAudit';
import { createFastGateHook } from './fastGate';

export interface ScopeDenyEvent {
  tool: string;
  reason: string;
  targetPath?: string;
  command?: string;
}

export interface ImportAuditDenyEvent {
  filePath: string;
  specifier: string;
  reason: string;
}

export interface FastGateFailureEvent {
  filePath: string;
  gate: 'prettier' | 'eslint';
  output: string;
}

export interface HookCollectors {
  scopeDenials: ScopeDenyEvent[];
  importDenials: ImportAuditDenyEvent[];
  fastGateFailures: FastGateFailureEvent[];
}

export function createHookCollectors(): HookCollectors {
  return { scopeDenials: [], importDenials: [], fastGateFailures: [] };
}

export interface BuildHooksOpts {
  agentCwd: string;
  fileScope: string[];
  collectors: HookCollectors;
}

/**
 * Returns the `hooks` field for `ClaudeAgentOptions`. The shape is a
 * `Partial<Record<HookEvent, HookCallbackMatcher[]>>`.
 *
 * Hook wiring:
 * - `PreToolUse` matcher `Write|Edit|NotebookEdit|Bash` → scope-guard (G5)
 * - `PreToolUse` matcher `Write|Edit` → import-audit (G4)
 * - `PostToolUse` matcher `Write|Edit` → fast-gate (G1+G2)
 *
 * Two PreToolUse matchers run sequentially; if scope-guard denies, the
 * tool call short-circuits before import-audit runs.
 */
export function buildHooks(opts: BuildHooksOpts): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const scopeGuard = createScopeGuardHook({
    agentCwd: opts.agentCwd,
    fileScope: opts.fileScope,
    onDeny: (info) => opts.collectors.scopeDenials.push(info),
  });
  const importAudit = createImportAuditHook({
    agentCwd: opts.agentCwd,
    onDeny: (info) => opts.collectors.importDenials.push(info),
  });
  const fastGate = createFastGateHook({
    agentCwd: opts.agentCwd,
    onFailure: (info) => opts.collectors.fastGateFailures.push(info),
  });

  return {
    PreToolUse: [
      { matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [scopeGuard] },
      { matcher: 'Write|Edit', hooks: [importAudit] },
    ],
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [fastGate] }],
  };
}

export { createScopeGuardHook } from './scopeGuard';
export { createImportAuditHook } from './importAudit';
export { createFastGateHook } from './fastGate';
