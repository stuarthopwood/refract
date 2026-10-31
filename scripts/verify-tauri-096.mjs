#!/usr/bin/env node
// Live CDP check for spec 096 (issue #1310, new session from an issue or pull request) against a built Tauri debug exe with the
// recorded-frame fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port. The scratch repo has no GitHub remote, so this
// exercises the palette entries and the dialog's link validation, not the `gh` calls.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_096_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-096.mjs

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
const SHOTS_DIR = process.env.REFRACT_096_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-096-shots-'));
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

const CTRL = 2;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const ITEM = `document.getElementById('session-item')`;

async function openPalette(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: CTRL });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: CTRL });
  await pause(300);
}

async function check(cdp) {
  await openPalette(cdp);
  await cdp.send('Input.insertText', { text: 'New session from' });
  await pause(300);
  const text = await cdp.evaluate(`document.body.innerText`);
  assert(text.includes('New session from issue') && text.includes('New session from pull request'), 'The palette lists both new-session-from entries');
  await shot(cdp, '01-palette.png');

  await cdp.evaluate(`(() => { const o = Array.from(document.querySelectorAll('[role="option"]')).find((n) => n.textContent.includes('New session from issue')); o && o.click(); })()`);
  await cdp.waitFor(`!!${ITEM}`, { timeoutMs: 10_000, label: 'Item field' });
  assert(await cdp.evaluate(`${DIALOG}.textContent.includes('New session from an issue')`), 'The issue entry opens the dialog in issue mode');
  await shot(cdp, '02-issue-dialog.png');

  await cdp.evaluate(`(() => { const i = ${ITEM}; i.focus(); })()`);
  await cdp.send('Input.insertText', { text: 'not a link' });
  await pause(200);
  assert(await cdp.evaluate(`${ITEM}.getAttribute('aria-invalid') === 'true'`), 'An invalid link marks the field invalid');
  assert(await cdp.evaluate(`Array.from(${DIALOG}.querySelectorAll('button')).some((b) => /create|start/i.test(b.textContent) && b.disabled)`), 'An invalid link blocks submit');
  await shot(cdp, '03-invalid-link.png');

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pause(300);
  assert(await cdp.evaluate(`!${DIALOG}`), 'Escape closes the dialog');
}

async function withSession(tmp, exePath, launcherExe, shimDir, body) {
  const dataDir = tmp('data');
  const importDir = tmp('import');
  const repoDir = makeScratchRepo(tmp('repo'), 'verify-096');
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
  log(`verify-tauri-096: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-096-${name}-`));
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
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-096' });
    await withSession(tmp, built.dest, launcherExe, shimDir, check);
    log(`verify-tauri-096: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, screenshots: SHOTS, log: REPORT }, null, 2));
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-096: FAIL');
  console.error(err);
  process.exitCode = 1;
});
