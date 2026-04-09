import { defineConfig } from 'vitest/config';

// Vitest config for the harness ITSELF (not the seed). Scopes test discovery
// to `tests/` so the seed's test files don't leak into harness runs when
// vitest is invoked from the harness root.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'seed', '.harness-worktrees', 'runs'],
  },
});
