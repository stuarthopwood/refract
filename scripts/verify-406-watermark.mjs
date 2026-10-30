#!/usr/bin/env node
// Live CDP check for spec 012 / issue #406 (brand watermark): drives a debug exe built from
// current main against the FAKE `omp` and FAKE `gh` shims (the real gh account never answers).
// Proves: one mark in a single pane and one (right pane only) in a split, hidden on Settings
// (only the small preview remains), the Settings switch toggles live and persists across a
// restart, the mark is hidden under forced-colors and prefers-reduced-transparency, and a click
// on the mark lands on real content (pointer-events none, not a Tab stop, aria-hidden).
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-406-watermark.mjs
// (requires a prior `pnpm exec tauri build --debug --no-bundle`).

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-406';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_406_SHOTS_DIR || path.join(tmpdir(), 'refract-406-shots');

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};

// Live (corner) marks only: the Settings preview is the same class without `--live`.
const LIVE = `Array.from(document.querySelectorAll('.watermark-mark--live'))`;
const MARKS = `(() => ${LIVE}.map((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, display: s.display, pe: s.pointerEvents, opacity: s.opacity, ariaHidden: el.getAttribute('aria-hidden'), tabindex: el.getAttribute('tabindex') }; }))()`;
const PREVIEW_COUNT = `document.querySelectorAll('.watermark-mark:not(.watermark-mark--live)').length`;

