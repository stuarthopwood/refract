#!/usr/bin/env node
// Live CDP check for spec 087 UI paths (Details card, Settings Chat width and Advisor row, Usage filter, Issues)
// against a built Tauri debug exe with fake `omp`, a scratch REFRACT_DATA_DIR, a scratch PI_CODING_AGENT_DIR and
// its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_087_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-087.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder, hoverRow, openRowActionsMenu, clickMenuItem, pressKey, pressEscape } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_087_SHOTS_DIR || path.join(tmpdir(), 'refract-087-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SKIPPED = [];
let passed = 0;
function skip(name, reason) {
  SKIPPED.push({ name, reason });
  log(`SKIP: ${name}: ${reason}`);
}
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
const openSettingsSection = async (cdp, label) => {
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`);
  await sleep(600);
};

async function checkDetailsCard(cdp, repoName) {
  const trigger = `document.querySelector('[data-repository-id] li button[data-session-open]')`;
  assert(!!(await cdp.evaluate(`!!(${trigger})`)), `A session row is present under ${repoName}`);
  // The hover card opens after a 750 ms delay on the row's open button.
  await hoverRow(cdp, trigger);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Copy path"]')`, { timeoutMs: 8_000, label: 'Details card shows Copy path' });
  const layout = await cdp.evaluate(`(() => {
    const copy = document.querySelector('[aria-label="Copy path"]');
    const row = copy.parentElement;
    const path = row.querySelector('p');
    const lastTwo = Array.from(row.children).slice(-2).map((el) => el.getAttribute('aria-label'));
    return { hasPath: !!path && /[\\\\/]/.test(path.textContent), lastTwo, rowRight: Math.round(row.getBoundingClientRect().right), copyRight: Math.round(copy.getBoundingClientRect().right) };
  })()`);
  log(`details layout: ${JSON.stringify(layout)}`);
  await shot(cdp, '01-details-card.png');
  assert(layout.hasPath, 'Details card row shows the worktree path text');
  assert(layout.lastTwo.includes('Copy path') && layout.lastTwo.includes('Show in File Explorer'), 'Copy path and Show in File Explorer are the last two children of the path row');
  await pressEscape(cdp);
}

async function checkShowHidden(cdp, repoName) {
  await openRowActionsMenu(cdp, repoName, SHOTS_DIR, log);
  await clickMenuItem(cdp, 'Hide');
  await cdp.waitFor(`!!document.querySelector('[data-show-hidden-toggle]')`, { timeoutMs: 10_000, label: 'Show hidden toggle appears once a Session is hidden' });
  await cdp.click(`document.querySelector('[data-show-hidden-toggle]')`);
  await cdp.waitFor(`document.querySelector('[data-show-hidden-toggle]')?.getAttribute('aria-pressed') === 'true'`, { timeoutMs: 5_000, label: 'Show hidden pressed' });
  await shot(cdp, '04-show-hidden.png');
  assert(await cdp.evaluate(`!!document.querySelector('[data-collapse-all-groups]')`), 'Collapse all groups focus target exists beside Show hidden');
  // Unhide so later checks keep a visible row; the toggle then removes itself.
  await openRowActionsMenu(cdp, repoName, SHOTS_DIR, log);
  await clickMenuItem(cdp, 'Unhide');
  await cdp.waitFor(`!document.querySelector('[data-show-hidden-toggle]')`, { timeoutMs: 10_000, label: 'Show hidden toggle removes itself with nothing hidden' });
  assert(await cdp.evaluate(`!document.querySelector('[data-show-hidden-toggle]')`), 'Show hidden toggle removed after the last hidden Session is unhidden');
}

