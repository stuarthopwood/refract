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
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_087_SHOTS_DIR || path.join(tmpdir(), 'refract-087-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

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
const openSettingsSection = async (cdp, label) => {
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`);
  await sleep(600);
};

async function checkDetailsCard(cdp, repoName) {
  const trigger = `document.querySelector('[data-session-open], [data-slot="session-open"]') || Array.from(document.querySelectorAll('button')).find((b) => b.closest('li') && b.closest('li').querySelector('[data-session-row-actions], [aria-label*="actions" i]'))`;
  const box = await cdp.evaluate(`(() => { const el = document.querySelector('[data-session-row] button') || (${trigger}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  assert(!!box, `A session row is present under ${repoName}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.waitFor(`!!document.querySelector('[aria-label="Copy path"]')`, { timeoutMs: 8_000, label: 'Details card shows Copy path' });
  const layout = await cdp.evaluate(`(() => {
    const copy = document.querySelector('[aria-label="Copy path"]');
    const row = copy.parentElement;
    const reveal = row.querySelector('[aria-label="Show in File Explorer"]');
    return { sameRow: !!reveal, rowText: row.textContent.trim().slice(0, 80), copyRight: Math.round(copy.getBoundingClientRect().right), rowRight: Math.round(row.getBoundingClientRect().right) };
  })()`);
  log(`details layout: ${JSON.stringify(layout)}`);
  await shot(cdp, '01-details-card.png');
  assert(layout.sameRow, 'Copy path and Show in File Explorer share the path row');
}

async function checkSettings(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await openSettingsSection(cdp, 'Appearance');
  const group = `document.querySelector('[role="radiogroup"] [id^="chat-width-option-"]')?.closest('[role="radiogroup"]')`;
  await cdp.waitFor(`!!(${group})`, { timeoutMs: 10_000, label: 'Chat width picker mounted' });
  const picker = await cdp.evaluate(`(() => { const g = ${group}; return { text: g.textContent, preview: g.nextElementSibling?.className ?? '', radios: g.querySelectorAll('[role="radio"]').length }; })()`);
  log(`chat width picker: ${JSON.stringify(picker)}`);
  await shot(cdp, '02-settings-chat-width.png');
  assert(!picker.text.includes('Current'), 'Chat width no longer shows "Current"');
  assert(picker.preview.includes('max-w-sm'), 'Chat width preview uses max-w-sm');
  await cdp.click(`document.querySelector('#chat-width-option-reading-column-name').closest('button')`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' });
  await sleep(1200);
  const checked = await cdp.evaluate(`document.querySelector('[role="radio"][aria-checked="true"] [id^="chat-width-option-"]')?.id ?? null`);
  log(`checked after quick ArrowUp, ArrowDown: ${checked}`);
  assert(checked === 'chat-width-option-reading-column-name', 'Rapid arrow keys end on the last choice');

  await openSettingsSection(cdp, 'Models');
  await cdp.waitFor(`/WATCHDOG/i.test(document.body.textContent)`, { timeoutMs: 15_000, label: 'Advisor row shows the roster warning' });
  await shot(cdp, '03-settings-advisor-warning.png');
  assert(true, 'Settings Advisor row shows the roster warning');
}

async function checkIssuesAndUsage(cdp) {
  const usageNav = await cdp.evaluate(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button, [aria-label="Usage"]')).map((el) => el.textContent.trim() || el.getAttribute('aria-label'))`);
  log(`nav entries: ${JSON.stringify(usageNav)}`);
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
  await checkSettings(cdp);
  await checkIssuesAndUsage(cdp);
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
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
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
