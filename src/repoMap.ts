import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

/**
 * Compact, agent-friendly representation of a TypeScript repo: every
 * `.ts/.tsx` file under a root, with its top-level exports.
 *
 * The harness builds this once per run and injects it into the implementer
 * agent's system prompt as Layer B of the context strategy (curated packs +
 * repo map + on-demand retrieval). It is deliberately small (~1-2KB for the
 * seed) so it costs nothing to ship eagerly and gives the agent a complete
 * mental map of the codebase without needing to `Glob` or `Read` to discover
 * structure.
 *
 * We use ts-morph (the TypeScript compiler API with a friendlier surface)
 * because we already need it for the import-audit hook in Phase 3 — one
 * dependency, two uses.
 */

export interface RepoMapExport {
  kind:
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'variable'
    | 'reexport'
    | 'default'
    | 'unknown';
  name: string;
  /** One-line signature (no body). Empty for re-exports. */
  signature: string;
}

export interface RepoMapFile {
  /** Path relative to the repo map root, with POSIX separators. */
  path: string;
  exports: RepoMapExport[];
}

export interface RepoMap {
  version: 1;
  root: string;
  files: RepoMapFile[];
}

/**
 * Walk a TypeScript project root with ts-morph and emit a RepoMap.
 *
 * `rootPath` is the directory whose `**\/*.{ts,tsx}` files (excluding
 * node_modules, dist, build) get indexed. Paths in the output are relative
 * to this root. If the root contains a `tsconfig.json` we still don't load
 * it — we want a parse-only project, not a type-checking one (faster, and
 * doesn't fail when types are missing).
 */
export function buildRepoMap(rootPath: string): RepoMap {
  const root = resolve(rootPath);
  if (!existsSync(root)) {
    throw new Error(`buildRepoMap: root does not exist: ${root}`);
  }

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      // We're parsing, not type-checking. Numeric enum values avoid the
      // need to import the `typescript` enum directly.
      jsx: 4 /* ts.JsxEmit.ReactJSX */,
      target: 99 /* ts.ScriptTarget.ESNext */,
      module: 99 /* ts.ModuleKind.ESNext */,
      allowJs: false,
    },
  });

  project.addSourceFilesAtPaths([
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/dist/**`,
    `!${root}/**/build/**`,
    `!${root}/**/coverage/**`,
    // Skip test files — they bloat the map and rarely add structural info
    // the agent needs to navigate the implementation surface.
    `!${root}/**/*.test.ts`,
    `!${root}/**/*.test.tsx`,
    `!${root}/**/*.spec.ts`,
    `!${root}/**/*.spec.tsx`,
  ]);

  const files: RepoMapFile[] = [];
  for (const sf of project.getSourceFiles()) {
    const rel = relative(root, sf.getFilePath()).replace(/\\/g, '/');
    const exports = extractExports(sf);
    files.push({ path: rel, exports });
  }

  // Sort for deterministic output (helps with caching, diffing, replay).
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { version: 1, root: rootPath, files };
}

function extractExports(sf: SourceFile): RepoMapExport[] {
  const out: RepoMapExport[] = [];

  // 1. Direct named exports — `export function foo() {}` etc.
  for (const fn of sf.getFunctions()) {
    if (fn.isExported()) {
      out.push({
        kind: 'function',
        name: fn.getName() ?? '(anonymous)',
        signature: oneLine(fn.getText().split('{')[0] ?? ''),
      });
    }
  }
  for (const cls of sf.getClasses()) {
    if (cls.isExported()) {
      out.push({
        kind: 'class',
        name: cls.getName() ?? '(anonymous)',
        signature: `class ${cls.getName() ?? ''}`,
      });
    }
  }
  for (const iface of sf.getInterfaces()) {
    if (iface.isExported()) {
      out.push({
        kind: 'interface',
        name: iface.getName(),
        signature: `interface ${iface.getName()}`,
      });
    }
  }
  for (const t of sf.getTypeAliases()) {
    if (t.isExported()) {
      out.push({
        kind: 'type',
        name: t.getName(),
        signature: `type ${t.getName()} = ${oneLine(t.getTypeNode()?.getText() ?? '...')}`,
      });
    }
  }
  for (const e of sf.getEnums()) {
    if (e.isExported()) {
      out.push({ kind: 'enum', name: e.getName(), signature: `enum ${e.getName()}` });
    }
  }
  for (const v of sf.getVariableStatements()) {
    if (!v.isExported()) continue;
    for (const decl of v.getDeclarations()) {
      out.push({
        kind: 'variable',
        name: decl.getName(),
        signature: `const ${decl.getName()}: ${oneLine(decl.getType().getText().slice(0, 80))}`,
      });
    }
  }

  // 2. Re-exports — `export { Foo, default } from './Foo'`
  for (const rd of sf.getExportDeclarations()) {
    const named = rd.getNamedExports();
    if (named.length === 0) {
      // `export * from './foo'`
      const moduleSpec = rd.getModuleSpecifierValue() ?? '?';
      out.push({ kind: 'reexport', name: `* from '${moduleSpec}'`, signature: '' });
      continue;
    }
    for (const ne of named) {
      const moduleSpec = rd.getModuleSpecifierValue();
      const name = ne.getName();
      out.push({
        kind: 'reexport',
        name: moduleSpec ? `${name} from '${moduleSpec}'` : name,
        signature: '',
      });
    }
  }

  // 3. Default export — `export default ...`
  for (const ea of sf.getExportAssignments()) {
    if (ea.isExportEquals()) continue;
    const expr = ea.getExpression();
    out.push({
      kind: 'default',
      name: 'default',
      signature: oneLine(expr.getText().slice(0, 80)),
    });
  }

  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Render a RepoMap as compact markdown for injection into a system prompt.
 *
 * The format is intentionally bullet-list based (not a JSON dump) so it
 * costs fewer tokens and the agent treats it as documentation rather than
 * structured data.
 */
export function renderRepoMap(map: RepoMap): string {
  const lines: string[] = [];
  lines.push(`Repo map (root: \`${map.root}\`, ${map.files.length} files)\n`);
  for (const f of map.files) {
    lines.push(`- \`${f.path}\``);
    if (f.exports.length === 0) {
      lines.push('  - _(no exports)_');
      continue;
    }
    for (const e of f.exports) {
      const sig = e.signature ? ` — \`${e.signature}\`` : '';
      lines.push(`  - **${e.kind}** \`${e.name}\`${sig}`);
    }
  }
  return lines.join('\n');
}

/**
 * Convenience: read the seed's package.json to enrich the map with deps.
 * Optional — used by the run report in Phase 4.
 */
export function readPackageJsonNames(packageJsonPath: string): string[] {
  if (!existsSync(packageJsonPath)) return [];
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

/** Suppress unused-import warning if SyntaxKind isn't referenced above. */
void SyntaxKind;
