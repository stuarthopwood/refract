#!/usr/bin/env node
// `pnpm ci:local`: runs every `run:` step of `.github/ci-local.yml` locally, in order, stopping at the first failure.
// Re-parses the file so the step list cannot drift; `uses:` setup steps are skipped. `--list` prints the steps and exits.
// CARGO_TARGET_DIR passes through unchanged; incremental compilation is off repo-wide in `.cargo/config.toml` (#1736).
// Cargo/tauri steps refuse a worktree-local target (#946) and warn when the cache is over 10 GB.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSteps, printListIfRequested } from './ci-local-steps.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { CACHE_WARN_BYTES, dirSizeBytes, formatGiB, runningCargoExecutables } from './cargo-cache-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'ci-local.yml');
const WORKFLOW_REL = path.relative(repoRoot, WORKFLOW_PATH).replace(/\\/g, '/');

function fail(message) {
  console.error(`ci-local: ${message}`);
  process.exit(1);
}

function loadSteps() {
  try {
    return parseSteps(readFileSync(WORKFLOW_PATH, 'utf8'), WORKFLOW_REL);
  } catch (err) {
    return fail(err.message);
  }
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

function warnIfCacheLarge() {
  const size = dirSizeBytes(path.resolve(process.env.CARGO_TARGET_DIR), CACHE_WARN_BYTES);
  if (size > CACHE_WARN_BYTES) {
    console.warn(`ci-local: warning: shared cargo target is over ${formatGiB(CACHE_WARN_BYTES)}; run \`pnpm cache:sweep\` to prune stale artefacts.`);
  }
}

// A still-running exe from an earlier `cargo test` makes the linker fail with LNK1105 / error 1224 (#1733).
function warnIfTestExeRunning() {
  const running = runningCargoExecutables(path.resolve(process.env.CARGO_TARGET_DIR));
  if (running.length > 0) {
    console.warn(`ci-local: warning: ${running.length} executable(s) in the shared cargo target are locked or running, and a link that replaces one fails with LNK1105 / error 1224. Wait for that run to finish or end it (by PID, never by image name):\n  ${running.join('\n  ')}`);
  }
}

function main() {
  const steps = loadSteps();
  if (printListIfRequested(process.argv, steps, console.log)) {
    return;
  }
  // Unset, cargo falls back to a worktree-local `src-tauri/target` (#946); refuse before any step runs.
  if (steps.some((step) => /\b(cargo|tauri)\b/i.test(step.run))) {
    try {
      requireSharedCargoTarget(repoRoot);
    } catch (err) {
      fail(err.message);
    }
    warnIfCacheLarge();
    warnIfTestExeRunning();
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
