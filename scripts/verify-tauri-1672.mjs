#!/usr/bin/env node
// Live check for issue #1672: a session launch writes token-guard-overlay.yml with
// `cacheWarming: idle` and `softRequestBudget: 60` (a stored 80 is migrated away) and no `cacheRetention`.
// Drives the built debug exe (scratch copy) with scratch data and a fake `omp`; no model turn, no network.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1672.mjs
// Env: REFRACT_1672_OUT overrides where the overlay text is saved.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1672';
const PORT = 9272;
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const OUT = process.env.REFRACT_1672_OUT || path.join(tmpdir(), 'lane1672', 'overlay-live.yml');

async function main() {
  mkdirSync(path.dirname(OUT), { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1672-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1672-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1672-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1672-cache');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1672-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1672-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1672-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let child;
  let cdp;
  try {
    // A store from an earlier build holding the old default 80: the migration must drop it.
    writeFileSync(path.join(dataDir, 'token-guard.json'), JSON.stringify({ version: 2, overrides: { 'task.softRequestBudget': 80 }, read_limit_migrated: true, thresholds_reset_pending: false }));
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const launched = await launchBuiltExe(launcherExe, exe, {
      port: PORT,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(tmpdir(), 'lane1672', `app-${PORT}.log`),
      extraEnv: {
        OMP_PROFILE: 'verify-1672',
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(PORT, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(PORT, launched.targetPid)) throw new Error('CDP target not owned by launched pid');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));

    // The overlay directory is the app's choice, so search the whole scratch data dir.
    const find = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const r = find(p);
          if (r) return r;
        } else if (/^token-guard-overlay.*\.yml$/.test(e.name)) return p;
      }
      return null;
    };
    let file = null;
    for (let i = 0; i < 60 && !(file = find(dataDir)); i++) await sleep(500);
    if (!file) throw new Error(`no overlay file written under ${dataDir}`);
    const text = readFileSync(file, 'utf8');
    writeFileSync(OUT, text);
    console.log(`${LOG}: overlay ${file}\n${text}`);
    const checks = [
      ['cacheWarming idle', /^providers:\n {2}cacheWarming: "?idle"?$/m.test(text)],
      ['softRequestBudget 60', /^ {2}softRequestBudget: 60$/m.test(text)],
      ['no cacheRetention', !text.includes('cacheRetention')]
    ];
    for (const [label, ok] of checks) {
      console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}`);
      if (!ok) process.exitCode = 1;
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
}

main();
