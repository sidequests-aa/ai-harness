import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Mantine components (which @medplum/react re-exports) call
// `window.matchMedia` at render time. jsdom does not implement matchMedia, so
// without this polyfill any test that mounts a Mantine-based component throws.
// Polyfill it here once so individual component tests don't have to.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Auto-cleanup the rendered DOM between tests so state doesn't leak
afterEach(() => {
  cleanup();
});
