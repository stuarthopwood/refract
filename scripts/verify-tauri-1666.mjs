#!/usr/bin/env node
// Live check for #1666 (notification sounds) against a real built Tauri debug exe with fake `omp`, a scratch
// REFRACT_DATA_DIR and its own debugging port. Reads each Windows toast's XML back from
// `ToastNotificationManager.History` and asserts the `<audio>` element for alarm, needs-you and finished, with
// the matching Settings toggle on and off. Audio itself cannot be heard from an agent session.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1666_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1666.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1666_SHOTS_DIR || path.join(tmpdir(), 'refract-1666-shots');
const APP_ID = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).identifier;
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

const ps = (script) => {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr}`);
  return r.stdout.trim();
};
const WINRT = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; $h=[Windows.UI.Notifications.ToastNotificationManager]::History;`;
const clearHistory = () => ps(`${WINRT} $h.Clear('${APP_ID}')`);
const readHistory = () => {
  const out = ps(`${WINRT} @($h.GetHistory('${APP_ID}') | ForEach-Object { $_.Content.GetXml() }) | ConvertTo-Json -Compress`);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
};

/** Polls the toast history until a toast whose XML matches `pattern` shows up. */
async function waitForToast(pattern, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readHistory().find((xml) => pattern.test(xml));
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`no toast matching ${pattern} for "${label}" within ${timeoutMs}ms; history: ${JSON.stringify(readHistory())}`);
}
const audioOf = (xml) => (xml.match(/<audio\b[^>]*\/?>/i) || [null])[0];
const evidence = (name, xml) => writeFileSync(path.join(SHOTS_DIR, `${name}.xml`), xml);

/** Spawns notepad so the Refract window loses focus (session toasts only show unfocused); returns its killer. */
async function stealFocus(cdp) {
  const pad = spawn('notepad.exe', [], { stdio: 'ignore', windowsHide: false });
  await sleep(1500);
  // document.hasFocus() stays true under CDP, so read the native foreground process instead.
  const fg = ps(`Add-Type 'using System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'; $p=0; [void][FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(),[ref]$p); (Get-Process -Id $p).ProcessName`);
  log(`foreground process after notepad launch: ${fg}`);
  return { focused: fg !== 'refract-tauri', release: () => spawnSync('taskkill', ['/PID', String(pad.pid), '/F'], { windowsHide: true }) };
}

const SESSION_SWITCH = `Array.from(document.querySelectorAll('[role="switch"]')).find((s) => document.getElementById(s.getAttribute('aria-describedby'))?.textContent.includes('when a Session needs your input'))`;
const ALARM_SWITCH = `Array.from(document.querySelectorAll('[role="switch"]')).find((s) => document.getElementById(s.getAttribute('aria-describedby'))?.textContent.includes('Loop the alarm sound'))`;

/** Opens Settings > Notifications, sets both switches, and returns to chat. */
async function setToggles(cdp, { session, alarm }) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Notifications')`);
  await cdp.waitFor(`!!(${SESSION_SWITCH}) && !!(${ALARM_SWITCH})`, { timeoutMs: 10_000, label: 'sound switches rendered' });
  for (const [finder, want, name] of [[SESSION_SWITCH, session, 'Session notification sounds'], [ALARM_SWITCH, alarm, 'Alarm sounds']]) {
    const isOn = await cdp.evaluate(`(${finder}).getAttribute('aria-checked') === 'true'`);
    if (isOn !== want) await cdp.click(finder);
    await cdp.waitFor(`(${finder}).getAttribute('aria-checked') === '${want}'`, { timeoutMs: 5_000, label: `${name} ${want ? 'on' : 'off'}` });
  }
  await sleep(500);
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
}

const approve = (cdp) => cdp.clickByText('Approve');

