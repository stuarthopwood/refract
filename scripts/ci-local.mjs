#!/usr/bin/env node
// `pnpm ci:local`: runs every `run:` step of `.github/workflows/ci.yml` locally, in order, stopping at the first failure.
// Re-parses the workflow so the step list cannot drift; `uses:` setup steps are skipped.
// CARGO_TARGET_DIR/CARGO_INCREMENTAL pass through unchanged; cargo/tauri steps refuse a worktree-local target (#946).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const WORKFLOW_REL = path.relative(repoRoot, WORKFLOW_PATH).replace(/\\/g, '/');

function fail(message) {
  console.error(`ci-local: ${message}`);
  process.exit(1);
}

// Strict parse: an unknown job/step key (`env`, `if`, `strategy`, `working-directory`, ...) changes execution
// semantics this script does not implement, so it must fail loudly rather than diverge silently from Actions.
const ALLOWED_JOB_KEYS = new Set(['name', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);
const ALLOWED_STEP_KEYS = new Set(['name', 'run', 'uses', 'with', 'id']);

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
    for (const key of Object.keys(job)) {
      if (!ALLOWED_JOB_KEYS.has(key)) {
        fail(
          `${WORKFLOW_REL}: job "${jobName}" has a "${key}:" key ci-local.mjs does not understand ` +
            '-- it may change execution semantics locally without error',
        );
      }
    }
    job.steps.forEach((step, i) => {
      const where = `job "${jobName}" step ${i + 1}`;
      if (step == null || typeof step !== 'object') {
        fail(`${WORKFLOW_REL}: ${where} is not a mapping`);
      }
      for (const key of Object.keys(step)) {
        if (!ALLOWED_STEP_KEYS.has(key)) {
          fail(
            `${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a "${key}:" key ` +
              'ci-local.mjs does not understand -- it may change execution semantics locally without error',
          );
        }
      }
      if (step.run == null) {
        return; // a `uses:` step (checkout/toolchain setup) -- nothing to run locally.
      }
      if (typeof step.run !== 'string') {
        fail(`${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a non-string "run:"`);
      }
      // A multi-line run is unexpected; fail rather than flatten it into several commands.
      if (step.run.includes('\n')) {
        fail(
          `${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a multi-line "run:", ` +
            'which ci-local.mjs does not support',
        );
      }
      // The runner substitutes `${{ }}` before the shell sees it; run unexpanded it would diverge from CI.
      if (step.run.includes('${{')) {
        fail(
          `${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a "\${{ ... }}" GitHub ` +
            'Actions expression in its "run:", which ci-local.mjs cannot evaluate locally',
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
  // Unset, cargo falls back to a worktree-local `src-tauri/target` (#946); refuse before any step runs.
  if (steps.some((step) => /\b(cargo|tauri)\b/i.test(step.run))) {
    try {
      requireSharedCargoTarget(repoRoot);
    } catch (err) {
      fail(err.message);
    }
  }
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
