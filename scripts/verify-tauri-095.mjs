#!/usr/bin/env node
// Live CDP check for spec 095 (issue #1080, composer Tab indent) against a built Tauri debug exe with the recorded-frame
// fake `omp` (session tape, no model cost), a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_095_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-095.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_095_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-095-shots-'));
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SHOTS = [];
let passed = 0;
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}
const shot = async (cdp, name) => {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  SHOTS.push(name);
};

const MESSAGE = `document.querySelector('textarea[aria-label="Message"]')`;
const VALUE = `${MESSAGE}.value`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SHIFT = 8;
const CTRL = 2;
async function key(cdp, { key: k, code, vk, modifiers = 0, text }) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await pause(150);
}
const tab = (cdp, modifiers = 0) => key(cdp, { key: 'Tab', code: 'Tab', vk: 9, modifiers });
const shiftEnter = (cdp) => key(cdp, { key: 'Enter', code: 'Enter', vk: 13, modifiers: SHIFT, text: '\r' });
const ctrlM = (cdp) => key(cdp, { key: 'm', code: 'KeyM', vk: 77, modifiers: CTRL });

async function reset(cdp, text) {
  await cdp.evaluate(`(() => { const t = ${MESSAGE}; t.focus(); t.select(); document.execCommand('delete'); })()`);
  if (text) await cdp.send('Input.insertText', { text });
  await pause(100);
}
const activeIsMessage = (cdp) => cdp.evaluate(`document.activeElement === ${MESSAGE}`);

async function withSession(tmp, exePath, launcherExe, shimDir, body) {
  const dataDir = tmp('data');
  const importDir = tmp('import');
  const repoDir = makeScratchRepo(tmp('repo'), 'verify-095');
  const port = await getFreePort();
  let child, cdp;
  try {
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir: importDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 60_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.waitFor(`!!${MESSAGE}`, { timeoutMs: 30_000, label: 'Composer' });
    try {
      await body(cdp);
    } catch (err) {
      await shot(cdp, 'fail.png').catch(() => {});
      throw err;
    }
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child).catch(() => {});
  }
}

async function check(cdp) {
  await reset(cdp, '- a');
  await tab(cdp);
  assert((await cdp.evaluate(VALUE)) === '  - a', 'Tab indents the line by two spaces');
  assert(await activeIsMessage(cdp), 'Focus stays in the composer after Tab');
  await shot(cdp, '01-indented.png');
  await cdp.evaluate(`document.execCommand('undo')`);
  await pause(100);
  assert((await cdp.evaluate(VALUE)) === '- a', 'One undo reverts the indent (native undo stack kept)');
  await tab(cdp);
  await tab(cdp, SHIFT);
  assert((await cdp.evaluate(VALUE)) === '- a', 'Shift+Tab outdents back');

  await reset(cdp, '```\nx');
  await tab(cdp);
  assert((await cdp.evaluate(VALUE)) === '```\nx\t', 'Tab inside a code fence inserts a literal tab');
  await shot(cdp, '02-fence-tab.png');

  await reset(cdp, 'a');
  await ctrlM(cdp);
  assert(await cdp.evaluate(`document.body.innerText.includes('Tab moves focus · Ctrl+M to indent')`), 'Ctrl+M shows the "Tab moves focus" hint');
  assert(await cdp.evaluate(`document.querySelector('[role="status"][aria-live="polite"]') !== null && Array.from(document.querySelectorAll('[role="status"]')).some((n) => n.textContent === 'Tab moves focus')`), 'The mode change is announced in the live region');
  await tab(cdp);
  assert(!(await activeIsMessage(cdp)), 'With focus mode on, Tab moves focus out of the composer');
  assert((await cdp.evaluate(VALUE)) === 'a', 'Tab did not edit the draft in focus mode');
  await shot(cdp, '03-tab-moves-focus.png');
  assert(!(await cdp.evaluate(`document.body.innerText.includes('Tab moves focus · Ctrl+M to indent')`)), 'The hint resets once focus leaves the box');
  await cdp.evaluate(`${MESSAGE}.focus()`);
  await tab(cdp);
  assert((await cdp.evaluate(VALUE)) === '  a' && (await activeIsMessage(cdp)), 'After the reset Tab indents again');

  await reset(cdp, '- one');
  await shiftEnter(cdp);
  assert((await cdp.evaluate(VALUE)) === '- one\n- ', 'Shift+Enter continues the list');
  await cdp.send('Input.insertText', { text: 'two' });
  await shiftEnter(cdp);
  await shot(cdp, '04-list-continued.png');
  await shiftEnter(cdp);
  assert((await cdp.evaluate(VALUE)) === '- one\n- two\n', 'Shift+Enter on an empty item ends the list');
  await reset(cdp, '1. a');
  await shiftEnter(cdp);
  assert((await cdp.evaluate(VALUE)) === '1. a\n2. ', 'Numbered lists increment');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-095: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-095-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let ok = false;
  try {
    const shimDir = tmp('shim');
    const launcherDir = tmp('launcher');
    const exeDir = tmp('exe');
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-095' });
    await withSession(tmp, built.dest, launcherExe, shimDir, check);
    log(`verify-tauri-095: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, screenshots: SHOTS, log: REPORT }, null, 2));
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-095: FAIL');
  console.error(err);
  process.exitCode = 1;
});
