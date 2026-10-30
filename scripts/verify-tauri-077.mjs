#!/usr/bin/env node
// Live CDP check for spec 077 (#579 slices A to C: IconButton tooltips, hit targets, translucent tokens) against a real built
// Tauri debug exe with fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_077_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-077.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_077_SHOTS_DIR || path.join(tmpdir(), 'refract-077-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const THEMES = ['theme-dark', 'theme-dark-high-contrast'];
const TOKENS = ['--row-hover-bg', '--focus-glow', '--elevated-edge', '--scrim-bg', '--invalid-ring', '--primary-hover-bg', '--destructive-hover-bg', '--field-bg', '--field-hover-bg'];

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

const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));
const setTheme = (cdp, cls) =>
  cdp.evaluate(`(() => { const r = document.documentElement; for (const c of Array.from(r.classList)) if (c.startsWith('theme-')) r.classList.remove(c); r.classList.add('dark', ${JSON.stringify(cls)}); return true; })()`);

const ICON_ONLY_WITHOUT_NAME = `Array.from(document.querySelectorAll('button')).filter((b) => b.querySelector('svg') && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && b.tabIndex !== -1).map((b) => b.outerHTML.slice(0, 120))`;

async function hoverTooltip(cdp, label) {
  const sel = `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  await cdp.evaluate(`${sel}.scrollIntoView({ block: 'center' })`);
  const rect = await cdp.evaluate(`(() => { const r = ${sel}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).find((t) => t.textContent.includes(${JSON.stringify(label)}))`, { timeoutMs: 5_000, label: `tooltip for ${label}` });
  return rect;
}

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  const repoName = path.basename(repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });

  const unnamed = await cdp.evaluate(ICON_ONLY_WITHOUT_NAME);
  log(`icon-only buttons without a name: ${JSON.stringify(unnamed)}`);
  assert(unnamed.length === 0, 'every tabbable icon-only button has an accessible name');

  for (const cls of THEMES) {
    await setTheme(cdp, cls);
    await sleep(300);
    const missing = await cdp.evaluate(`${JSON.stringify(TOKENS)}.filter((t) => !getComputedStyle(document.documentElement).getPropertyValue(t).trim())`);
    assert(missing.length === 0, `all translucent tokens resolve in ${cls}`);

    const label = `Project actions for ${repoName}`;
    const rect = await hoverTooltip(cdp, label);
    assert(rect.w <= 24 && rect.h <= 24, `Project actions trigger is at most 24 px in ${cls} (${rect.w}x${rect.h})`);
    await sleep(500);
    await shot(cdp, `after-${cls}-project-actions-tooltip.png`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await sleep(300);
    await shot(cdp, `after-${cls}-sidebar.png`);
  }

  await setTheme(cdp, 'theme-dark');
  await cdp.click(`document.querySelector('[aria-label=${JSON.stringify(`Project actions for ${repoName}`)}]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'menu open' });
  await shot(cdp, 'after-theme-dark-menu.png');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-077: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-077-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-077-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-077-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-077-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-077-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_077_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    log(`verify-tauri-077: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-077: FAIL');
  console.error(err);
  process.exitCode = 1;
});
