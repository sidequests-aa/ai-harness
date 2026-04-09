import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// Vitest config lives in a separate vitest.config.ts so its bundled Vite
// version doesn't conflict with the one rolldown-vite ships here.
export default defineConfig({
  plugins: [react()],
  build: {
    // @medplum/react/styles.css ships with unresolved Sass variables
    // (e.g. `$mantine-breakpoint-xs`) that lightningcss refuses to minify.
    // Skip CSS minification — this is a dev seed, not perf-tuned for prod.
    cssMinify: false,
  },
});
