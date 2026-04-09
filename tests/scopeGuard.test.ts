import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createScopeGuardHook } from '../src/hooks/scopeGuard';

const CWD = resolve('/tmp/seed-test'); // doesn't need to exist; hook is path-only
const SCOPE = [
  'src/components/InteractionReviewPanel/**',
  'src/types/drugInteractionApi.ts',
];

function preToolUseInput(tool: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'test-id',
    session_id: 'test-session',
    transcript_path: '/dev/null',
    cwd: CWD,
    permission_mode: 'acceptEdits' as const,
  };
}

const noop = async () => undefined;

describe('scope-guard hook', () => {
  const hook = createScopeGuardHook({ agentCwd: CWD, fileScope: SCOPE });

  it('allows Write inside scope', async () => {
    const result = await hook(
      preToolUseInput('Write', {
        file_path: resolve(CWD, 'src/components/InteractionReviewPanel/InteractionReviewPanel.tsx'),
        content: 'export function X() { return null; }',
      }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput).toBeUndefined();
  });

  it('allows Write to the explicit type file', async () => {
    const result = await hook(
      preToolUseInput('Write', {
        file_path: resolve(CWD, 'src/types/drugInteractionApi.ts'),
        content: 'export interface Foo {}',
      }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput).toBeUndefined();
  });

  it('denies Write outside scope', async () => {
    const result = await hook(
      preToolUseInput('Write', {
        file_path: resolve(CWD, 'src/main.tsx'),
        content: 'modified',
      }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toMatch(/scope-guard/);
  });

  it('denies Edit to vitest.setup.ts (the Phase 1 incident)', async () => {
    const result = await hook(
      preToolUseInput('Edit', {
        file_path: resolve(CWD, 'vitest.setup.ts'),
        old_string: 'foo',
        new_string: 'bar',
      }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies Bash `rm -rf` of out-of-scope path', async () => {
    const result = await hook(
      preToolUseInput('Bash', { command: 'rm -rf src/main.tsx' }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toMatch(/scope/);
  });

  it('denies Bash `npm install`', async () => {
    const result = await hook(
      preToolUseInput('Bash', { command: 'npm install something' }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies Bash `git checkout`', async () => {
    const result = await hook(
      preToolUseInput('Bash', { command: 'git checkout main' }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows Bash `npm test`', async () => {
    const result = await hook(
      preToolUseInput('Bash', { command: 'npm test' }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput).toBeUndefined();
  });

  it('allows Bash `git status`', async () => {
    const result = await hook(
      preToolUseInput('Bash', { command: 'git status' }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result?.hookSpecificOutput).toBeUndefined();
  });

  it('records denials via the onDeny callback', async () => {
    const denials: Array<{ tool: string; reason: string; targetPath?: string; command?: string }> = [];
    const trackedHook = createScopeGuardHook({
      agentCwd: CWD,
      fileScope: SCOPE,
      onDeny: (info) => denials.push(info),
    });
    await trackedHook(
      preToolUseInput('Write', {
        file_path: resolve(CWD, 'src/main.tsx'),
        content: 'x',
      }),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.tool).toBe('Write');
    expect(denials[0]?.targetPath).toContain('main.tsx');
  });
});

void noop;
