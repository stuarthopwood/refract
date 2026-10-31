#!/usr/bin/env node
// Live CDP check for spec 079 (#579 slices D to F: menu icons, PanelHeader 40 px rows) against a real built
// Tauri debug exe with fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_079_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-079.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_079_SHOTS_DIR || path.join(tmpdir(), 'refract-079-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const THEMES = ['theme-dark', 'theme-dark-high-contrast', 'theme-nordic-frost', 'theme-cyber-amber'];

const REPORT = [];
let passed = 0;
function log(line) {
  console.log(line);
  REPORT.push(line);
}
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}

const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));
const setTheme = (cdp, cls) =>
  cdp.evaluate(`(() => { const r = document.documentElement; for (const c of Array.from(r.classList)) if (c.startsWith('theme-')) r.classList.remove(c); r.classList.add('dark', ${JSON.stringify(cls)}); return true; })()`);

const HEADER_ROWS = `Array.from(document.querySelectorAll('.drag-region.titlebar-surface, [data-titlebar-band]')).map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className.slice(0, 60), h: Math.round(r.height) }; }).filter((x) => x.h > 0)`;

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(path.basename(repoDir)) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });

  for (const cls of THEMES) {
    await setTheme(cdp, cls);
    await sleep(300);
    const rows = await cdp.evaluate(HEADER_ROWS);
    log(`header rows in ${cls}: ${JSON.stringify(rows)}`);
    assert(rows.length > 0 && rows.every((r) => r.h === 40), `every title-bar row is 40 px in ${cls}`);
    await shot(cdp, `after-${cls}-main.png`);
  }

  await setTheme(cdp, 'theme-dark');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-079: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-079-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-079-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-079-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-079-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-079-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_079_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-079: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-079: FAIL');
  console.error(err);
  process.exitCode = 1;
});
