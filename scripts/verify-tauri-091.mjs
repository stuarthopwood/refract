#!/usr/bin/env node
// Live CDP check for spec 091 (aria-disabled buttons never hover or look enabled, derived aria-keyshortcuts) against a built Tauri debug exe with a fake `omp`,
// a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_091_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-091.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { buildFakeGh, makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_091_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-091-shots-'));
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SKIPPED = [];
const SHOTS = [];
let passed = 0;
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
const skip = (name, reason) => {
  SKIPPED.push({ name, reason });
  log(`SKIP: ${name}: ${reason}`);
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

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

const FIND = `document.querySelector('button[aria-label="Find in chat"]')`;

// Polls until the computed style stops changing, so a transition never races the read.
async function settledStyle(cdp, finder, prop) {
  let last = null;
  for (let stable = 0, i = 0; i < 40 && stable < 3; i += 1) {
    const value = await cdp.evaluate(`getComputedStyle(${finder}).${prop}`);
    stable = value === last ? stable + 1 : 0;
    last = value;
    await sleep(50);
  }
  return last;
}

async function hoverBackground(cdp, finder) {
  const point = await cdp.evaluate(`(() => { const r = ${finder}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  const idle = await settledStyle(cdp, finder, 'backgroundColor');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  const hovered = await settledStyle(cdp, finder, 'backgroundColor');
  const under = await cdp.evaluate(`document.elementFromPoint(${point.x}, ${point.y}) === ${finder} || ${finder}.contains(document.elementFromPoint(${point.x}, ${point.y}))`);
  return { idle, hovered, under };
}

async function checkButtons(cdp) {
  const free = await hoverBackground(cdp, FIND);
  log(`free ghost hover: ${JSON.stringify(free)}`);
  assert(free.under, 'The pointer lands on the Find in chat button');
  assert(free.hovered !== free.idle, 'A normal ghost IconButton changes background on hover');
  await shot(cdp, '01-ghost-hover.png');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  // A clone with aria-disabled exercises the shared neutraliser without needing a feature to be busy.
  await cdp.evaluate(`(() => { const c = ${FIND}.cloneNode(true); c.id = 'verify-disabled-clone'; c.setAttribute('aria-disabled', 'true'); c.removeAttribute('aria-label'); c.setAttribute('aria-hidden', 'true'); ${FIND}.after(c); })()`);
  const CLONE = `document.getElementById('verify-disabled-clone')`;
  const off = await hoverBackground(cdp, CLONE);
  const cursor = await cdp.evaluate(`getComputedStyle(${CLONE}).cursor`);
  log(`disabled ghost hover: ${JSON.stringify({ ...off, cursor })}`);
  assert(off.under, 'The pointer lands on the aria-disabled clone');
  assert(off.hovered === off.idle, 'An aria-disabled button keeps its idle background on hover');
  assert(cursor === 'not-allowed', 'An aria-disabled button shows the not-allowed cursor');
  await shot(cdp, '02-disabled-hover.png');
  await cdp.evaluate(`${CLONE}.remove()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
}

async function checkShortcuts(cdp) {
  const keys = await cdp.evaluate(`({
    find: ${FIND}.getAttribute('aria-keyshortcuts'),
    quickCreate: document.querySelector('[data-quick-create-session]')?.hasAttribute('aria-keyshortcuts') ?? null
  })`);
  log(`shortcuts: ${JSON.stringify(keys)}`);
  assert(keys.find === 'Control+F', 'Find in chat derives aria-keyshortcuts Control+F from its shortcut prop');
  assert(keys.quickCreate === false, 'The per-repository New session button advertises no chord');
  await cdp.click(`document.querySelector('[data-rail-toggle]')`);
  await cdp.waitFor(`document.querySelector('[data-rail-toggle]')?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'right pane open' });
  await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
  await cdp.waitFor(`!!document.querySelector('[data-panel-close]')`, { timeoutMs: 10_000, label: 'panel close button' });
  // The Delete chord lives on the tab-bar close buttons, which only render with two or more open panels.
  await cdp.click(`Array.from(document.querySelectorAll('[data-rail-button]')).find((b) => b.getAttribute('data-rail-button') !== 'git-changes')`);
  await cdp.waitFor(`document.querySelectorAll('[data-panel-close]').length >= 2`, { timeoutMs: 10_000, label: 'panel tab bar' });
  const close = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-panel-close]')).map((b) => b.getAttribute('aria-keyshortcuts'))`);
  await shot(cdp, '03-right-pane-tab-bar.png');
  assert(close.includes('Delete'), 'The panel tab close button derives aria-keyshortcuts Delete');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  log(`verify-tauri-091: head ${head}, dirty=${dirty}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-091-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let child, cdp;
  let ok = false;
  try {
    const shimDir = tmp('shim');
    const dataDir = tmp('data');
    const importDir = tmp('import');
    const exeDir = tmp('exe');
    const agentDir = tmp('agent');
    const fakeGhDir = tmp('fakegh');
    const ghConfigDir = tmp('ghconfig');
    const repoDir = makeFakeGithubRepo(tmp('repo'));
    buildFakeGh(fakeGhDir);
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_091_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    for (const key of Object.keys(process.env)) if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'].includes(key.toUpperCase())) delete process.env[key];
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: `${fakeGhDir};${shimDir}`,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        GH_CONFIG_DIR: ghConfigDir,
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        PI_CODING_AGENT_DIR: agentDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    const repoName = path.basename(repoDir);
    await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
    await createSessionViaQuickCreate(cdp, repoName);
    await cdp.waitFor(`!!${FIND}`, { timeoutMs: 15_000, label: 'ChatHeader mounted' });
    await checkButtons(cdp);
    await checkShortcuts(cdp);
    skip('compact-list-wrap', 'No harness feeds usage rows into the Usage panel; the change is a class swap covered by review.');
    skip('theme-store-rollback', 'Needs a failing themes.set reply; no fault hook in the scratch app.');
    skip('roster-symlink', 'Creating a symlink needs elevation on Windows; the canonical-path check is in Rust and reviewed.');
    await shot(cdp, '99-final.png');
    log(`verify-tauri-091: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, ok, checks: passed, screenshots: SHOTS, skipped: SKIPPED, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-091: FAIL');
  console.error(err);
  process.exitCode = 1;
});
