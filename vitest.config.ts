import { defineConfig } from 'vitest/config';

// Issue #510 (PLAN.md row A0): the repo had no TypeScript test runner before this story (noted
// as a known gap in #488's own PR, "the first thing to test once one exists"). Scoped to
// `node` since every test added so far covers main-process, Electron-free pure logic
// (terminationDetection.ts) -- no jsdom/browser environment needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
