#!/usr/bin/env node
// `pnpm cache:sweep [--days N] [--dry-run]`: prunes stale artefacts from the shared cargo target (#1736).
// Age-based (default 7 days) via a pinned cargo-sweep, and only when no cargo build holds the target lock.

import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirSizeBytes, formatGiB, heldCargoLocks } from './cargo-cache-helpers.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

// Pinned: cargo-sweep is unmaintained upstream, so an unreviewed newer release is never picked up silently.
const CARGO_SWEEP_VERSION = '0.8.0';
const DEFAULT_DAYS = 7;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`cache:sweep: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { days: DEFAULT_DAYS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--days') {
      const value = argv[++i];
      // 0 would make cargo-sweep delete the whole cache, which is `cargo clean`, not a sweep.
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1) fail('--days needs a whole number of 1 or more.');
      opts.days = Number(value);
    } else {
      fail(`unknown argument "${arg}". Usage: pnpm cache:sweep [--days N] [--dry-run]`);
    }
  }
  return opts;
}

function installedSweepVersion() {
  const result = spawnSync('cargo', ['sweep', '--version'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return /(\d+\.\d+\.\d+)\s*$/.exec(result.stdout.trim())?.[1] ?? null;
}

function ensureCargoSweep() {
  const installed = installedSweepVersion();
  if (installed === CARGO_SWEEP_VERSION) return;
  console.log(
    `cache:sweep: cargo-sweep ${installed ?? 'is not installed'}; installing pinned ${CARGO_SWEEP_VERSION} (one-off, ~2 min).`,
  );
  // CARGO_TARGET_DIR unset so the install's throwaway build dir is cargo's own temp dir, not the shared cache.
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  const result = spawnSync('cargo', ['install', 'cargo-sweep', '--version', CARGO_SWEEP_VERSION, '--locked'], {
    stdio: 'inherit',
    env,
    windowsHide: true,
  });
  if (result.status !== 0) fail(`could not install cargo-sweep ${CARGO_SWEEP_VERSION}.`);
}

function freeBytesOn(dir) {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
}

function main() {
  const { days, dryRun } = parseArgs(process.argv.slice(2));
  try {
    requireSharedCargoTarget(repoRoot);
  } catch (err) {
    fail(err.message);
  }
  const targetDir = path.resolve(process.env.CARGO_TARGET_DIR);

  const held = heldCargoLocks(targetDir);
  if (held.length > 0) {
    fail(`a cargo build holds the target lock (${held.join(', ')}); wait for it to finish, then re-run. Nothing was deleted.`);
  }

  ensureCargoSweep();

  const before = dirSizeBytes(targetDir);
  const freeBefore = freeBytesOn(targetDir);
  console.log(`cache:sweep: ${targetDir} is ${formatGiB(before)}; removing artefacts unused for ${days}+ days${dryRun ? ' (dry run)' : ''}.`);

  // cargo-sweep resolves the target dir through `cargo metadata`, which honours CARGO_TARGET_DIR.
  const args = ['sweep', '--time', String(days), ...(dryRun ? ['--dry-run'] : []), path.join(repoRoot, 'src-tauri')];
  const result = spawnSync('cargo', args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) fail(`cargo sweep failed (exit ${result.status}${result.error ? `, ${result.error.message}` : ''}).`);

  if (dryRun) return;
  const after = dirSizeBytes(targetDir);
  const freeAfter = freeBytesOn(targetDir);
  console.log(`cache:sweep: shared target ${formatGiB(before)} -> ${formatGiB(after)}; drive free ${formatGiB(freeBefore)} -> ${formatGiB(freeAfter)}.`);
}

main();
