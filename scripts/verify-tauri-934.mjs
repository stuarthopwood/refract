#!/usr/bin/env node
// Live CDP check that Manage sessions renders the shared Session row, against a real built Tauri debug exe with fake
// `omp`/`gh`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_934_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-934.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, clickMenuItem, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_934_SHOTS_DIR || path.join(tmpdir(), 'refract-934-shots');
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

const GH_LOGIC = (logPath) => `
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(a) + '\\n');
if (a[0] === 'auth' && a[1] === 'status') {
  process.stdout.write(JSON.stringify({ hosts: { 'github.com': [{ host: 'github.com', login: 'octocat', active: true, state: 'success' }] } }));
  process.exit(0);
}
if (a[0] === 'auth' && a[1] === 'token') { process.stdout.write('fake-token-934\\n'); process.exit(0); }
process.stderr.write('fake gh 934: unsupported ' + JSON.stringify(a) + '\\n');
process.exit(1);
`;

function buildShims(dir) {
  mkdirSync(dir, { recursive: true });
  const ghLog = path.join(dir, 'gh-calls.log');
  writeFileSync(ghLog, '');
  writeFileSync(path.join(dir, 'gh-logic.cjs'), GH_LOGIC(ghLog));
  const build = (src, out) => {
    const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, src), '-o', path.join(dir, out)], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`rustc ${src} failed: ${r.stderr}`);
  };
  build('verify-tauri-omp-shim.rs', 'omp.exe');
  build('verify-1331-shim.rs', 'gh.exe');
  return { ghLog };
}

const ROW_LIST = `document.querySelector('ul[aria-label="All sessions across projects"]')`;
const manageRows = () => `Array.from(${ROW_LIST}?.querySelectorAll(':scope > li') ?? [])`;
const SIDEBAR_ROWS = `Array.from(document.querySelectorAll('[data-repository-id] li'))`;

async function openManage(cdp) {
  await sleep(1000);
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menuitem"]')`, { timeoutMs: 10_000, label: 'profile menu open' });
  await clickMenuItem(cdp, 'Manage sessions');
  await cdp.waitFor(`!!${ROW_LIST}`, { timeoutMs: 15_000, label: 'Manage sessions list rendered' });
}

async function backToChat(cdp) {
  await cdp.clickByLabel('Back to chat');
  await cdp.waitFor(`!${ROW_LIST}`, { timeoutMs: 15_000, label: 'left Manage sessions' });
}

