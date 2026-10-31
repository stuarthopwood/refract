#!/usr/bin/env node
// Live CDP check for spec 103 (issue #1439): non-US backslash chord, Ctrl+, , Ctrl+Shift+X on a long turn, repo header menu labels.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_103_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-103.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressKey, rightClick, groupTriggerFinder, clickMenuItem } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_103_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-103-shots-'));
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SHOTS = [];
const STEPS = [];
const SKIPPED = [
  'Tree node menu, Checks section, git change rows, link menus, quick actions: need real gh or git state, not reachable with the fake omp',
  'DevTools Inspect: stays blocked by decision',
  'Ellipsis-click survival: not reproduced, no change'
];
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  STEPS.push(message);
  log(`PASS: ${message}`);
}
const shot = async (cdp, name) => {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  SHOTS.push(name);
};

const CTRL = 2;
const SHIFT = 8;
const TINTS = `Array.from(document.querySelectorAll('[data-focused-pane-tint]')).map((el) => el.getAttribute('data-focused-pane-tint')).join(',')`;
const MENU_LABELS = `Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent.trim())`;

async function checkRepoMenus(cdp, repoName) {
  const trigger = `document.querySelector('[aria-label="Project actions for ${repoName}"]')`;
  const rect = await cdp.evaluate(`(() => { const r = ${trigger}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.click(trigger);
  await cdp.waitFor(`${MENU_LABELS}.includes('Remove project…')`, { timeoutMs: 10_000, label: 'ellipsis menu open' });
  let labels = await cdp.evaluate(MENU_LABELS);
  await shot(cdp, '01-repo-ellipsis-menu.png');
  assert(labels.includes('Project colour…') && labels.includes('GitHub report…') && !labels.includes('Colour…') && !labels.includes('Report an issue…'), `Repo header "..." menu reads Project colour… and GitHub report… (${labels.join(' | ')})`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'ellipsis menu closed' });
  await rightClick(cdp, groupTriggerFinder(repoName));
  await cdp.waitFor(`${MENU_LABELS}.includes('Remove project…')`, { timeoutMs: 10_000, label: 'context menu open' });
  labels = await cdp.evaluate(MENU_LABELS);
  await shot(cdp, '02-repo-context-menu.png');
  assert(labels.includes('Project colour…') && labels.includes('GitHub report…'), `Repo header right-click menu shows the same labels (${labels.join(' | ')})`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'context menu closed' });
}

async function checkStopChord(cdp) {
  await cdp.typeIntoByLabel('Message', 'Run the long command.');
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`/sleep/i.test(document.body.innerText)`, { timeoutMs: 30_000, label: 'long turn is working' });
  await shot(cdp, '03-working.png');
  await cdp.evaluate(`document.activeElement?.blur?.()`);
  await pressKey(cdp, 88, 'X', 'KeyX', CTRL | SHIFT);
  await cdp.waitFor(`/abort|stopped/i.test(document.body.innerText)`, { timeoutMs: 20_000, label: 'turn stopped by Ctrl+Shift+X' });
  await shot(cdp, '04-stopped.png');
  assert(true, 'Ctrl+Shift+X stopped a working turn (fake-omp stop-911 abort shown)');
}

async function checkSplitChord(cdp, repoName) {
  await createSessionViaQuickCreate(cdp, repoName);
  const rows = `Array.from(document.querySelectorAll('[data-repository-id] li [data-session-open]'))`;
  await cdp.waitFor(`${rows}.length >= 2`, { timeoutMs: 15_000, label: 'two session rows' });
  await rightClick(cdp, `${rows}[1]`);
  await clickMenuItem(cdp, 'Open in split');
  await cdp.waitFor(`document.querySelectorAll('[data-focused-pane-tint]').length === 2`, { timeoutMs: 15_000, label: 'split view with two panes' });
  await cdp.evaluate(`document.activeElement?.blur?.()`);
  const before = await cdp.evaluate(TINTS);
  await shot(cdp, '05-split-before.png');
  await pressKey(cdp, 220, '|', 'IntlBackslash', CTRL | SHIFT);
  await cdp.waitFor(`${TINTS} !== ${JSON.stringify(before)}`, { timeoutMs: 5_000, label: 'focus moved (IntlBackslash, key |)' });
  const mid = await cdp.evaluate(TINTS);
  await shot(cdp, '06-split-after-intl.png');
  assert(mid !== before, `Ctrl+Shift+| on IntlBackslash moves pane focus (${before} -> ${mid})`);
  await pressKey(cdp, 220, '\\', 'Backslash', CTRL | SHIFT);
  await cdp.waitFor(`${TINTS} !== ${JSON.stringify(mid)}`, { timeoutMs: 5_000, label: 'focus moved back (Backslash)' });
  assert((await cdp.evaluate(TINTS)) === before, 'Ctrl+Shift+\\ on Backslash moves pane focus back');
}

async function checkSettingsChord(cdp) {
  await cdp.evaluate(`document.activeElement?.blur?.()`);
  await pressKey(cdp, 188, ',', 'Comma', CTRL);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('h1')).find((h) => h.textContent.trim() === 'Settings')`, { timeoutMs: 10_000, label: 'Settings open' });
  await shot(cdp, '07-settings.png');
  assert(true, 'Ctrl+, opens Settings');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-103: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-103-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let ok = false;
  let child;
  let cdp;
  try {
    const shimDir = tmp('shim');
    const launcherDir = tmp('launcher');
    const exeDir = tmp('exe');
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-103' });
    const repoDir = makeScratchRepo(path.join(tmp('repo'), 'hello-103'), 'verify-103');
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/octocat/hello-103.git'], { windowsHide: true });
    const repoName = path.basename(repoDir);
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: tmp('data'),
      importSourceDir: tmp('import'),
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stop-911'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    // The remote is detected on the next throttled window-focus sweep.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await checkRepoMenus(cdp, repoName);
    await checkStopChord(cdp);
    await checkSplitChord(cdp, repoName);
    await checkSettingsChord(cdp);
    log(`verify-tauri-103: ALL STEPS PASS (${STEPS.length}) at head ${head}`);
    ok = true;
  } catch (err) {
    if (cdp) await shot(cdp, 'fail.png').catch(() => {});
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child).catch(() => {});
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, steps: STEPS, skipped: SKIPPED, screenshots: SHOTS }, null, 2));
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-103: FAIL');
  console.error(err);
  process.exitCode = 1;
});
