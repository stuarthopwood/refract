#!/usr/bin/env node
// Right pane collapse toggle, Ctrl+Shift+B and persistence live check (#538, spec 024) against
// the scratch Tauri debug build. Reuses verify-tauri-735.mjs's isolation glue: scratch data dir,
// scratch exe copy, own CDP port, fake omp. Never touches %APPDATA%\refract-tauri.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject,
  isTargetOwningPort, assertExeMatchesProcess, createReportLogger, sleep
} from './verify-tauri-cdp.mjs';
import { groupTriggerFinder, createSessionViaQuickCreate, addRepository } from './verify-tauri-session-list-helpers.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOT_DIR = process.env.REFRACT_538_SHOT_DIR || path.join(tmpdir(), 'refract-538-shots');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
const assert = (cond, message) => { if (!cond) throw new Error(`ASSERTION FAILED: ${message}`); };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function rustc(src, out) {
  const r = run('rustc', ['--edition', '2021', '-O', path.join(__dirname, src), '-o', out]);
  if (r.status !== 0) throw new Error(`rustc ${src} failed: ${r.stderr}`);
  return out;
}

async function launch(launcherExe, exePath, { dataDir, importDir, shimDir, tag }) {
  const port = await getFreePort();
  const wv = path.join(path.dirname(exePath), `webview2-${stamp()}`);
  mkdirSync(wv, { recursive: true });
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: wv,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importDir,
    PATH: `${shimDir};${process.env.PATH}`,
    REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
    REFRACT_FAKE_OMP_NODE: process.execPath
  };
  const { child, targetPid } = await launchViaJobObject(launcherExe, path.join(path.dirname(exePath), `target-${stamp()}.pid`), exePath, [], { cwd: path.dirname(exePath), env });
  const stream = createWriteStream(path.join(SHOT_DIR, `app-${tag}.log`));
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  assert(isTargetOwningPort(port, targetPid), 'CDP target not owned by the launched pid');
  return { child, cdp, targetPid };
}

const TOGGLE = `document.querySelector('[data-rail-toggle]')`;
const expanded = (cdp) => cdp.evaluate(`${TOGGLE}?.getAttribute('aria-expanded')`);