async function sidebarSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const rows = ${SIDEBAR_ROWS};
    return {
      count: rows.length,
      tableOnly: rows.filter((li) => li.querySelector('.manage-session-open-button')).length,
      withSessionOpen: rows.filter((li) => li.querySelector('[data-session-open]')).length,
      withMenuTrigger: rows.filter((li) => li.querySelector('button[aria-label^="More actions for "]')).length,
      names: rows.map((li) => (li.querySelector('[data-session-open]')?.textContent || '').trim().slice(0, 40))
    };
  })()`);
}

async function runChecks(cdp, { repoA, repoB, repoAName, repoBName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoA);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project A rendered' });
  await addRepository(cdp, repoB);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project B rendered' });
  await createSessionViaQuickCreate(cdp, repoAName);
  await createSessionViaQuickCreate(cdp, repoAName);
  await createSessionViaQuickCreate(cdp, repoBName);

  // ---- Sidebar list BEFORE visiting Manage sessions ----
  const before = await sidebarSnapshot(cdp);
  log(`sidebar before: ${JSON.stringify(before)}`);
  await cdp.screenshot(path.join(SHOTS_DIR, '01-sidebar-before.png'));
  assert(before.count === 3 && before.withSessionOpen === 3 && before.tableOnly === 0, 'sidebar lists 3 Session rows in the card layout (no table-only class)');

  // ---- Manage sessions renders the shared row in its table layout ----
  await openManage(cdp);
  await cdp.waitFor(`${manageRows()}.length === 3`, { timeoutMs: 15_000, label: 'three Manage rows' });
  await cdp.screenshot(path.join(SHOTS_DIR, '02-manage-sessions.png'));
  const shape = await cdp.evaluate(`(() => {
    const rows = ${manageRows()};
    const cols = rows.map((li) => getComputedStyle(li.querySelector('.manage-session-open-button')).gridTemplateColumns.split(' ').length);
    return {
      count: rows.length,
      openButtons: rows.filter((li) => li.querySelector('button.manage-session-open-button')).length,
      quick: rows.filter((li) => li.querySelector('button[aria-label^="Archive session "]')).length,
      menu: rows.filter((li) => li.querySelector('button[aria-label^="More actions for "]')).length,
      projects: rows.map((li) => li.querySelector('.manage-session-open-button').children[2]?.textContent.trim()),
      cols,
      nestedButtons: rows.filter((li) => li.querySelector('.manage-session-open-button button')).length
    };
  })()`);
  log(`manage rows: ${JSON.stringify(shape)}`);
  assert(shape.openButtons === 3 && shape.quick === 3 && shape.menu === 3, 'every Manage row has the open button, Archive quick action and "..." trigger');
  assert(shape.cols.every((n) => n === 5) && shape.nestedButtons === 0, 'Manage rows keep the five-column grid and no nested buttons');

  // ---- Filter: search box ----
  const firstName = await cdp.evaluate(`${manageRows()}[0].querySelector('button[aria-label^="Archive session "]').getAttribute('aria-label').slice('Archive session '.length)`);
  await cdp.typeIntoByLabel('Filter sessions by name or branch', firstName);
  await cdp.waitFor(`${manageRows()}.length === 1`, { timeoutMs: 10_000, label: 'search narrows to Project B session' });
  await cdp.screenshot(path.join(SHOTS_DIR, '03-manage-filtered.png'));
  assert(true, 'search filter narrows 3 rows to 1');
  await cdp.click(`document.querySelector('button[aria-label^="Clear"]')`);
  await cdp.waitFor(`${manageRows()}.length === 3`, { timeoutMs: 10_000, label: 'filter cleared' });

  // ---- Row action: quick Archive, then the Archived tab, then Restore ----
  await cdp.click(`${manageRows()}[0].querySelector('button[aria-label^="Archive session "]')`);
  await cdp.waitFor(`${manageRows()}.filter((li) => li.querySelector('button[aria-label^="Restore session "]')).length === 1`, { timeoutMs: 15_000, label: 'one row now offers Restore' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'Archived')`);
  await cdp.waitFor(`${manageRows()}.length === 1`, { timeoutMs: 10_000, label: 'Archived tab lists the archived session' });
  await cdp.screenshot(path.join(SHOTS_DIR, '04-manage-archived-tab.png'));
  assert(true, 'quick Archive moved the row to the Archived tab');
  await cdp.click(`${manageRows()}[0].querySelector('button[aria-label^="Restore session "]')`);
  await cdp.waitFor(`${manageRows()}.length === 0`, { timeoutMs: 15_000, label: 'restored row leaves Archived tab' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'All')`);
  await cdp.waitFor(`${manageRows()}.length === 3`, { timeoutMs: 10_000, label: 'All tab back to 3 rows' });
  assert(true, 'quick Restore returned the row to the active list');

  // ---- Row action: "..." menu shares the sidebar's items; Rename uses the shared input ----
  await cdp.click(`${manageRows()}[0].querySelector('button[aria-label^="More actions for "]')`);
  const items = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent.trim())`);
  log(`manage "..." menu items: ${JSON.stringify(items)}`);
  await cdp.screenshot(path.join(SHOTS_DIR, '05-manage-row-menu.png'));
  assert(['Rename', 'Archive', 'Delete…'].every((t) => items.includes(t)), 'Manage "..." menu offers Rename, Archive and Delete');
  await clickMenuItem(cdp, 'Rename');
  await cdp.waitFor(`!!${ROW_LIST}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename input shown' });
  await cdp.screenshot(path.join(SHOTS_DIR, '06-manage-rename.png'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!${ROW_LIST}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename cancelled with Esc' });
  assert(true, 'Rename opens the shared input and Esc cancels it');

  // ---- Select: clicking a row opens the Session in chat ----
  await cdp.click(`${manageRows()}[0].querySelector('button.manage-session-open-button')`);
  await cdp.waitFor(`!${ROW_LIST} && !!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 20_000, label: 'row click opened the Session in chat' });
  await cdp.screenshot(path.join(SHOTS_DIR, '07-after-open-from-manage.png'));
  assert(true, 'clicking a Manage row leaves the screen and opens the Session in chat');

  // ---- Sidebar list AFTER: unchanged ----
  const after = await sidebarSnapshot(cdp);
  log(`sidebar after: ${JSON.stringify(after)}`);
  await cdp.screenshot(path.join(SHOTS_DIR, '08-sidebar-after.png'));
  assert(after.count === before.count && after.tableOnly === 0 && after.withSessionOpen === before.withSessionOpen && after.withMenuTrigger === before.withMenuTrigger, 'sidebar list is unchanged after the Manage sessions round trip');
  const diag = await cdp.evaluate(`({ btn: !!document.querySelector('[data-profile-name-button]'), menu: Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent.trim()) })`);
  log(`before reopen: ${JSON.stringify(diag)}`);
  await openManage(cdp);
  await backToChat(cdp);
  assert(true, 'Back to chat leaves Manage sessions');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-934: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, repoA, repoB, exeDir, child, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-934-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-934-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-934-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-934-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-934-repoA-')), 'A');
    repoB = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-934-repoB-')), 'B');
    const { ghLog } = buildShims(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const ompLog = path.join(SHOTS_DIR, 'fake-omp-invocations.log');
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
        REFRACT_FAKE_OMP_DEBUG_LOG: ompLog
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);

    await runChecks(cdp, { repoA, repoB, repoAName: path.basename(repoA), repoBName: path.basename(repoB) });

    await sleep(500);
    const ompCalls = existsSync(ompLog) ? readFileSync(ompLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length;
    log(`fake omp invocations logged: ${ompCalls}; fake gh calls logged: ${ghCalls}`);
    copyFileSync(ghLog, path.join(SHOTS_DIR, 'fake-gh-calls.log'));
    assert(ompCalls > 0, 'the fake omp was used (call log is non-empty)');
    assert(ghCalls > 0, 'the fake gh was used (call log is non-empty)');
    log(`verify-tauri-934: ALL PASS (${passed} checks) at head ${head}`);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA, repoB]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-934: FAIL');
  console.error(err);
  process.exitCode = 1;
});