async function sessionCase(cdp, repoName, on) {
  const tag = on ? 'on' : 'off';
  await createSessionViaQuickCreate(cdp, repoName);
  await cdp.waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, { timeoutMs: 30_000, label: 'composer' });
  clearHistory();
  await cdp.typeIntoByLabel('Message', `sounds ${tag}`);
  await cdp.clickByLabel('Send message');
  const focus = await stealFocus(cdp);
  try {
    assert(focus.focused === true, `Refract is not the foreground window for the session cases (${tag})`);
    await cdp.waitFor(`Array.from(document.querySelectorAll('button')).some((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'approval card' });
    const needs = await waitForToast(/needs your input/, `needs-you ${tag}`);
    evidence(`needs-you-${tag}`, needs);
    log(`needs-you (${tag}) audio: ${audioOf(needs)}`);
    if (on) assert(/Notification\.Reminder/i.test(audioOf(needs) ?? ''), 'needs-you toast plays the Reminder sound when the setting is on');
    else assert(/silent="true"/i.test(audioOf(needs) ?? ""), 'needs-you toast is <audio silent="true"/> when the setting is off');
    clearHistory();
    await approve(cdp);
    const done = await waitForToast(/finished\./, `finished ${tag}`, 40_000);
    evidence(`finished-${tag}`, done);
    log(`finished (${tag}) audio: ${audioOf(done)}`);
    if (on) // tauri-winrt-notification omits <audio> for Sound::Default, which leaves the OS default toast sound audible.
    assert(audioOf(done) === null, 'finished toast carries no <audio> element (OS default sound) when the setting is on');
    else assert(/silent="true"/i.test(audioOf(done) ?? ""), 'finished toast is <audio silent="true"/> when the setting is off');
  } finally {
    focus.release();
  }
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const DIALOG = `document.querySelector('[role="dialog"][aria-label="Alarms"]')`;
const clockButton = `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Current time'))`;

async function enableClock(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await sleep(600);
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Status line')`);
  await sleep(600);
  await cdp.evaluate(`(() => {
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).find((s) => document.getElementById(s.getAttribute('aria-describedby'))?.textContent.includes('current time of day'));
    sw.scrollIntoView({ block: 'center' });
    sw.click();
  })()`);
  await sleep(400);
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!!(${clockButton})`, { timeoutMs: 20_000, label: 'composer clock shown' });
}

async function alarmCase(cdp, on) {
  const tag = on ? 'on' : 'off';
  clearHistory();
  const label = `Alarm ${tag}`;
  if (!(await cdp.evaluate(`!!${DIALOG}`))) await cdp.click(clockButton);
  await cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add alarm')`);
  await cdp.waitFor(`!!${DIALOG}.querySelector('[data-slot="time-field"] input')`, { timeoutMs: 10_000, label: 'alarm form open' });
  const dueAt = Math.ceil((Date.now() + 5_000) / 60_000) * 60_000;
  await cdp.evaluate(`(() => {
    const i = ${DIALOG}.querySelector('[data-slot="time-field"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(hhmm(dueAt))});
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const labelInput = `${DIALOG}.querySelector('input:not([data-slot="time-field"] input)')`;
  await cdp.click(labelInput);
  await cdp.waitFor(`document.activeElement === (${labelInput})`, { timeoutMs: 5_000, label: 'alarm label focused' });
  await cdp.send('Input.insertText', { text: label });
  await cdp.click(`Array.from(${DIALOG}.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save')`);
  const xml = await waitForToast(new RegExp(label), `alarm ${tag}`, Math.max(dueAt - Date.now(), 0) + 45_000);
  evidence(`alarm-${tag}`, xml);
  log(`alarm (${tag}) audio: ${audioOf(xml)}; scenario: ${(xml.match(/scenario="[^"]*"/) || [null])[0]}`);
  assert(/scenario="alarm"/i.test(xml), `alarm toast uses the Alarm scenario (${tag})`);
  if (on) assert(/Looping\.Alarm/i.test(audioOf(xml) ?? '') && /loop="true"/i.test(audioOf(xml) ?? ''), 'alarm toast loops Looping.Alarm when the setting is on');
  else assert(/silent="true"/i.test(audioOf(xml) ?? ""), 'alarm toast is <audio silent="true"/> when the setting is off');
  if (await cdp.evaluate(`!!${DIALOG}`)) await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
}

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
  await addRepository(cdp, repoDir);
  const repoName = path.basename(repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });

  await setToggles(cdp, { session: true, alarm: true });
  await sessionCase(cdp, repoName, true);
  await enableClock(cdp);
  await alarmCase(cdp, true);

  await setToggles(cdp, { session: false, alarm: false });
  await sessionCase(cdp, repoName, false);
  await alarmCase(cdp, false);
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-1666: head ${head}, evidence ${SHOTS_DIR}, appId ${APP_ID}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1666-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1666-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-1666-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1666-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1666-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_1666_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
        REFRACT_FAKE_OMP_SCENARIO: 'session'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-1666: ALL PASS (${passed} checks) at head ${head}`);
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
  console.error('verify-tauri-1666: FAIL');
  console.error(err);
  process.exitCode = 1;
});