function buildGhShim(dir) {
  const out = path.join(dir, 'gh.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-883-gh-shim.rs'), '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`rustc gh shim failed:\n${result.stderr}`);
}

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: env.importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session',
      REFRACT_883_CALL_LOG: path.join(env.shimDir, 'gh-calls.log'),
      // A date with no holiday, so the plain mark (not a seasonal glyph) renders.
      REFRACT_DATE_OVERRIDE: '2026-06-15'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openAppearance(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.getElementById('watermark-toggle')`, { timeoutMs: 10_000, label: 'Watermark switch mounted' });
  await cdp.evaluate(`document.getElementById('watermark-toggle').scrollIntoView({ block: 'center' })`);
  await sleep(300);
}
const switchState = (cdp) => cdp.evaluate(`document.getElementById('watermark-toggle')?.getAttribute('aria-checked')`);
async function setSwitch(cdp, wanted) {
  await openAppearance(cdp);
  if ((await switchState(cdp)) !== String(wanted)) await cdp.click(`document.getElementById('watermark-toggle')`);
  await cdp.waitFor(`document.getElementById('watermark-toggle')?.getAttribute('aria-checked') === '${wanted}'`, { timeoutMs: 5_000, label: `switch ${wanted}` });
}
async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Back in chat' });
  await sleep(400);
}

async function createSession(cdp) {
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await sleep(1500);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-406-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-406-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-406-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-406-watermark');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-406-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-406-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-406-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    buildGhShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const env = { launcherExe, exe, dataDir, shimDir, importSourceDir };
    session = await launch(env);
    let { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Readiness screen: no live mark', null);
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repo dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 30_000, label: 'Empty chat state' });
    await sleep(500);
    check((await cdp.evaluate(`${LIVE}.length`)) === 1, 'Empty state (no pane open): one mark', await cdp.evaluate(MARKS));
    await shot(cdp, '01-empty-state.png');

    // Single pane.
    await createSession(cdp);
    const single = await cdp.evaluate(MARKS);
    const composerTop = await cdp.evaluate(`document.querySelector('[aria-label="Message"]').getBoundingClientRect().top`);
    check(single.length === 1, 'Single pane: exactly one mark', single);
    const m = single[0] ?? {};
    check(m.pe === 'none' && m.ariaHidden === 'true' && m.tabindex === null && m.display !== 'none', 'Single pane: pointer-events none, aria-hidden, no tabindex, displayed', m);
    check(m.bottom <= composerTop + 0.5, 'Single pane: mark sits above the composer (reading area, not behind it)', { markBottom: m.bottom, composerTop });
    const hit = await cdp.evaluate(`(() => { const m = ${LIVE}[0]; const r = m.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { hitIsMark: el === m || m.contains(el), hit: el ? el.tagName + '.' + String(el.className).slice(0, 60) : null }; })()`);
    check(hit.hitIsMark === false, 'Click-through: elementFromPoint at the mark centre is real content, not the mark', hit);
    const focusableInMark = await cdp.evaluate(`${LIVE}[0].querySelectorAll('a,button,input,select,textarea,[tabindex]').length`);
    check(focusableInMark === 0, 'Not a Tab stop: no focusable descendants', focusableInMark);
    await shot(cdp, '02-single-pane.png');

    // Split: create a second session, then Ctrl+click the first row (the real openInSplit path).
    const ids = await cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.map((s) => s.id) : []))`);
    await createSession(cdp);
    const allIds = await cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.map((s) => s.id) : []))`);
    const firstId = ids[0] ?? allIds[0];
    await cdp.evaluate(`document.querySelector('[data-session-open=${JSON.stringify(firstId)}]')?.scrollIntoView({ block: 'center' })`);
    const rect = await cdp.evaluate(`(() => { const r = document.querySelector('[data-session-open=${JSON.stringify(firstId)}]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 2 });
    await cdp.waitFor(`!!document.getElementById('split-pane-1')`, { timeoutMs: 15_000, label: 'Split open' });
    await sleep(800);
    const split = await cdp.evaluate(MARKS);
    const inRight = await cdp.evaluate(`${LIVE}.map((el) => !!el.closest('#split-pane-1'))`);
    const inLeft = await cdp.evaluate(`${LIVE}.map((el) => !!el.closest('#split-pane-0'))`);
    check(split.length === 1 && inRight[0] === true && inLeft[0] === false, 'Split: exactly one mark, inside the right pane only', { split, inRight, inLeft });
    await shot(cdp, '03-split.png');

    // Settings: no live mark, only the preview.
    await openAppearance(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Settings: no live corner mark', null);
    check((await cdp.evaluate(PREVIEW_COUNT)) === 1, 'Settings: exactly one preview mark', null);
    check((await switchState(cdp)) === 'true', 'Settings: switch defaults to on', null);
    await shot(cdp, '04-settings-on.png');

    // Toggle off, then on.
    await setSwitch(cdp, false);
    check((await cdp.evaluate(PREVIEW_COUNT)) === 0, 'Switch off: preview disappears immediately', null);
    await shot(cdp, '05-settings-off.png');
    await backToChat(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Switch off: the live mark is gone with no restart', null);
    await setSwitch(cdp, true);
    await backToChat(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 1, 'Switch on: the live mark returns', null);

    // Media features under CDP emulation.
    const supported = await cdp.evaluate(`({ forced: matchMedia('(forced-colors)').media, transparency: matchMedia('(prefers-reduced-transparency: reduce)').media })`);
    check(supported.forced === '(forced-colors)' && supported.transparency !== 'not all', 'WebView2 recognises both media features', supported);
    for (const [feature, value, name] of [['forced-colors', 'active', 'forced-colors'], ['prefers-reduced-transparency', 'reduce', 'reduced-transparency']]) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value }] });
      await sleep(400);
      const hiddenNow = await cdp.evaluate(`${LIVE}.every((el) => getComputedStyle(el).display === 'none')`);
      check(hiddenNow === true, `Emulated ${name}: the mark is display none`, null);
      await shot(cdp, `06-${name}.png`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value: feature === 'forced-colors' ? 'none' : 'no-preference' }] });
      await sleep(300);
    }
    check((await cdp.evaluate(`${LIVE}.every((el) => getComputedStyle(el).display !== 'none')`)) === true, 'Emulation cleared: the mark returns', null);

    // Persistence: off, restart, still off.
    await setSwitch(cdp, false);
    cdp.close();
    await stopLauncher(session.child).catch(() => {});
    await sleep(2500);
    const files = readdirSync(dataDir).filter((f) => f.endsWith('.json'));
    const onDisk = files.map((f) => readFileSync(path.join(dataDir, f), 'utf8')).find((t) => t.includes('watermarkEnabled')) ?? '';
    check(/"watermarkEnabled":\s*false/.test(onDisk), 'Persisted: settings file holds watermarkEnabled false', files);
    session = await launch(env);
    cdp = session.cdp;
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'app after relaunch' });
    await sleep(1500);
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'After relaunch: the mark is still off', null);
    await openAppearance(cdp);
    check((await switchState(cdp)) === 'false', 'After relaunch: the switch still reads off', null);
    await shot(cdp, '07-after-relaunch-off.png');
    await setSwitch(cdp, true);

    const ghLog = path.join(shimDir, 'gh-calls.log');
    let ghCalls = [];
    try { ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean); } catch {}
    console.log(`${LOG}: fake gh answered ${ghCalls.length} call(s)`);
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
