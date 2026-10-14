import { defineConfig } from 'vitest/config';

// One-off config for scripts/gen-contract-replay-electron-trace.mjs (see that file's own header
// comment for why it needs this): the project's own vitest.config.ts scopes `include` to
// `src/**/*.test.ts` only (deliberately -- no new TS tests while prototyping, AGENTS.md), so this
// checked-in generator -- living under scripts/, never named `*.test.ts`/`*.spec.ts`, never
// auto-discovered by `pnpm test`/CI's Vitest step -- needs a widened `include` to be runnable at
// all via an explicit `--config` invocation. Not consumed by anything else; see the generator's
// own header comment and scripts/fixtures/contract-replay/README.md for the full command.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/gen-contract-replay-electron-trace.mjs'],
  },
});
