#!/usr/bin/env node
// Live CDP check that the app-wide polish (#1399, #1395, #1387, #1385) renders, against a real built Tauri debug exe with fake
// `omp`/`gh`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_071_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-071.mjs

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
const SHOTS_DIR = process.env.REFRACT_071_SHOTS_DIR || path.join(tmpdir(), 'refract-071-shots');
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
if (a[0] === 'auth' && a[1] === 'token') { process.stdout.write('fake-token-071\\n'); process.exit(0); }
process.stderr.write('fake gh 071: unsupported ' + JSON.stringify(a) + '\\n');
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

async function runChecks(cdp, { repoA, repoAName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoA);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  await createSessionViaQuickCreate(cdp, repoAName);

  // #1385: no logo row, inset divider, transparent title strips.
  await sleep(800);
  await cdp.screenshot(path.join(SHOTS_DIR, '01-sidebar-chrome.png'));
  const chrome = await cdp.evaluate(`(() => {
    const strips = Array.from(document.querySelectorAll('.titlebar-surface'));
    const sep = (Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project')?.closest('.p-2')?.previousElementSibling ?? null);
    return {
      stripBackgrounds: strips.map((el) => getComputedStyle(el).backgroundColor),
      logoImgs: document.querySelectorAll('aside img, nav img').length,
      separatorMarginLeft: sep ? getComputedStyle(sep).marginLeft : null
    };
  })()`);
  log(`chrome: ${JSON.stringify(chrome)}`);
  assert(chrome.stripBackgrounds.length > 0 && chrome.stripBackgrounds.every((c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'), '#1385: every title strip paints no background');
  assert(chrome.separatorMarginLeft === '8px', '#1385: the Add project divider is inset by 8px');

  // #1395: quiet fields and ghost Browse in the Add project dialog.
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Local folder…')`, { timeoutMs: 10_000, label: 'Add project menu' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Local folder…')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add dialog' });
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, '02-add-project-dialog.png'));
  const fields = await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input');
    const browse = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Browse');
    const s = getComputedStyle(input); const b = getComputedStyle(browse);
    return { inputBg: s.backgroundColor, inputBorder: s.borderTopColor, browseBg: b.backgroundColor, browseBorder: b.borderTopColor };
  })()`);
  log(`fields: ${JSON.stringify(fields)}`);
  assert(fields.inputBg === 'rgba(0, 0, 0, 0)', '#1395: the text field has no fill');
  assert(fields.browseBg === 'rgba(0, 0, 0, 0)' && fields.browseBorder === 'rgba(0, 0, 0, 0)', '#1395: Browse is a ghost button (no fill, no edge)');
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.screenshot(path.join(SHOTS_DIR, '03-field-focus.png'));
  const focusShadow = await cdp.evaluate(`getComputedStyle(document.querySelector('[role="dialog"] input')).boxShadow`);
  assert(focusShadow === 'none' || /0px 0px 0px 0px/.test(focusShadow), `#1395: focus shows no halo (box-shadow ${focusShadow})`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'dialog closed' });

  // #1399: ghost select triggers and matching panels in Manage sessions.
  await openManage(cdp);
  await cdp.screenshot(path.join(SHOTS_DIR, '04-manage-toolbar.png'));
  const trig = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-slot="select-trigger"]')).map((el) => { const s = getComputedStyle(el); return { h: el.getBoundingClientRect().height, bg: s.backgroundColor, border: s.borderTopColor, w: el.getBoundingClientRect().width }; })`);
  log(`triggers: ${JSON.stringify(trig)}`);
  assert(trig.length >= 2 && trig.every((t) => t.h === 32 && t.bg === 'rgba(0, 0, 0, 0)' && t.border === 'rgba(0, 0, 0, 0)'), '#1399: every Select trigger is a 32px ghost');
  await cdp.click(`document.querySelector('[data-slot="select-trigger"]')`);
  await cdp.waitFor(`!!document.querySelector('[data-slot="select-content"]')`, { timeoutMs: 10_000, label: 'select panel open' });
  await sleep(400);
  await cdp.screenshot(path.join(SHOTS_DIR, '05-select-open.png'));
  const panel = await cdp.evaluate(`(() => ({ panel: document.querySelector('[data-slot="select-content"]').getBoundingClientRect().width, trigger: document.querySelector('[data-slot="select-trigger"]').getBoundingClientRect().width, item: document.querySelector('[data-slot="select-item"]').getBoundingClientRect().height }))()`);
  log(`panel: ${JSON.stringify(panel)}`);
  assert(panel.panel >= panel.trigger - 1, '#1399: the dropdown is at least as wide as its trigger');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await backToChat(cdp);

  // #1387/#1399: Appearance settings (holiday picker, no Save row).
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  await cdp.screenshot(path.join(SHOTS_DIR, '06-settings.png'));
  assert(true, 'Settings renders with the quiet fields and ghost pickers');
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
}
async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-071: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, repoA, repoB_unused, exeDir, child, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-071-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-071-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-071-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-071-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-071-repoA-')), 'A');
    repoB_unused = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-071-repoB_unused-')), 'B');
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

    await runChecks(cdp, { repoA, repoB_unused, repoAName: path.basename(repoA), repoB_unusedName: path.basename(repoB_unused) });

    await sleep(500);
    const ompCalls = existsSync(ompLog) ? readFileSync(ompLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length;
    log(`fake omp invocations logged: ${ompCalls}; fake gh calls logged: ${ghCalls}`);
    copyFileSync(ghLog, path.join(SHOTS_DIR, 'fake-gh-calls.log'));
    assert(ompCalls > 0, 'the fake omp was used (call log is non-empty)');
    assert(ghCalls > 0, 'the fake gh was used (call log is non-empty)');
    log(`verify-tauri-071: ALL PASS (${passed} checks) at head ${head}`);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA, repoB_unused]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-071: FAIL');
  console.error(err);
  process.exitCode = 1;
});