async function checkSettings(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await openSettingsSection(cdp, 'Appearance');
  const group = `document.querySelector('[role="radiogroup"] [id^="chat-width-option-"]')?.closest('[role="radiogroup"]')`;
  await cdp.waitFor(`!!(${group})`, { timeoutMs: 10_000, label: 'Chat width picker mounted' });
  const picker = await cdp.evaluate(`(() => { const g = ${group}; return { text: g.textContent, previewParent: g.parentElement?.className ?? '', radios: g.querySelectorAll('[role="radio"]').length }; })()`);
  log(`chat width picker: ${JSON.stringify(picker)}`);
  await shot(cdp, '02-settings-chat-width.png');
  assert(!picker.text.includes('Current'), 'Chat width no longer shows "Current"');
  assert(picker.previewParent.includes('max-w-sm'), 'Chat width picker container uses max-w-sm');
  await cdp.click(`document.querySelector('#chat-width-option-full-name').closest('button')`);
  await pressKey(cdp, 40, 'ArrowDown', 'ArrowDown');
  await pressKey(cdp, 38, 'ArrowUp', 'ArrowUp');
  await sleep(1500);
  const settled = await cdp.evaluate(`(() => { const radios = Array.from(${group}.querySelectorAll('[role="radio"]')); const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true'); return { checkedCount: checked.length, checkedIsFocused: checked[0] === document.activeElement, checkedId: checked[0]?.querySelector('[id^="chat-width-option-"]')?.id ?? null }; })()`);
  log(`after quick ArrowDown, ArrowUp: ${JSON.stringify(settled)}`);
  await shot(cdp, '02b-settings-chat-width-after-arrows.png');
  assert(settled.checkedCount === 1, 'Exactly one chat width radio is checked after rapid arrows');
  assert(settled.checkedIsFocused, 'The checked chat width radio is the focused one after rapid arrows');
  assert(settled.checkedId === 'chat-width-option-full-name', 'Rapid ArrowDown then ArrowUp ends on Full');

  await openSettingsSection(cdp, 'Models');
  const warning = `document.querySelector('#model-role-advisor-warning')`;
  await cdp.waitFor(`!!(${warning})`, { timeoutMs: 15_000, label: 'Advisor row shows the roster warning' });
  await shot(cdp, '03-settings-advisor-warning.png');
  assert(await cdp.evaluate(`/WATCHDOG/i.test(${warning}.textContent)`), 'Settings Advisor row warning mentions WATCHDOG');
}

async function checkUsage(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.click(`document.querySelector('button[aria-label="Usage"]')`);
  await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"]')`, { timeoutMs: 15_000, label: 'Usage view mounted' });
  const trigger = `document.querySelector('[aria-label="Agent type"]')`;
  await cdp.waitFor(`!!(${trigger})`, { timeoutMs: 10_000, label: 'Agent type filter present' });
  const anyText = await cdp.evaluate(`${trigger}.textContent.trim()`);
  await cdp.click(trigger);
  await cdp.waitFor(`document.querySelectorAll('[role="option"]').length > 0`, { timeoutMs: 5_000, label: 'Agent type options open' });
  const options = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim())`);
  log(`agent type options: ${JSON.stringify(options)}, trigger: ${anyText}`);
  await shot(cdp, '05-usage-agent-type.png');
  assert(options.includes('Advisor'), 'Usage agent type filter offers Advisor');
  assert(options.includes('All agent types') && anyText === 'All agent types', 'Usage agent type any-option reads "All agent types"');
  await pressEscape(cdp);
}

function recordSkips() {
  skip('issues-label-removal-announcement', 'The fake gh shim returns no labels, so no label pill exists to remove.');
  skip('git-changes-header-hover-forced-colours', 'Needs a forced-colours emulation and a git-changes header with changes; the scratch repo has none.');
  skip('paused-overlay', 'No helper pauses a Session; the fake omp cannot enter the paused state.');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
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
  await createSessionViaQuickCreate(cdp, repoName);
  await cdp.waitFor(`!!document.querySelector('button[aria-label="Find in chat"]')`, { timeoutMs: 15_000, label: 'ChatHeader mounted' });
  await checkDetailsCard(cdp, repoName);
  await checkShowHidden(cdp, repoName);
  await checkSettings(cdp);
  await checkUsage(cdp);
  recordSkips();
  await shot(cdp, '99-final.png');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-087: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, agentDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-087-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-087-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-087-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-087-exe-'));
    agentDir = mkdtempSync(path.join(tmpdir(), 'refract-087-agent-'));
    writeFileSync(path.join(agentDir, 'WATCHDOG.yml'), '- name: scratch-advisor\n  model: scratch/model\n');
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-087-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_087_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
        PI_CODING_AGENT_DIR: agentDir,
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
    log(`verify-tauri-087: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, skipped: SKIPPED, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, agentDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-087: FAIL');
  console.error(err);
  process.exitCode = 1;
});
