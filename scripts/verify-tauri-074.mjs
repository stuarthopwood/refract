#!/usr/bin/env node
// Live CDP check for spec 074 (#935: shared ConfirmAlertDialog on the Remove project dialog) against a real built Tauri debug exe
// with fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_074_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-074.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_074_SHOTS_DIR || path.join(tmpdir(), 'refract-074-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

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

const DIALOG = `document.querySelector('[data-slot="alert-dialog-content"]')`;
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));

async function openRemoveDialog(cdp, repoName) {
  await cdp.click(`document.querySelector('[aria-label=${JSON.stringify(`More actions for ${repoName}`)}]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`, { timeoutMs: 10_000, label: 'menu open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`);
  await cdp.waitFor(`!!${DIALOG}`, { timeoutMs: 10_000, label: 'Remove project dialog open' });
}

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  const repoName = path.basename(repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });

  await openRemoveDialog(cdp, repoName);
  await cdp.waitFor(`document.activeElement?.textContent?.trim() === 'Cancel'`, { timeoutMs: 5_000, label: 'Cancel autofocused' });
  await shot(cdp, '01-remove-project-dialog.png');
  const info = await cdp.evaluate(`(() => {
    const d = ${DIALOG};
    const btns = Array.from(d.querySelectorAll('button')).map((b) => ({ text: b.textContent.trim(), slot: b.getAttribute('data-slot') }));
    return { role: d.getAttribute('role'), title: d.querySelector('[data-slot="alert-dialog-title"]')?.textContent, btns, alerts: d.querySelectorAll('[role="alert"]').length };
  })()`);
  log(`dialog: ${JSON.stringify(info)}`);
  assert(info.role === 'alertdialog', 'the Remove project dialog is an alertdialog');
  assert(info.btns.some((b) => b.text === 'Cancel') && info.btns.some((b) => b.text === 'Remove'), 'Cancel and Remove buttons come from the shared dialog');

  await cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Cancel')`);
  await cdp.waitFor(`!${DIALOG}`, { timeoutMs: 10_000, label: 'dialog closed by Cancel' });
  await cdp.waitFor(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(`More actions for ${repoName}`)}`, { timeoutMs: 5_000, label: 'focus restored' });
  const focusName = await cdp.evaluate(`document.activeElement?.getAttribute('aria-label') ?? ''`);
  log(`focus after cancel: ${focusName}`);
  assert(focusName === `More actions for ${repoName}`, 'focus returns to the Project actions trigger after Cancel');
  await shot(cdp, '02-after-cancel.png');

  await openRemoveDialog(cdp, repoName);
  await cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Remove')`);
  await cdp.waitFor(`!${DIALOG}`, { timeoutMs: 15_000, label: 'dialog closed by Remove' });
  await cdp.waitFor(`!(${groupTriggerFinder(repoName)})`, { timeoutMs: 15_000, label: 'Project removed' });
  await shot(cdp, '03-after-remove.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-074: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-074-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-074-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-074-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-074-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-074-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_074_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    log(`verify-tauri-074: ALL PASS (${passed} checks) at head ${head}`);
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
  console.error('verify-tauri-074: FAIL');
  console.error(err);
  process.exitCode = 1;
});
