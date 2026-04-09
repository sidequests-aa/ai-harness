import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Layer A of the context strategy: hand-authored markdown packs the agent
 * sees in its system prompt. The ticket opts into specific packs by name in
 * its `## Context Packs` section; this loader reads those files and returns
 * a single concatenated string ready to drop into the prompt.
 *
 * Unknown pack names are skipped with a console warning rather than fatal,
 * so a typo in a ticket doesn't kill a run.
 */

export interface LoadedPack {
  name: string;
  path: string;
  body: string;
}

export interface LoadPacksResult {
  packs: LoadedPack[];
  /** Pack names from the ticket that did not resolve to a file. */
  missing: string[];
  /** Total characters across all loaded packs (rough token proxy). */
  totalChars: number;
}

/**
 * Load packs by name from a directory. Names are case-sensitive and match
 * the basename without extension — e.g. `react-conventions` →
 * `<dir>/react-conventions.md`.
 */
export function loadPacks(packsDir: string, names: string[]): LoadPacksResult {
  const dir = resolve(packsDir);
  const packs: LoadedPack[] = [];
  const missing: string[] = [];
  let totalChars = 0;

  for (const name of names) {
    const path = resolve(dir, `${name}.md`);
    if (!existsSync(path)) {
      // eslint-disable-next-line no-console
      console.warn(`[context-packs] missing pack: ${name} (looked in ${path})`);
      missing.push(name);
      continue;
    }
    const body = readFileSync(path, 'utf8');
    packs.push({ name, path, body });
    totalChars += body.length;
  }

  return { packs, missing, totalChars };
}

/**
 * Render loaded packs as a single markdown section ready to inject into a
 * system prompt. Each pack is wrapped in a clearly-delimited block so the
 * agent can refer to "the testing-patterns pack" in its reasoning and we
 * can grep transcripts for which packs got referenced.
 */
export function renderPacks(packs: LoadedPack[]): string {
  if (packs.length === 0) return '_(no context packs loaded)_';
  const sections = packs.map(
    (p) => `### Pack: \`${p.name}\`\n\n${p.body.trim()}\n`,
  );
  return sections.join('\n---\n\n');
}
