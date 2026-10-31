#!/usr/bin/env node
// Live CDP check for spec 082 UI paths (Home, Settings, ChatHeader) against a built Tauri debug exe with fake `omp`,
// a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_082_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-082-ui.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_082_SHOTS_DIR || path.join(tmpdir(), 'refract-082-shots');
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
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  const repoName = path.basename(repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  await createSessionViaQuickCreate(cdp, repoName);

  await cdp.waitFor(`!!document.querySelector('button[aria-label="Find in chat"]')`, { timeoutMs: 15_000, label: 'ChatHeader find button' });
  const header = await cdp.evaluate(`(() => {
    const q = (l) => document.querySelector('button[aria-label="' + l + '"]');
    const box = (b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const find = q('Find in chat');
    const pause = q('Pause after this turn');
    const close = document.querySelector('button[aria-label^="Close "][aria-label$=" chat pane"]');
    return { find: box(find), findKeys: find.getAttribute('aria-keyshortcuts'), pause: pause ? box(pause) : null, close: close ? box(close) : null, closeKeys: close?.getAttribute('aria-keyshortcuts') ?? null };
  })()`);
  log(`chat header: ${JSON.stringify(header)}`);
  await shot(cdp, '01-chat-header.png');
  assert(header.find.w >= 24 && header.find.h >= 24, 'ChatHeader find button is at least 24 px');
  assert(!!header.findKeys, 'ChatHeader find button exposes aria-keyshortcuts');
  if (header.pause) assert(header.pause.w >= 24 && header.pause.h >= 24, 'ChatHeader pause button is at least 24 px and named like its tooltip');
  if (header.close) assert(header.close.w >= 24 && !!header.closeKeys, 'ChatHeader close button is at least 24 px with aria-keyshortcuts');

  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  const weight = await cdp.evaluate(`getComputedStyle(document.querySelector('h1')).fontWeight`);
  log(`settings h1 weight: ${weight}`);
  await shot(cdp, '02-settings.png');
  assert(Number(weight) === 600, 'Settings h1 is semibold (600)');
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await sleep(400);

  assert(await cdp.evaluate(`!document.body.textContent.includes('See all')`), 'No "See all" link remains (Show all wording)');
  await shot(cdp, '03-after-settings.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-082-ui: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-082-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-082-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-082-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-082-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-082-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_082_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    log(`verify-tauri-082-ui: ALL PASS (${passed} checks) at head ${head}`);
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
  console.error('verify-tauri-082-ui: FAIL');
  console.error(err);
  process.exitCode = 1;
});
