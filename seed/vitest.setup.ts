import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Auto-cleanup the rendered DOM between tests so state doesn't leak
afterEach(() => {
  cleanup();
});
