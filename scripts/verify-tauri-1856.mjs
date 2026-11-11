#!/usr/bin/env node
// Live CDP check: the Keyboard shortcuts dialog keeps its list inside the dialog border and scrolls it by keyboard at a
// short window height, with the header and Done always visible; the viewport's inset focus ring is absent until focus,
// is not painted over on any edge, and reaches 3:1 contrast. Real built Tauri debug exe, fake `omp`, scratch data dir.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1856_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1856.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, pressTab, pressKey, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { installRingProbes, readRing, readEdges, measureRingContrast, shotClip } from './verify-1856-ring-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1856_SHOTS_DIR || path.join(tmpdir(), 'refract-1856-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const SHORT_HEIGHT = 360;
const MIN_RING_CONTRAST = 3;
const RING_PX = 3;
// The app gets only what it needs to run, so no ambient secret or session variable reaches it or its log.
const ENV_ALLOWLIST = ['PATH', 'PATHEXT', 'ComSpec', 'SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];
const BASE_ENV = Object.fromEntries(ENV_ALLOWLIST.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const REPORT = [];
const SHOTS = [];
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
function record(name) {
  const file = path.join(SHOTS_DIR, name);
  SHOTS.push({ name, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
}
async function shot(cdp, name) {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  record(name);
}

const NAME_BUTTON = `document.querySelector('[data-profile-name-button]')`;
const VIEWPORT = `document.querySelector('[role="dialog"] [data-slot="scroll-area-viewport"]')`;
const LIST_VIEWPORT = `Array.from(document.querySelectorAll('[data-slot="scroll-area-viewport"]')).find((el) => !el.closest('[role="dialog"]'))`;
const GEOMETRY = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
  const dialog = document.querySelector('[role="dialog"]');
  const done = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Done');
  const viewport = ${VIEWPORT};
  return { win: window.innerHeight, dialog: r(dialog), done: r(done), viewport: { ...r(viewport), scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight, scrollTop: viewport.scrollTop } };
})()`;

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
  await addRepository(cdp, repoDir);
  await cdp.waitFor(`!!${NAME_BUTTON}`, { timeoutMs: 20_000, label: 'profile item rendered' });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: SHORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await cdp.click(NAME_BUTTON);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'profile menu open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Keyboard shortcuts'))`);
  await cdp.waitFor(`!!${VIEWPORT}`, { timeoutMs: 10_000, label: 'Keyboard shortcuts dialog open' });
  await sleep(400);

  const g = await cdp.evaluate(GEOMETRY);
  log(`geometry at ${SHORT_HEIGHT}px: ${JSON.stringify(g)}`);
  await shot(cdp, `shortcuts-dialog-${SHORT_HEIGHT}px-top.png`);
  assert(g.dialog.top >= 0 && g.dialog.bottom <= g.win, 'the dialog fits inside the window');
  assert(g.viewport.bottom <= g.dialog.bottom + 0.5 && g.viewport.top >= g.dialog.top, 'the list sits inside the dialog border');
  assert(g.done.bottom <= g.dialog.bottom + 0.5 && g.done.top >= g.viewport.bottom - 0.5, 'Done is visible inside the dialog, below the list');
  assert(g.viewport.scrollHeight > g.viewport.clientHeight + 20, 'the list is taller than its viewport, so it must scroll');
  await installRingProbes(cdp);
  const unfocused = await readRing(cdp, VIEWPORT);
  assert(!(await cdp.evaluate(`document.activeElement === ${VIEWPORT}`)) && unfocused.spreadPx === 0, `no focus ring is painted before the viewport takes focus ${JSON.stringify(unfocused)}`);

  let focused = false;
  for (let i = 0; i < 6 && !focused; i++) {
    await pressTab(cdp);
    focused = await cdp.evaluate(`document.activeElement === ${VIEWPORT}`);
  }
  assert(focused, 'Tab reaches the scroll viewport');
  await sleep(500); // the ring fades in over the box-shadow transition; read it only once settled
  const ring = await readRing(cdp, VIEWPORT);
  const a11y = await cdp.evaluate(`(() => { const el = ${VIEWPORT}; const b = el.getBoundingClientRect(); const d = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { label: el.getAttribute('aria-label'), role: el.getAttribute('role'), labelledby: el.getAttribute('aria-labelledby'), insideDialog: b.top >= d.top - 0.5 && b.bottom <= d.bottom + 0.5 && b.left >= d.left - 0.5 && b.right <= d.right + 0.5 }; })()`);
  assert(a11y.role === 'region' && a11y.label === 'Keyboard shortcuts list', `the focused viewport is a named region ${JSON.stringify(a11y)}`);
  assert(ring.spreadPx >= RING_PX && a11y.insideDialog, `the focused scroll viewport shows a visible (non-transparent, >=${RING_PX}px) inset focus ring inside the dialog ${JSON.stringify(ring)}`);

  const contrast = await measureRingContrast(cdp, VIEWPORT, ring.color);
  log(`ring contrast over the dialog backdrop: before (ring-focus-glow token) ${JSON.stringify(contrast.before)}; after (measured ring) ${JSON.stringify(contrast.after)}`);
  assert(contrast.after.ratio >= MIN_RING_CONTRAST, `the focus ring reaches ${MIN_RING_CONTRAST}:1 contrast against the dialog backdrop (${contrast.after.ratio.toFixed(2)}:1, was ${contrast.before.ratio.toFixed(2)}:1 with ring-focus-glow)`);

  const top = await readEdges(cdp, VIEWPORT);
  log(`edge clearance at the top of the list: ${JSON.stringify(top)}`);
  for (const edge of ['top', 'right', 'bottom', 'left']) assert(top.clear[edge], `nothing sits over the ring on the ${edge} inside edge`);
  assert(Object.values(top.gaps).every(Number.isFinite), `painted content was measured on every edge ${JSON.stringify(top.gaps)}`);
  assert(top.gaps.top >= RING_PX && top.gaps.left >= RING_PX && top.gaps.right >= RING_PX, `first-row content clears the ${RING_PX}px ring on the top, left and right edges ${JSON.stringify(top.gaps)}`);
  await shot(cdp, 'focus-ring-visible-all-edges.png');
  const { left, top: boxTop } = top.box;
  await shotClip(cdp, path.join(SHOTS_DIR, 'focus-ring-zoom.png'), { x: left - 12, y: boxTop - 12, width: 160, height: 80 });
  record('focus-ring-zoom.png');

  await pressKey(cdp, 34, 'PageDown', 'PageDown');
  await sleep(400);
  const mid = await cdp.evaluate(GEOMETRY);
  assert(mid.viewport.scrollTop > g.viewport.scrollTop, `PageDown scrolls the list (scrollTop ${g.viewport.scrollTop} -> ${mid.viewport.scrollTop})`);
  await pressKey(cdp, 35, 'End', 'End');
  await sleep(400);
  const end = await cdp.evaluate(GEOMETRY);
  assert(end.viewport.scrollTop + end.viewport.clientHeight >= end.viewport.scrollHeight - 2, 'End scrolls to the last row');
  assert(await cdp.evaluate(`document.activeElement === ${VIEWPORT}`), 'focus stays on the scroll viewport while it scrolls');
  assert(end.done.bottom <= end.dialog.bottom + 0.5, 'Done stays visible after scrolling');
  const bottom = await readEdges(cdp, VIEWPORT);
  assert(Object.values(bottom.gaps).every(Number.isFinite), `painted content was measured on every edge ${JSON.stringify(bottom.gaps)}`);
  assert(bottom.gaps.bottom >= RING_PX && bottom.gaps.left >= RING_PX && bottom.gaps.right >= RING_PX, `last-row content clears the ${RING_PX}px ring on the bottom, left and right edges ${JSON.stringify(bottom.gaps)}`);
  await shot(cdp, `shortcuts-dialog-${SHORT_HEIGHT}px-scrolled-end.png`);

  await checkOtherConsumer(cdp);
}

