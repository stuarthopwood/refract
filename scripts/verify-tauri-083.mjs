#!/usr/bin/env node
// Live CDP check for spec 083 (#1473 literal colour lint) against a real built Tauri debug exe with fake `omp`,
// a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_083_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-083.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { countLiteralColours, findFailures } from './check-literal-colours.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_083_SHOTS_DIR || path.join(tmpdir(), 'refract-083-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));

const THEMES = ['Dark', 'Obsidian'];
const radio = (name) => `Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
const openAppearance = async (cdp) => {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
};

function checkScript() {
  assert(countLiteralColours(`const a = 'text-green-600 hover:bg-black/50'`) === 2, 'the check counts palette classes with variants and opacity');
  assert(countLiteralColours(`const a = '#fff', b = "#112233aa"`) === 2, 'the check counts hex literals');
  assert(countLiteralColours(`// text-red-500 (#1001)\n/* bg-white */ const a = 'bg-background text-foreground'`) === 0, 'comments and theme-token classes never count');
  assert(findFailures({ 'a.tsx': 2 }, { 'a.tsx': 1 }).length === 1, 'a count above its baseline fails');
  assert(findFailures({}, { 'a.tsx': 1 }).length === 1, 'a stale baseline allowance fails, so the baseline can only shrink');
  assert(findFailures({ 'a.tsx': 1 }, { 'a.tsx': 1 }).length === 0, 'a count equal to its baseline passes');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'check-literal-colours.mjs')], { encoding: 'utf8', windowsHide: true });
  assert(run.status === 0 && /passed/.test(run.stdout), 'check:literal-colours passes against the tree');
}

async function runChecks(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(path.basename(repoDir)) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });

  const seen = {};
  for (const name of THEMES) {
    await openAppearance(cdp);
    await cdp.waitFor(`!!${radio(name)}`, { timeoutMs: 15_000, label: `${name} listed` });
    await cdp.click(radio(name));
    await cdp.waitFor(`${radio(name)}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: `${name} checked` });
    await sleep(300);
    const bg = await cdp.evaluate(`getComputedStyle(document.body).backgroundColor`);
    const cls = await cdp.evaluate(`document.documentElement.className`);
    assert(cls.includes(`theme-${name.toLowerCase()}`), `${name}: the document carries its theme class (${cls})`);
    assert(/^(rgb|oklab|oklch|color)\(/.test(bg), `${name}: the page paints a resolved background (${bg})`);
    seen[name] = bg;
    await shot(cdp, `theme-${name.toLowerCase()}.png`);
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await sleep(200);
    await shot(cdp, `chat-${name.toLowerCase()}.png`);
  }
  assert(seen.Dark !== seen.Obsidian, `Dark and Obsidian paint different backgrounds (${seen.Dark} vs ${seen.Obsidian})`);
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-083: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    checkScript();
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-083-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-083-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-083-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-083-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-083-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_083_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    await runChecks(cdp, repoA);
    log(`verify-tauri-083: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    if (!ok && cdp) await shot(cdp, 'failure.png').catch(() => {});
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-083: FAIL');
  console.error(err);
  process.exitCode = 1;
});
