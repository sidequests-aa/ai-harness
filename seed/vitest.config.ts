import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts because rolldown-vite (vite@^8) and the vite
// version vitest bundles are different — sharing the config causes plugin
// type-mismatch errors at typecheck time.
export default defineConfig({
  // @ts-expect-error rolldown-vite's Plugin<any> has a slightly different
  // shape from rollup-vite's, but the runtime behaviour is identical.
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
