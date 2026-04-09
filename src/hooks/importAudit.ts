import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Project, ScriptKind } from 'ts-morph';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Import-audit PreToolUse hook (G4).
 *
 * Parses the file content the agent is about to write/edit, walks every
 * `import` declaration with ts-morph, and verifies each module specifier
 * resolves to a real file or a real package in the worktree's
 * `node_modules`. Denies the write with a precise reason if anything is
 * hallucinated. This is the single most effective gate against the agent
 * inventing nonexistent APIs.
 *
 * What we DO check:
 * - Relative imports (`./foo`, `../bar`) → file must exist with one of
 *   .ts, .tsx, .js, .jsx, .mjs, .cjs, .json, or `/index.<ext>`.
 * - Bare specifiers (`react`, `@medplum/core`) → must be a key in the seed's
 *   package.json (deps + devDeps).
 * - Sub-paths of bare specifiers (`@medplum/react/styles.css`) → the
 *   top-level package must be a known dep; we don't try to validate the
 *   sub-path itself (filesystem layout of node_modules is too varied).
 *
 * What we DON'T check:
 * - Whether a *named* import actually exists in the target module. That
 *   requires loading the module's types, which is expensive and brittle.
 *   The TypeScript compiler will catch this in the post-write fast-gate.
 */

export interface ImportAuditOpts {
  /** Absolute path to the agent's CWD (the seed root). */
  agentCwd: string;
  /**
   * Optional callback for observability. Fires once per denied write with
   * the unresolved specifier.
   */
  onDeny?: (info: { filePath: string; specifier: string; reason: string }) => void;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

export function createImportAuditHook(opts: ImportAuditOpts): HookCallback {
  // Read the seed's package.json once at hook construction; deps are stable
  // for the lifetime of a run.
  const pkgPath = resolve(opts.agentCwd, 'package.json');
  const knownDeps = loadDepNames(pkgPath);

  // Always-permitted specifiers — Node built-ins. The Node compatibility
  // layer doesn't list these in package.json.
  const nodeBuiltins = new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'stream',
    'buffer', 'child_process', 'events', 'querystring', 'zlib', 'assert',
    'process', 'tty', 'net', 'dns', 'cluster', 'string_decoder', 'timers',
    'vm', 'module', 'readline', 'worker_threads', 'perf_hooks', 'inspector',
  ]);

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') return {};

    const ti = (input.tool_input ?? {}) as Record<string, unknown>;
    const filePath = ti.file_path as string | undefined;
    if (!filePath) return {};
    if (!/\.(ts|tsx|mts|cts)$/i.test(filePath)) return {};

    // Determine the new content. For Write the agent gives us `content`;
    // for Edit we have to apply old_string→new_string against the existing
    // file content (or use new_content if Anthropic exposes it).
    let newContent: string | null = null;
    if (input.tool_name === 'Write') {
      newContent = (ti.content as string | undefined) ?? null;
    } else {
      // Edit tool — replace the unique old_string with new_string in the
      // current file. If the file doesn't exist yet, treat the new_string
      // alone as the content (which is rare but possible).
      const oldStr = (ti.old_string as string | undefined) ?? '';
      const newStr = (ti.new_string as string | undefined) ?? '';
      const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      newContent = current.split(oldStr).join(newStr);
    }
    if (newContent === null || newContent.trim().length === 0) return {};

    // Parse with ts-morph in-memory.
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { jsx: 4 /* ReactJSX */, target: 99, module: 99, allowJs: false },
    });
    let sf;
    try {
      sf = project.createSourceFile('audit.tsx', newContent, {
        scriptKind: filePath.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS,
        overwrite: true,
      });
    } catch (err) {
      // If ts-morph can't parse it, let prettier/eslint handle the error
      // post-write. Don't block the agent over a parse error.
      return {};
    }

    const fileDir = dirname(resolve(filePath));
    for (const decl of sf.getImportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      if (!spec) continue;

      if (spec.startsWith('.') || isAbsolute(spec)) {
        // Relative or absolute path import.
        const base = resolve(fileDir, spec);
        if (!resolveFileLike(base)) {
          return denyWrite(opts, filePath, spec, `Relative import "${spec}" does not resolve. Tried adding ${TS_EXTS.join('/')} and /index.* extensions to ${base}.`);
        }
        continue;
      }

      // Bare specifier — could be `pkg` or `@scope/pkg` or with a sub-path.
      const topLevel = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0]!;

      if (nodeBuiltins.has(topLevel) || nodeBuiltins.has(topLevel.replace(/^node:/, ''))) {
        continue;
      }
      if (topLevel.startsWith('node:')) continue;

      if (!knownDeps.has(topLevel)) {
        return denyWrite(opts, filePath, spec, `Bare import "${spec}" references package "${topLevel}" which is not in the seed's package.json. Either it doesn't exist, or you've hallucinated the package name. The seed's installed packages are: ${[...knownDeps].slice(0, 30).join(', ')}${knownDeps.size > 30 ? ', ...' : ''}.`);
      }
    }

    return {};
  };
}

function resolveFileLike(base: string): string | null {
  for (const ext of TS_EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base)) return base;
  // Index file lookup
  for (const ext of TS_EXTS) {
    if (existsSync(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

function loadDepNames(pkgPath: string): Set<string> {
  if (!existsSync(pkgPath)) return new Set();
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

function denyWrite(opts: ImportAuditOpts, filePath: string, specifier: string, reason: string) {
  opts.onDeny?.({ filePath, specifier, reason });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: `Hallucinated import detected (G4 import-audit gate). ${reason}`,
    },
  };
}
