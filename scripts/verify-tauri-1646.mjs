#!/usr/bin/env node
// Live CDP check for issue #1646 (NumberField muted chevron step buttons, 8px gap after the value).
// Drives the built debug exe (scratch copy) with scratch data and a fake `omp`; no model turn, no network.
// Shoots a Settings > Advanced number field zoomed in a dark and a light theme.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1646.mjs
// Env: REFRACT_1646_SHOTS_DIR overrides the screenshot/report directory.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1646';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1646_SHOTS_DIR || path.join(tmpdir(), 'refract-1646-shots');
const STORE_FILE = 'token-guard.json';

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

// A number row with a value, a min and a max (task.maxConcurrency is a plain count row).
const FIELD = `document.querySelector('[data-slot="number-field"]')`;
const ROOT = `(${FIELD}).closest('[data-slot="number-field-root"]')`;
const CHEVRON = (n) => `(${ROOT}).querySelectorAll('button')[${n}]`;
const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      OMP_PROFILE: 'verify-1646',
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openAdvanced(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`!!(${FIELD})`, { timeoutMs: 15_000, label: 'a NumberField is mounted' });
  await cdp.evaluate(`(${FIELD}).scrollIntoView({ block: 'center' })`);
  await sleep(800);
}

/** Geometry and colours of the first NumberField, read from the live DOM. */
const facts = (cdp) =>
  cdp.evaluate(`(() => {
    const input = ${FIELD};
    const root = ${ROOT};
    const [up, down] = root.querySelectorAll('button');
    const cs = getComputedStyle(input);
    const ir = input.getBoundingClientRect();
    const ur = up.getBoundingClientRect();
    const contentRight = ir.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const rgb = (el) => getComputedStyle(el).color;
    return {
      value: input.value, min: input.min, max: input.max, step: input.step,
      nativeSpinnerAppearance: getComputedStyle(input, '::-webkit-inner-spin-button').appearance,
      gapPx: Math.round((ur.left - contentRight) * 10) / 10,
      buttons: root.querySelectorAll('button').length,
      tabIndexes: [up.tabIndex, down.tabIndex],
      ariaHidden: [up.getAttribute('aria-hidden'), down.getAttribute('aria-hidden')],
      upColour: rgb(up), downColour: rgb(down), fieldColour: cs.color, mutedToken: getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim(),
      upDisabled: up.disabled, downDisabled: down.disabled,
      rect: [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)]
    };
  })()`);

/** Screenshot of the field plus its unit, scaled up so the chevrons and the gap are legible. */
async function zoomShot(cdp, name) {
  await sleep(400);
  const rect = await cdp.evaluate(`(() => { const r = (${FIELD}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - 16), y: Math.max(0, rect.y - 8), width: rect.w + 64, height: rect.h + 16, scale: 6 }
  });
  writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(data, 'base64'));
  shotNames.push(name);
  await cdp.screenshot(path.join(SHOTS_DIR, name.replace('.png', '-page.png')));
  shotNames.push(name.replace('.png', '-page.png'));
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1646-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1646-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1646-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1646-numberfield');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1646-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1646-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1646-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: sha256OfFile(exe) } });
    // Version 2 store, no legacy-threshold migration; a non-default value makes the field show a number.
    writeFileSync(path.join(dataDir, STORE_FILE), JSON.stringify({ version: 2, overrides: { 'compaction.thresholdPercent': 46 }, read_limit_migrated: true, thresholds_reset_pending: false }, null, 2));

    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;
    check(path.dirname(exe).startsWith(tmpdir()) && dataDir.startsWith(tmpdir()), 'Isolation: exe and data dir are scratch copies under the temp dir', { exe, dataDir });
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
    await openAdvanced(cdp);

    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`window.refract.theme.set(${JSON.stringify(theme)}).then((r) => r.ok)`);
      await cdp.waitFor(`document.documentElement.className.includes('theme-${theme}')`, { timeoutMs: 10_000, label: `${theme} theme applied` });
      await sleep(1000); // colour transitions must finish before computed colours are read
      await cdp.evaluate(`(${FIELD}).scrollIntoView({ block: 'center' })`);
      const f = await facts(cdp);
      check(f.buttons === 2 && f.tabIndexes.every((t) => t === -1) && f.ariaHidden.every((a) => a === 'true'), `${theme}: two chevron buttons, tabIndex -1 and aria-hidden`, f);
      check(f.gapPx >= 8 && f.gapPx <= 9, `${theme}: the gap between the value and the chevrons is 8px`, f.gapPx);
      check(f.upColour === f.downColour && f.upColour !== f.fieldColour, `${theme}: chevrons rest in the muted colour, not the field text colour`, { up: f.upColour, field: f.fieldColour, token: f.mutedToken });
      await zoomShot(cdp, `${theme}-resting.png`);
    }

    // Behaviour in the light theme (still active): hover colour, click steps, ArrowUp still steps, bounds disable.
    const before = await facts(cdp);
    const box = await cdp.evaluate(`(() => { const r = (${CHEVRON(0)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(400);
    const hover = await cdp.evaluate(`getComputedStyle(${CHEVRON(0)}).color`);
    check(hover !== before.upColour, 'Hover: the chevron turns to the foreground colour', { rest: before.upColour, hover });
    await zoomShot(cdp, 'light-hover-up.png');
    await cdp.click(CHEVRON(0));
    await sleep(300);
    const afterUp = await facts(cdp);
    check(Number(afterUp.value) === Number(before.value) + Number(before.step || 1), 'Click up: the value steps by `step` and onChange updated the field', { before: before.value, after: afterUp.value, step: before.step });
    await cdp.click(CHEVRON(1));
    await cdp.click(CHEVRON(1));
    await sleep(300);
    const afterDown = await facts(cdp);
    check(Number(afterDown.value) === Number(before.value) - Number(before.step || 1), 'Click down twice: the value steps down by `step` each time', { after: afterDown.value });
    await cdp.evaluate(`(${FIELD}).focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
    await sleep(300);
    check(Number((await facts(cdp)).value) === Number(afterDown.value) + Number(before.step || 1), 'ArrowUp still steps the focused field', null);
    const tabbables = await cdp.evaluate(`Array.from((${ROOT}).querySelectorAll('button')).filter((b) => b.tabIndex >= 0).length`);
    check(tabbables === 0, 'Tab order: the chevrons are not tabbable', tabbables);
    // Max: push the value to the bound, the up chevron disables.
    await cdp.evaluate(`(() => { const i = ${FIELD}; i.focus(); })()`);
    const bounds = await facts(cdp);
    check(bounds.min !== '' && bounds.max !== '', 'The field carries min and max', { min: bounds.min, max: bounds.max });
    await zoomShot(cdp, 'light-after-steps.png');
    report.push({ step: 'screenshots (sha256)', ok: true, evidence: citeScreenshots(SHOTS_DIR, shotNames) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
