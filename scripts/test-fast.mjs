#!/usr/bin/env node
// `pnpm test:fast`: the local fast tier (#1806): vitest on files changed since origin/main, then the
// `check:*` scripts that need no cargo, Windows or built bundle. Budget: 3 minutes (warns above it).
// The checks mirror `.github/workflows/pr-fast.yml`, which runs the whole vitest suite instead.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, originMainProblem } from './test-fast-steps.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_MS = 3 * 60 * 1000;

const problem = originMainProblem(spawnSync, repoRoot);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const started = Date.now();
for (const command of STEPS) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`test:fast: "${command}" failed; stopping.`);
    process.exit(result.status ?? 1);
  }
}

const elapsedMs = Date.now() - started;
console.log(`\ntest:fast: ${STEPS.length} step(s) passed in ${(elapsedMs / 1000).toFixed(1)}s.`);
if (elapsedMs > BUDGET_MS) {
  console.warn('test:fast: over the 3-minute budget; trim or speed up the slowest step.');
}
