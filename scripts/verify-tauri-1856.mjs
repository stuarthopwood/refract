#!/usr/bin/env node
// Live CDP check: the Keyboard shortcuts dialog keeps its list inside the dialog border and scrolls it by keyboard at a
// short window height, with the header and Done always visible. Real built Tauri debug exe, fake `omp`, scratch data dir.
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
import { addRepository, pressTab, pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1856_SHOTS_DIR || path.join(tmpdir(), 'refract-1856-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const SHORT_HEIGHT = 360;
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
async function shot(cdp, name) {
  const file = path.join(SHOTS_DIR, name);
  await cdp.screenshot(file);
  SHOTS.push({ name, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
}

const NAME_BUTTON = `document.querySelector('[data-profile-name-button]')`;
const VIEWPORT = `document.querySelector('[role="dialog"] [data-slot="scroll-area-viewport"]')`;
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

  let focused = false;
  for (let i = 0; i < 6 && !focused; i++) {
    await pressTab(cdp);
    focused = await cdp.evaluate(`document.activeElement === ${VIEWPORT}`);
  }
  assert(focused, 'Tab reaches the scroll viewport');
  await sleep(500); // the ring fades in over the box-shadow transition; read it only once settled
  const ring = await cdp.evaluate(`(() => {
    const el = ${VIEWPORT};
    const b = el.getBoundingClientRect();
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const segs = getComputedStyle(el).boxShadow.split(/,(?![^()]*\\))/).map((s) => s.trim());
    const inset = segs.map((s) => ({ s, px: (s.match(/-?[\\d.]+px/g) || []).map(parseFloat), clear: /(\\/ 0\\)|, 0\\))/.test(s.replace(/\\s+-?[\\d.]+px/g, '')) })).find((x) => x.s.includes('inset') && x.px[3] > 0 && !x.clear);
    return { label: el.getAttribute('aria-label'), height: b.height, ringSpreadPx: inset ? inset.px[3] : 0, ringShadow: inset ? inset.s : null, insideDialog: b.top >= d.top - 0.5 && b.bottom <= d.bottom + 0.5 && b.left >= d.left - 0.5 && b.right <= d.right + 0.5 };
  })()`);
  assert(ring.label === 'Keyboard shortcuts list', `the focused viewport carries the accessible name ${JSON.stringify(ring.label)}`);
  assert(ring.ringSpreadPx >= 3 && ring.insideDialog, `the focused scroll viewport shows a visible (non-transparent, >=3px) inset focus ring inside the dialog ${JSON.stringify(ring)}`);
  await shot(cdp, 'focus-ring-visible-all-edges.png');

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
  await shot(cdp, `shortcuts-dialog-${SHORT_HEIGHT}px-scrolled-end.png`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
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
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
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
