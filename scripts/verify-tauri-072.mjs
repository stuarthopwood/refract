#!/usr/bin/env node
// Live CDP check for spec 072 (#1426 composer clock alarms, #1430 Advisor tag size, #1432 Subagent label) against a real built
// Tauri debug exe with fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_072_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-072.mjs

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
const SHOTS_DIR = process.env.REFRACT_072_SHOTS_DIR || path.join(tmpdir(), 'refract-072-shots');
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

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const DIALOG = `document.querySelector('[role="dialog"][aria-label="Alarms"]')`;
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));
const clockButton = `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Current time'))`;

async function setTime(cdp, value) {
  await cdp.evaluate(`(() => {
    const i = ${DIALOG}.querySelector('[data-slot="time-field"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

/** Clicks the label field and waits until it actually holds focus; the form's own focus handling can land after the click, and text typed before that is dropped. */
async function focusLabelInput(cdp) {
  const input = `${DIALOG}.querySelector('input:not([data-slot="time-field"] input)')`;
  await cdp.click(input);
  await cdp.waitFor(`document.activeElement === (${input})`, { timeoutMs: 5_000, label: 'alarm label input focused' });
}

async function addAlarm(cdp, value, label) {
  if (!(await cdp.evaluate(`!!${DIALOG}`))) await cdp.click(clockButton);
  await cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add alarm')`);
  await cdp.waitFor(`!!${DIALOG}.querySelector('[data-slot="time-field"] input')`, { timeoutMs: 10_000, label: 'alarm form open' });
  await setTime(cdp, value);
  if (label) {
    await focusLabelInput(cdp);
    await cdp.send('Input.insertText', { text: label });
  }
}
const saveAlarm = (cdp) => cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save')`);
const rowLabels = (cdp) => cdp.evaluate(`Array.from(${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]')).map((el) => el.getAttribute('aria-label'))`);