async function ctrlShiftB(cdp) {
  const base = { modifiers: 10, key: 'B', code: 'KeyB', windowsVirtualKeyCode: 66 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-538-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-538-data-'));
  const importDir = mkdtempSync(path.join(tmpdir(), 'refract-538-import-'));
  const repoDir = mkdtempSync(path.join(tmpdir(), 'refract-538-repo-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-538-exe-'));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'v538'], ['config', 'user.email', 'v538@example.invalid'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    assert(run('git', ['-C', repoDir, ...args]).status === 0, `git ${args[0]} failed`);
  }
  rustc('verify-tauri-omp-shim.rs', path.join(shimDir, 'omp.exe'));
  const launcherExe = rustc('verify-tauri-launcher.rs', path.join(shimDir, 'verify-tauri-launcher.exe'));
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`built exe missing: ${src} (run pnpm exec tauri build --debug --no-bundle first)`);
  const exePath = path.join(exeDir, 'refract-tauri.exe');
  copyFileSync(src, exePath);
  const exeHash = createHash('sha256').update(readFileSync(exePath)).digest('hex');
  log(`exe ${exePath} sha256 ${exeHash}; data dir ${dataDir}`);

  let child, cdp;
  try {
    ({ child, cdp, targetPid: globalThis.__pid } = await launch(launcherExe, exePath, { dataDir, importDir, shimDir, tag: 'run1' }));
    assertExeMatchesProcess(globalThis.__pid, exePath, exeHash);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.waitFor(groupTriggerFinder(path.basename(repoDir)) + ' !== undefined', { timeoutMs: 15_000, label: 'repo group' });
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.waitFor(`!!${TOGGLE}`, { timeoutMs: 15_000, label: 'rail toggle rendered' });

    assert((await expanded(cdp)) === 'false', 'pane starts collapsed (aria-expanded=false)');
    await cdp.screenshot(path.join(SHOT_DIR, '01-collapsed.png'));
    log('STEP PASS: rail toggle present, pane starts collapsed.');

    await cdp.click(TOGGLE);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5000, label: 'expanded by click' });
    await cdp.waitFor(`!!document.querySelector('[data-panel-launcher]')`, { timeoutMs: 5000, label: 'launcher shown' });
    await cdp.screenshot(path.join(SHOT_DIR, '02-expanded-launcher.png'));
    log('STEP PASS: clicking the toggle expands the pane to the launcher.');

    await cdp.click(`document.querySelector('[data-rail-button="file-explorer"]')`);
    await cdp.waitFor(`document.querySelector('[data-rail-button="file-explorer"]')?.getAttribute('aria-pressed') === 'true'`, { timeoutMs: 5000, label: 'file explorer open' });
    await cdp.click(`document.querySelector('[data-rail-button="side-chat"]')`);
    await cdp.waitFor(`document.querySelector('[data-rail-button="side-chat"]')?.getAttribute('aria-pressed') === 'true'`, { timeoutMs: 5000, label: 'side chat open' });

    await cdp.click(TOGGLE);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5000, label: 'collapsed by click' });
    await cdp.screenshot(path.join(SHOT_DIR, '03-collapsed-with-tabs.png'));
    await ctrlShiftB(cdp);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5000, label: 'expanded by Ctrl+Shift+B' });
    const widthBefore = await cdp.evaluate(`Math.round(document.querySelector('[data-right-pane-shell]').getBoundingClientRect().width)`);
    await cdp.screenshot(path.join(SHOT_DIR, '04-expanded-by-shortcut.png'));
    log(`STEP PASS: collapse by click, expand by Ctrl+Shift+B; two panels kept; pane width ${widthBefore}px.`);

    await sleep(1200);
    const saved = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).rightPane;
    writeFileSync(path.join(SHOT_DIR, 'settings-rightPane-run1.json'), JSON.stringify(saved, null, 2));
    assert(saved?.open === true && saved.openPanelIds.join() === 'file-explorer,side-chat' && saved.activePanelId === 'side-chat', `settings.json rightPane wrong: ${JSON.stringify(saved)}`);
    log(`STEP PASS: settings.json rightPane persisted: ${JSON.stringify(saved)}`);

    cdp.close(); cdp = null;
    await stopLauncher(child); child = null;
    ({ child, cdp, targetPid: globalThis.__pid } = await launch(launcherExe, exePath, { dataDir, importDir, shimDir, tag: 'run2' }));
    assertExeMatchesProcess(globalThis.__pid, exePath, exeHash);
    await cdp.waitFor(`!!${TOGGLE}`, { timeoutMs: 60_000, label: 'rail toggle after restart' });
    await sleep(1500);
    await cdp.screenshot(path.join(SHOT_DIR, '05-after-restart.png'));
    const after = await cdp.evaluate(`({ exp: ${TOGGLE}.getAttribute('aria-expanded'), fe: document.querySelector('[data-rail-button="file-explorer"]')?.getAttribute('aria-pressed'), sc: document.querySelector('[data-rail-button="side-chat"]')?.getAttribute('aria-pressed'), w: Math.round(document.querySelector('[data-right-pane-shell]').getBoundingClientRect().width) })`);
    log(`after restart: ${JSON.stringify(after)}`);
    assert(after.exp === 'true' && after.sc === 'true', `open pane and active tab must survive restart: ${JSON.stringify(after)}`);
    assert(Math.abs(after.w - widthBefore) <= 2, `width must survive restart (${widthBefore} -> ${after.w})`);

    await ctrlShiftB(cdp);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5000, label: 'collapsed after restart' });
    await sleep(1200);
    await ctrlShiftB(cdp);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5000, label: 're-expanded' });
    await sleep(400);
    const w2 = await cdp.evaluate(`Math.round(document.querySelector('[data-right-pane-shell]').getBoundingClientRect().width)`);
    assert(Math.abs(w2 - widthBefore) <= 2, `width must survive collapse/expand after restart (${widthBefore} -> ${w2})`);
    await cdp.screenshot(path.join(SHOT_DIR, '06-reexpanded-after-restart.png'));
    log('STEP PASS: open state, both tabs, active tab and width survive a restart; collapse/expand after restart keeps the width.');
    log(`ALL PASS. Evidence: ${SHOT_DIR}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