// The session list is the other `ScrollArea` consumer: it holds focusable rows, so the script gives its viewport a tabindex
// to focus it, then proves the shared class paints the same full-strength ring there.
async function checkOtherConsumer(cdp) {
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'shortcuts dialog closed' });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  await cdp.evaluate(`(() => { const el = ${LIST_VIEWPORT}; el.setAttribute('tabindex', '0'); el.focus(); })()`);
  await sleep(500);
  const focusedList = await cdp.evaluate(`(() => { const el = ${LIST_VIEWPORT}; return document.activeElement === el && el.matches(':focus-visible'); })()`);
  const listRing = await readRing(cdp, LIST_VIEWPORT);
  assert(focusedList && listRing.spreadPx >= RING_PX, `the session list's ScrollArea viewport shows the same >=${RING_PX}px ring when focus-visible ${JSON.stringify(listRing)}`);
  const listContrast = await measureRingContrast(cdp, LIST_VIEWPORT, listRing.color);
  log(`session list ring contrast: ${JSON.stringify(listContrast.after)}`);
  assert(listContrast.after.ratio >= MIN_RING_CONTRAST, `the session list ring reaches ${MIN_RING_CONTRAST}:1 contrast (${listContrast.after.ratio.toFixed(2)}:1)`);
  await shot(cdp, 'focus-ring-session-list.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-1856: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, ghCfgDir, copilotDir, ompSessionsDir, repoA, child, cdp;
  let ok = false;
  try {
    const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1856-${n}-`));
    shimDir = mk('shim');
    dataDir = mk('data');
    importDir = mk('import');
    exeDir = mk('exe');
    ghCfgDir = mk('ghcfg');
    copilotDir = mk('copilot');
    ompSessionsDir = mk('ompsessions');
    repoA = makeScratchRepo(mk('repoA'), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_1856_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      baseEnv: BASE_ENV,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        COPILOT_HOME: copilotDir,
        REFRACT_OMP_SESSIONS_DIR: ompSessionsDir,
        GH_CONFIG_DIR: ghCfgDir,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        GH_HOST: '',
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
    log(`verify-tauri-1856: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    if (!ok && cdp) {
      // A failed run leaves what the window showed, so a blank or errored screen is diagnosable without a rerun.
      await shot(cdp, 'failure.png').catch(() => {});
      log(`page text at failure: ${JSON.stringify(await cdp.evaluate(`document.body?.innerText?.slice(0, 600) ?? null`).catch(() => null))}`);
    }
    const sinceBuild = spawnSync('git', ['diff', '00507b34..HEAD', '--stat'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim().split('\n');
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, diffSinceExeBuild00507b34: sinceBuild, log: REPORT }, null, 2));
    writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(SHOTS, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, ghCfgDir, copilotDir, ompSessionsDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-1856: FAIL');
  console.error(err);
  process.exitCode = 1;
});
