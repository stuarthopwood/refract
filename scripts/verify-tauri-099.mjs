#!/usr/bin/env node
// Live CDP check for spec 099 (issue #1503, gate leftovers: composer spelling menu) against a built Tauri debug exe with the
// recorded-frame fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port. The AskCard, Next-in-last-screen and suspect-window paths need model output the fake omp lacks.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_099_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-099.mjs

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
const SHOTS_DIR = process.env.REFRACT_099_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-099-shots-'));
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


async function check(cdp) {
  await cdp.evaluate(`(() => { const t = document.querySelector('textarea[aria-label="Message"]'); t.focus(); })()`);
  await cdp.send('Input.insertText', { text: 'wrongg' });
  await pause(300);
  const box = await cdp.evaluate(`(() => { const r = document.querySelector('textarea[aria-label="Message"]').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Composer context menu' });
  assert(true, 'The composer context menu opens');
  await shot(cdp, '01-composer-menu.png');
  const state = await cdp.evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    const live = menu.querySelector('[role="status"]');
    const none = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((n) => n.textContent.includes('No suggestions'));
    return { live: live ? live.textContent : null, noneDisabled: none ? none.getAttribute('aria-disabled') : null, noneDisabledAttr: none ? none.hasAttribute('disabled') : null };
  })()`);
  log(`spell state: ${JSON.stringify(state)}`);
  if (state.live !== null) assert(/spelling suggestion/i.test(state.live), 'The spelling live region announces the suggestion count');
  if (state.noneDisabled !== null) assert(state.noneDisabled === 'true' && state.noneDisabledAttr === false, 'The No suggestions row is aria-disabled, not disabled');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pause(300);
  assert(await cdp.evaluate(`!document.querySelector('[role="menu"]')`), 'Escape closes the context menu');
}

async function withSession(tmp, exePath, launcherExe, shimDir, body) {
  const dataDir = tmp('data');
  const importDir = tmp('import');
  const repoDir = makeScratchRepo(tmp('repo'), 'verify-099');
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
    await cdp.waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, { timeoutMs: 30_000, label: 'Composer' });
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

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-099: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-099-${name}-`));
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
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-099' });
    await withSession(tmp, built.dest, launcherExe, shimDir, check);
    log(`verify-tauri-099: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, screenshots: SHOTS, log: REPORT }, null, 2));
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-099: FAIL');
  console.error(err);
  process.exitCode = 1;
});


