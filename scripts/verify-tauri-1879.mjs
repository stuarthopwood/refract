#!/usr/bin/env node
// Live CDP check for #1879 (the `task` model role is labelled "Task", not "Subagent") against a real built Tauri debug
// exe with fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1879_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1879.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, safeRmSync, requireSharedCargoTarget, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1879_SHOTS_DIR || path.join(tmpdir(), 'refract-1879-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS: ${message}`);
  REPORT.push(`PASS: ${message}`);
}

// The task role's label is `<label id="model-role-task-label">` (SettingRow.tsx:53 builds `${id}-label`; RoleRow.tsx:60,105
// passes id `model-role-${role}`), so scope the text match to that element rather than any "Task" text in the page.
const TASK_LABEL_SELECTOR = '#model-role-task-label';
const leafWithText = (text) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(`${TASK_LABEL_SELECTOR}, ${TASK_LABEL_SELECTOR} *`)})).find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)})`;

async function runChecks(cdp) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Models')`);
  await sleep(800);
  await cdp.waitFor(`!!(${leafWithText('Task')})`, { timeoutMs: 10_000, label: 'Models section shows a Task row' });
  await cdp.evaluate(`(${leafWithText('Task')}).scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, '01-settings-task-role.png'));
  assert(await cdp.evaluate(`!!(${leafWithText('Task')})`), '#1879: Settings model roles list a "Task" row');
  assert(await cdp.evaluate(`!(${leafWithText('Subagent')})`), '#1879: no Settings model role is still labelled "Subagent"');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`verify-tauri-1879: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, child, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1879-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1879-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-1879-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1879-exe-'));
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_1879_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    console.log(`verify-tauri-1879: exe copied to ${exePath} (sha256 ${sha256OfFile(exePath)})`);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await runChecks(cdp);
    console.log(`verify-tauri-1879: ALL PASS at head ${head}`);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-1879: FAIL');
  console.error(err);
  process.exitCode = 1;
});
