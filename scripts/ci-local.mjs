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
// (the shared Rust build cache lives outside the repo and outside any one worktree). Issue #946:
// before running any `cargo`/`tauri` step, this script refuses rather than letting cargo silently
// fall back to a worktree-local `src-tauri/target`.
//
// Usage: node scripts/ci-local.mjs  (or `pnpm ci:local`)

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

// Strict parse: fails loudly (rather than silently skipping) on any step shape this script does
// not already know how to run locally, so a future `ci.yml` change can never quietly stop being
// covered.
// Keys this script understands on a job and on a step; anything else changes execution
// semantics `ci-local.mjs` does not implement (`env`, `defaults`, `strategy`, `needs`, `if` on a
// job; `if`, `env`, `working-directory`, `shell`, `continue-on-error` on a step) -- silently
// ignoring one of those would run a step locally in a way that diverges from what GitHub
// Actions actually does, with no error. A strict, single source of truth means an unknown key
// fails loudly instead.
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
      // ci.yml never uses a multi-line `run:` block today; a strict single source of truth
      // means a run step that is not one single command is unexpected, not silently flattened
      // into several separate commands.
      if (step.run.includes('\n')) {
        fail(
          `${WORKFLOW_REL}: ${where} ("${step.name ?? '(unnamed)'}") has a multi-line "run:", ` +
            'which ci-local.mjs does not support',
        );
      }
      // `${{ ... }}` is GitHub Actions' own expression syntax, substituted by the runner before
      // the shell ever sees it (secrets, `github.*`, `matrix.*`, step outputs, ...). Run here
      // unexpanded, it would either be passed to the shell literally (wrong command) or break
      // quoting -- either way silently diverging from what CI actually runs.
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
  // #946: a cargo/tauri step here left unset falls back to cargo's own default
  // (`src-tauri/target`), the exact worktree-local build this issue exists to prevent -- refuse
  // up front, before any step runs, rather than discovering it mid-build.
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
