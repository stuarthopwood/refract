import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { STEPS, originMainProblem } from './test-fast-steps.mjs';

const readRuns = (relative) => {
  const doc = yaml.load(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  return Object.values(doc.jobs).flatMap((job) => job.steps.map((step) => step.run).filter(Boolean));
};

// The install step only exists to give a CI runner node_modules; ci-local.yml has it too but a local run does not need it.
const INSTALL_STEP = 'pnpm install --frozen-lockfile';

describe('fast tier drift', () => {
  const prFastRuns = readRuns('../.github/workflows/pr-fast.yml');
  const ciLocalRuns = readRuns('../.github/ci-local.yml');

  it('keeps every pr-fast.yml run step (except install) verbatim in ci-local.yml', () => {
    const missing = prFastRuns.filter((run) => run !== INSTALL_STEP && !ciLocalRuns.includes(run));
    expect(prFastRuns.length).toBeGreaterThan(1);
    expect(missing).toEqual([]);
  });

  it('keeps test-fast.mjs check steps identical to the pr-fast.yml check steps', () => {
    const prFastChecks = prFastRuns.filter((run) => run.startsWith('pnpm check:'));
    const localChecks = STEPS.filter((run) => run.startsWith('pnpm check:'));
    expect(prFastChecks.length).toBeGreaterThan(0);
    expect(localChecks).toEqual(prFastChecks);
  });

  it('leaves check:ui-text as the only cargo-free ci-local check out of the fast tier', () => {
    const missingFromFast = ciLocalRuns
      .filter((run) => run.startsWith('pnpm check:'))
      .filter((run) => !prFastRuns.includes(run));
    expect(missingFromFast).toEqual(['pnpm check:ui-text']);
  });
});

describe('originMainProblem', () => {
  it('reports nothing when origin/main resolves', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(originMainProblem(run, '/repo')).toBeNull();
    expect(run).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'origin/main'], { cwd: '/repo', stdio: 'ignore' });
  });

  it('tells the developer to fetch when origin/main is missing', () => {
    expect(originMainProblem(() => ({ status: 128 }), '/repo')).toMatch(/git fetch origin main/);
  });
});
