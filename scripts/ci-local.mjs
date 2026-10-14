#!/usr/bin/env node
// `pnpm ci:local`: the one-command local equivalent of `.github/workflows/ci.yml`'s `build` job,
// since GitHub Actions CI is disabled (Stuart, 2026-10-14, Actions budget). `ci.yml` is the
// single source of truth for what "CI" means -- this script re-parses its own `run:` steps (with
// `js-yaml`, already a transitive dependency via `cosmiconfig`, now a direct one) rather than
// hardcoding a second copy of the step list that could silently drift from the real workflow.
//
// Steps with no `run:` (checkout, pnpm/Node/Rust toolchain setup) are a GitHub-Actions-only
// concern -- this machine already has pnpm, Node and the Rust toolchain installed, so they are
// skipped here, never re-implemented. Every step that DOES have a `run:` is executed, in the
// exact order `ci.yml` lists it, with inherited stdio, stopping at the first non-zero exit.
//
// `CARGO_TARGET_DIR`/`CARGO_INCREMENTAL` are read from the calling shell's own environment and
// passed straight through to every step unchanged -- this script never sets or overrides them
// (the shared Rust build cache lives outside the repo and outside any one worktree).
//
// Usage: node scripts/ci-local.mjs  (or `pnpm ci:local`)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const WORKFLOW_REL = path.relative(repoRoot, WORKFLOW_PATH).replace(/\\/g, '/');

function fail(message) {
  console.error(`ci-local: ${message}`);
  process.exit(1);
}

// Strict parse: fails loudly (rather than silently skipping) on any step shape this script does
// not already know how to run locally, so a future `ci.yml` change can never quietly stop being
// covered.
function loadSteps() {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    fail(`failed to parse ${WORKFLOW_REL}: ${err.message}`);
  }
  if (doc == null || typeof doc !== 'object' || doc.jobs == null || typeof doc.jobs !== 'object') {
    fail(`${WORKFLOW_REL} has no top-level "jobs" map`);
  }

  const steps = [];
  for (const [jobName, job] of Object.entries(doc.jobs)) {
    if (job == null || !Array.isArray(job.steps)) {
      fail(`${WORKFLOW_REL}: job "${jobName}" has no "steps" array`);
    }
    job.steps.forEach((step, i) => {
      const where = `job "${jobName}" step ${i + 1}`;
      if (step == null || typeof step !== 'object') {
        fail(`${WORKFLOW_REL}: ${where} is not a mapping`);
      }
      if (step.run == null) {
        return; // a `uses:` step (checkout/toolchain setup) -- nothing to run locally.
      }
      if (typeof step.run !== 'string') {
        fail(`${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a non-string "run:"`);
      }
      // ci.yml never uses a multi-line `run:` block today; a strict single source of truth
      // means a run step that is not one single command is unexpected, not silently flattened
      // into several separate commands.
      if (step.run.includes('\n')) {
        fail(
          `${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a multi-line "run:", ` +
            'which ci-local.mjs does not support',
        );
      }
      steps.push({ job: jobName, name: step.name ?? step.run, run: step.run });
    });
  }

  if (steps.length === 0) {
    fail(`${WORKFLOW_REL} has no steps with a "run:" command`);
  }
  return steps;
}

function runStep(step) {
  const start = Date.now();
  const result = spawnSync(step.run, { cwd: repoRoot, stdio: 'inherit', shell: true });
  const durationMs = Date.now() - start;
  if (result.error) {
    return { ok: false, durationMs, detail: result.error.message };
  }
  return { ok: result.status === 0, durationMs, detail: result.status };
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  const steps = loadSteps();
  const results = [];
  let failedAt = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`\n> ${step.name}\n  $ ${step.run}`);
    const result = runStep(step);
    results.push({ step, result });
    if (!result.ok) {
      failedAt = i;
      break;
    }
  }

  console.log('\nci-local summary:');
  for (const { step, result } of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${formatDuration(result.durationMs).padStart(7)}  ${step.name}`);
  }

  if (failedAt !== -1) {
    const skipped = steps.length - results.length;
    if (skipped > 0) {
      console.log(`  [SKIP]           ${skipped} step(s) not run after the failure above`);
    }
    fail(`"${steps[failedAt].name}" failed; stopping.`);
  }

  console.log(`\nci-local: all ${steps.length} step(s) passed.`);
}

main();