async function enableClock(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Models')`);
  await sleep(800);
  const subagentFinder = `Array.from(document.querySelectorAll('body *')).find((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === 'Task'))`;
  await cdp.waitFor(`!!(${subagentFinder})`, { timeoutMs: 10_000, label: 'Models section rendered' }).catch(() => {});
  const roleLabel = await cdp.evaluate(`(() => {
    const el = ${subagentFinder};
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  })()`);
  await sleep(300);
  await shot(cdp, '01-settings-task-role.png');
  assert(roleLabel, '#1879: Settings model roles list a "Task" row (supersedes #1432 "Subagent")');
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Status line')`);
  await sleep(600);
  await cdp.evaluate(`(() => {
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).find((s) => document.getElementById(s.getAttribute('aria-describedby'))?.textContent.includes('current time of day'));
    sw.scrollIntoView({ block: 'center' });
    sw.click();
  })()`);
  await sleep(400);
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
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

  // #1430: one scripted turn yields an Advisor row.
  await cdp.typeIntoByLabel('Message', 'trigger the scripted advisory');
  await cdp.clickByLabel('Send message');
  const finder = `Array.from(document.querySelectorAll('[data-slot="source-tag"]')).find((e) => e.textContent.trim() === 'Advisor')`;
  await cdp.waitFor(`!!(${finder})`, { timeoutMs: 30_000, label: 'Advisor row rendered' });
  await sleep(500);
  const sizes = await cdp.evaluate(`(() => {
    const tag = ${finder};
    const row = tag.closest('li, [data-item-id], article') || tag.parentElement.parentElement;
    const leaf = (needle) => Array.from(row.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent.includes(needle));
    const size = (el) => (el ? getComputedStyle(el).fontSize : null);
    return { tag: size(tag), severity: size(leaf('Concern') || leaf('concern')), message: size(leaf('share one size')) };
  })()`);
  log(`advisor font sizes: ${JSON.stringify(sizes)}`);
  await shot(cdp, '02-advisor-row.png');
  assert(sizes.tag && sizes.tag === sizes.message, `#1430: Advisor tag size equals the message size (${sizes.tag})`);
  assert(sizes.severity && sizes.severity === sizes.tag, '#1430: severity label size equals the tag size');

  await enableClock(cdp);
  await cdp.waitFor(`!!(${clockButton})`, { timeoutMs: 20_000, label: 'composer clock shown' });
  await shot(cdp, '03-clock-no-alarms.png');
  assert(/Open alarms$/.test(await cdp.evaluate(`${clockButton}.getAttribute('aria-label')`)), '#1426: the clock is a button named "... Open alarms"');
  await cdp.click(clockButton);
  await cdp.waitFor(`!!${DIALOG}`, { timeoutMs: 10_000, label: 'alarms popover open' });
  assert(await cdp.evaluate(`${DIALOG}.textContent.includes('No alarms set')`), '#1426: empty state reads "No alarms set"');
  await shot(cdp, '04-popover-empty.png');

  // Create: one tomorrow-ish (a time a minute ago) and one due in about a minute.
  const now = Date.now();
  await addAlarm(cdp, hhmm(now - 120_000), 'Stand-up');
  await cdp.waitFor(`${DIALOG}.textContent.includes('Tomorrow')`, { timeoutMs: 5_000, label: 'Tomorrow hint' }).catch(() => {});
  assert(await cdp.evaluate(`${DIALOG}.textContent.includes('Tomorrow')`), '#1426: a passed time shows the "Tomorrow" hint');
  await shot(cdp, '05-add-form.png');
  await saveAlarm(cdp);
  await cdp.waitFor(`${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]').length === 1`, { timeoutMs: 10_000, label: 'first alarm listed' });
  assert((await rowLabels(cdp))[0].includes('Stand-up'), '#1426: the saved alarm is listed with its label');
  await sleep(300);
  assert(await cdp.evaluate(`!!(${clockButton}).querySelector('svg.lucide-bell')`), '#1426: the clock shows a bell when an alarm is armed');
  await shot(cdp, '06-popover-one-alarm.png');

  // Edit the label.
  await cdp.click(`${DIALOG}.querySelector('button[aria-label^="Edit alarm"]')`);
  await cdp.waitFor(`!!${DIALOG}.querySelector('[data-slot="time-field"] input')`, { timeoutMs: 10_000, label: 'edit form open' });
  await focusLabelInput(cdp);
  await cdp.send('Input.insertText', { text: ' edited' });
  await saveAlarm(cdp);
  await cdp.waitFor(`${DIALOG}.querySelector('button[aria-label^="Edit alarm"]')?.getAttribute('aria-label').includes('edited')`, { timeoutMs: 10_000, label: 'edit saved' });

  // Add one due at the next minute boundary, then wait for it to fire.
  const dueAt = Math.ceil((Date.now() + 5_000) / 60_000) * 60_000;
  await addAlarm(cdp, hhmm(dueAt), 'Fires soon');
  await saveAlarm(cdp);
  await cdp.waitFor(`!${DIALOG} || !${DIALOG}.querySelector('[data-slot="time-field"] input')`, { timeoutMs: 20_000, label: 'second alarm form closed' });
  await sleep(1200);
  log(`pre-second-listed: ${await cdp.evaluate(`JSON.stringify({ dialog: !!document.querySelector('[role="dialog"]'), text: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 160), focus: document.hasFocus(), rows: document.querySelectorAll('button[aria-label^="Edit alarm"]').length })`)}`);
  // Focus loss from other desktop activity can close the popover; reopen it so the listing check is not environmental.
  if (!(await cdp.evaluate(`!!${DIALOG}`))) await cdp.click(clockButton);
  await cdp.waitFor(`${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]').length === 2`, { timeoutMs: 10_000, label: 'second alarm listed' });
  await shot(cdp, '07-popover-two-alarms.png');
  await cdp.waitFor(`Array.from(${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]')).some((el) => /Fires soon, Fired/.test(el.getAttribute('aria-label')))`, {
    timeoutMs: Math.max(dueAt - Date.now(), 0) + 45_000,
    label: 'second alarm fired and marked Fired'
  });
  await shot(cdp, '08-popover-fired.png');
  assert(
    await cdp.evaluate(`Array.from(${DIALOG}.querySelectorAll('[data-highlighted]')).some((el) => /Fires soon/.test(el.textContent))`),
    '#1457: the fired row is highlighted'
  );
  assert(
    await cdp.evaluate(`/Fires soon, Fired/.test(Array.from(${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]')).map((el) => el.getAttribute('aria-label')).join('|'))`),
    '#1426: a due alarm fires and stays listed as "Fired"'
  );

  const probe = (verb) => `(() => {
    const el = ${DIALOG}.querySelector('[aria-label^="${verb} alarm"][aria-label*="Fires soon"]');
    if (!el) return JSON.stringify({ exists: false });
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return JSON.stringify({ exists: true, rect: [r.left, r.top, r.width, r.height], hitIsSelf: !!hit && (hit === el || el.contains(hit)), inViewport: r.top >= 0 && r.bottom <= innerHeight });
  })()`;
  const dismissProbe = JSON.parse(await cdp.evaluate(probe('Dismiss')));
  const rearmProbe = JSON.parse(await cdp.evaluate(probe('Re-arm')));
  log(`fired actions: dismiss ${JSON.stringify(dismissProbe)} rearm ${JSON.stringify(rearmProbe)}`);
  await shot(cdp, '08a-fired-actions.png');
  assert(dismissProbe.exists && dismissProbe.hitIsSelf && dismissProbe.inViewport, '#1463: Dismiss is present, unclipped and clickable on the fired row');
  assert(rearmProbe.exists && rearmProbe.hitIsSelf && rearmProbe.inViewport, '#1463: Re-arm is present, unclipped and clickable on the fired row');
  await cdp.click(`${DIALOG}.querySelector('[aria-label^="Re-arm alarm"][aria-label*="Fires soon"]')`);
  await sleep(600);
  await shot(cdp, '08c-after-rearm.png');
  log(`after re-arm: ${await cdp.evaluate(`Array.from(${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]')).map((el) => el.getAttribute('aria-label')).join('|')`)}`);

  // Delete the fired one, then the other.
  await cdp.click(`${DIALOG}.querySelector('button[aria-label^="Delete alarm"][aria-label*="Fires soon"]')`);
  await sleep(500);
  log(`after delete: ${await cdp.evaluate(`JSON.stringify({ dialog: !!document.querySelector('[role="dialog"]'), active: document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute('aria-label') ?? ''), alarms: document.querySelectorAll('button[aria-label^="Edit alarm"]').length })`)}`);
  await shot(cdp, '08b-after-delete.png');
  await cdp.waitFor(`${DIALOG}.querySelectorAll('button[aria-label^="Edit alarm"]').length === 1`, { timeoutMs: 10_000, label: 'fired alarm deleted' });
  await cdp.click(`${DIALOG}.querySelector('button[aria-label^="Delete alarm"]')`);
  await cdp.waitFor(`${DIALOG}.textContent.includes('No alarms set')`, { timeoutMs: 10_000, label: 'all alarms deleted' });
  assert(await cdp.evaluate(`!(${clockButton}).querySelector('svg.lucide-bell')`), '#1426: the bell disappears once no alarm is armed');
  await shot(cdp, '09-popover-after-delete.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-072: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-072-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-072-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-072-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-072-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-072-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_072_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'advisor-1430'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-072: ALL PASS (${passed} checks) at head ${head}`);
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
  console.error('verify-tauri-072: FAIL');
  console.error(err);
  process.exitCode = 1;
});
