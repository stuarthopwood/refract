#!/usr/bin/env node
// Live CDP check for #2002 / #1940 / #1765 (T069): Settings rows show their own save status, and opening Settings writes nothing.
// Drives the built debug exe (scratch copy) against the REAL `omp` CLI with PI_CODING_AGENT_DIR pointed at a scratch agent dir
// and a legacy token-guard.json. A forwarding omp shim fails every `config set` while the app launches (so the launch migration
// fails and Readiness passes), then holds every `config set` for 1 s: the first save then retries the migration, which holds
// its lock for about a minute (the #1940 case). Without PI_CODING_AGENT_DIR a debug build skips the migration (FR-035). The
// real ~/.omp is never read or written.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_2002_DIR=<task dir> node scripts/verify-tauri-2002.mjs
// Proves: (a) opening Settings > Models shows no "Saving..." and writes nothing (SC-010, FR-040); (b) a save made while the
// migration holds the lock shows "Saving..." on that row only, for as long as the lock is held (SC-011); (c) it then lands,
// "Saved" shows and clears; (d) reopening Settings afterwards leaves config.yml byte-identical.

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-2002';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const TASK_DIR = process.env.REFRACT_2002_DIR || path.join(tmpdir(), 'refract-2002');
const EVIDENCE_DIR = path.join(TASK_DIR, 'evidence');
const KEY = 'plan.defaultOnStartup';
// While a migration retry runs, each `omp config set` is held this long on top of omp's own 4-7 s on this machine, so the
// ~14-write migration holds its lock for about two minutes; a longer hold pushes a call past the 15 s omp timeout (seen at 4 s).
const SET_DELAY_MS = 1000;
const MODEL = 'probe-fake/probe-fake-model';
const ORIGINAL_CONFIG = ['task:', '  maxConcurrency: 2', 'modelRoles:', `  default: ${MODEL}`, ''].join('\n');
const MODELS_YML = ['providers:', '  probe-fake:', '    baseUrl: http://127.0.0.1:1', '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-fake-model', '        name: Probe Fake Model', '        api: openai-completions', '        contextWindow: 200000', '        maxTokens: 1000', ''].join('\n');
const LEGACY_STORE = { version: 2, overrides: { 'task.maxConcurrency': 3, 'compaction.thresholdPercent': 70 }, read_limit_migrated: true, thresholds_reset_pending: false };

const report = { inputs: {}, checks: [] };
const shotNames = [];
function check(ok, label, evidence) {
  report.checks.push({ label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
const SWITCH = `document.getElementById(${JSON.stringify(`advanced-${KEY}`)})`;
const ROW_STATUS = `document.getElementById(${JSON.stringify(`advanced-${KEY}-save`)})`;

/** True while the process `pid` exists; a read-only tasklist query, never a kill. */
function isProcessAlive(pid) {
  return spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(String(pid));
}

/** Runs the real omp against the scratch agent dir only. */
function omp(agentDir, ...args) {
  const result = spawnSync('omp', args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  if (result.status !== 0) throw new Error(`omp ${args.join(' ')} failed: ${result.stderr}`);
  return JSON.parse(result.stdout).value;
}

async function shoot(cdp, name) {
  await cdp.screenshot(path.join(EVIDENCE_DIR, name));
  shotNames.push(name);
}

/** Records every change of "any Saving... text on the page" and of the one row's status text, with timestamps. */
const SAMPLER = `(() => {
  const s = { t0: performance.now(), events: [] };
  let last = null;
  setInterval(() => {
    const anySaving = Array.from(document.querySelectorAll('[data-slot="inline-status"]')).map((e) => e.textContent.trim()).filter((t) => /Saving/.test(t));
    const row = ${ROW_STATUS};
    const rowText = row ? row.textContent.trim() : '';
    const sig = JSON.stringify([anySaving, rowText]);
    if (sig === last) return;
    last = sig;
    s.events.push({ ms: Math.round(performance.now() - s.t0), anySaving, rowText });
  }, 40);
  window.__sampler2002 = s;
  return true;
})()`;

/** Every control with its disabled state, in DOM order, so two snapshots can be diffed by index. */
const CONTROLS = `Array.from(document.querySelectorAll('button, input, select, textarea, [role="switch"]')).map((el, i) => ({ i, tag: el.tagName, id: el.id, label: el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }))`;
const ROW_ROOT = `${SWITCH}.closest('.\\\\@container').parentElement`;

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    pathPrepend: path.dirname(env.shimExe),
    logFile: path.join(env.runDir, `app-${port}.log`),
    extraEnv: {
      PI_CODING_AGENT_DIR: env.agentDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-2002-omp-delay.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_2002_REAL_OMP: env.realOmp,
      REFRACT_2002_SET_DELAY_MS: String(SET_DELAY_MS),
      REFRACT_2002_MODE_FILE: env.modeFile
    }
  });
  const closeInfo = { pid: launched.targetPid };
  report.cdpSocket = closeInfo;
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  cdp.ws.addEventListener('close', (event) => {
    Object.assign(closeInfo, { closedAt: new Date().toISOString(), code: event.code, reason: event.reason, wasClean: event.wasClean, appProcessAlive: isProcessAlive(launched.targetPid), launcherExited: launched.child.exitCode !== null });
    console.log(`${LOG}: CDP socket closed ${JSON.stringify(closeInfo)}`);
  });
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child, port, pid: launched.targetPid };
}

async function addProject(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
  if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]') && !!document.querySelector('[data-readiness-primary]')`)) {
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
}

async function openSettingsSection(cdp, section, marker) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  }
  await cdp.click(navButton(section));
  await cdp.waitFor(`document.body.textContent.includes(${JSON.stringify(marker)})`, { timeoutMs: 30_000, label: `${section} rendered` });
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const runDir = path.join(TASK_DIR, 'run');
  const dataDir = path.join(runDir, 'data');
  const agentDir = path.join(runDir, 'agent');
  const importSourceDir = path.join(runDir, 'import');
  const repoBase = path.join(runDir, 'repo');
  const exeDir = path.join(runDir, 'exe');
  const launcherDir = path.join(runDir, 'launcher');
  for (const d of [dataDir, agentDir, importSourceDir, repoBase, exeDir, launcherDir]) mkdirSync(d, { recursive: true });
  const repoDir = makeScratchRepo(repoBase, 'verify-2002');
  const exe = path.join(exeDir, 'refract-tauri.exe');
  const markerFile = path.join(dataDir, 'token-guard-migration.json');
  const configFile = path.join(agentDir, 'config.yml');
  let session;
  try {
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    report.inputs = { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: sha256OfFile(exe), dataDir, agentDir, repoDir, legacyStore: LEGACY_STORE, originalConfig: ORIGINAL_CONFIG, key: KEY };
    check([exe, dataDir, agentDir].every((p) => p.startsWith(tmpdir())), 'Isolation: exe, data dir and OMP agent dir are scratch paths under the temp dir', { exe, dataDir, agentDir });

    writeFileSync(configFile, ORIGINAL_CONFIG);
    writeFileSync(path.join(agentDir, 'models.yml'), MODELS_YML);
    writeFileSync(path.join(dataDir, 'token-guard.json'), JSON.stringify(LEGACY_STORE, null, 2));
    const realOmp = spawnSync('where', ['omp'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)[0].trim();
    if (!existsSync(realOmp)) throw new Error('omp not found on PATH');
    const shimExe = buildOmpShim(path.join(runDir, 'shim'));
    report.inputs.realOmp = realOmp;
    report.inputs.setDelayMs = SET_DELAY_MS;
    const modeFile = path.join(runDir, 'omp-mode.txt');
    writeFileSync(modeFile, 'fail');
    const env = { launcherExe, exe, dataDir, importSourceDir, agentDir, runDir, shimExe, realOmp, modeFile };

    session = await launch(env);
    const { cdp } = session;
    await addProject(cdp, repoDir);
    await cdp.evaluate(SAMPLER);

    // (a) Models, after the launch migration failed (every set was refused).
    const configBeforeOpen = sha256OfFile(configFile);
    const migrationPendingAtOpen = !existsSync(markerFile);
    await openSettingsSection(cdp, 'Models', 'Advisor');
    await cdp.waitFor(`!!document.getElementById('model-role-advisor-change')`, { timeoutMs: 30_000, label: 'Advisor row' });
    await sleep(6000);
    const modelsReading = await cdp.evaluate(`({ anySaving: window.__sampler2002.events.filter((e) => e.anySaving.length > 0), statuses: Array.from(document.querySelectorAll('[data-slot="inline-status"]')).map((e) => e.textContent.trim()), events: window.__sampler2002.events })`);
    report.modelsReading = { migrationPendingAtOpen, markerAfter: existsSync(markerFile), ...modelsReading };
    check(migrationPendingAtOpen && configBeforeOpen === sha256OfFile(configFile), 'SC-010/FR-040 precondition: the launch migration had not completed (no marker) and config.yml is unchanged after opening Models', { migrationPendingAtOpen });
    check(modelsReading.anySaving.length === 0, 'SC-010: no "Saving..." text appeared anywhere from before Settings opened to 6 s after the Models pane rendered', modelsReading.anySaving);
    await shoot(cdp, 'models-open-no-saving-on-any-row.png');

    // (b) a save while the migration retry holds the lock.
    writeFileSync(modeFile, 'slow');
    await openSettingsSection(cdp, 'Advanced', 'File read line limit');
    await cdp.waitFor(`!!${SWITCH} && !${SWITCH}.disabled`, { timeoutMs: 30_000, label: `${KEY} switch enabled` });
    await cdp.evaluate(`${SWITCH}.scrollIntoView({ block: 'center' })`);
    const before = await cdp.evaluate(`({ checked: ${SWITCH}.getAttribute('aria-checked'), controls: ${CONTROLS} })`);
    const markerAtClick = existsSync(markerFile);
    await cdp.click(SWITCH);
    const savingAt = Date.now();
    await cdp.waitFor(`window.__sampler2002.events.some((e) => /Saving/.test(e.rowText))`, { timeoutMs: 10_000, label: 'row shows Saving...' });
    const during = await cdp.evaluate(`({ checked: ${SWITCH}.getAttribute('aria-checked'), rowText: ${ROW_STATUS}?.textContent.trim() ?? '', controls: ${CONTROLS}, newlyDisabledInsideRow: null })`);
    const newlyDisabled = during.controls.filter((c, i) => c.disabled && !before.controls[i]?.disabled);
    const outside = await cdp.evaluate(`(() => { const root = ${ROW_ROOT}; const els = Array.from(document.querySelectorAll('button, input, select, textarea, [role="switch"]')); return ${JSON.stringify(newlyDisabled.map((c) => c.i))}.map((i) => root.contains(els[i])); })()`);
    const markerWhileSaving = existsSync(markerFile);
    report.savingReading = { markerAtClick, markerWhileSaving, before: { checked: before.checked }, during: { checked: during.checked, rowText: during.rowText }, newlyDisabled, newlyDisabledInsideRow: outside, controlCounts: [before.controls.length, during.controls.length] };
    check(before.controls.length === during.controls.length, 'Controls: the same set of controls is on the page before and during the save', report.savingReading.controlCounts);
    check(!markerAtClick, 'SC-011 precondition: the migration marker was absent when the save was made', { markerAtClick });
    check(!markerWhileSaving && /Saving/.test(during.rowText), 'SC-011: the row reads "Saving..." while the migration holds the lock', { rowText: during.rowText, markerWhileSaving });
    check(newlyDisabled.length > 0 && outside.every(Boolean), 'SC-011: only controls inside that row became disabled', { newlyDisabled, inside: outside });
    check(during.checked !== before.checked, 'SC-011: the switch shows the pending value while saving', { before: before.checked, during: during.checked });
    await sleep(20_000);
    const later = await cdp.evaluate(`({ rowText: ${ROW_STATUS}?.textContent.trim() ?? '', controls: ${CONTROLS} })`);
    const disabledLater = later.controls.filter((c, i) => c.disabled && !before.controls[i]?.disabled).map((c) => c.id || c.i);
    report.savingReading.afterTwentySeconds = { rowText: later.rowText, markerPresent: existsSync(markerFile), newlyDisabled: disabledLater };
    check(/Saving/.test(later.rowText) && !existsSync(markerFile) && disabledLater.length === newlyDisabled.length, 'SC-011: 20 s later the lock is still held, the row still reads "Saving..." and no other control is disabled', report.savingReading.afterTwentySeconds);
    await shoot(cdp, 'advanced-start-in-plan-mode-saving-only-that-row-disabled.png');

    // (c) lands, then "Saved", then clears.
    await cdp.waitFor(`window.__sampler2002.events.some((e) => e.rowText === 'Saved')`, { timeoutMs: 240_000, intervalMs: 100, label: 'row shows Saved' });
    const landedAfterMs = Date.now() - savingAt;
    await shoot(cdp, 'advanced-start-in-plan-mode-saved.png');
    await cdp.waitFor(`window.__sampler2002.events.at(-1).rowText === ''`, { timeoutMs: 15_000, label: 'Saved clears' });
    const events = await cdp.evaluate(`window.__sampler2002.events`);
    const rowTexts = events.map((e) => e.rowText).filter((t, i, a) => i === 0 || t !== a[i - 1]);
    const savedAt = events.find((e) => e.rowText === 'Saved').ms;
    const clearedAt = events.find((e) => e.ms > savedAt && e.rowText === '').ms;
    report.rowTimeline = { events, rowTexts, landedAfterMs, savedVisibleMs: clearedAt - savedAt };
    check(['Saving', 'Saved'].every((w, i) => rowTexts.filter(Boolean)[i]?.startsWith(w)) && rowTexts.at(-1) === '', 'The row went Saving... then Saved then blank', rowTexts);
    check(clearedAt - savedAt >= 2500 && clearedAt - savedAt <= 5000, '"Saved" cleared on its own after about 3 s', { savedVisibleMs: clearedAt - savedAt });
    check(existsSync(markerFile), 'The migration finished (marker written) before the save landed', null);
    check(omp(agentDir, 'config', 'get', KEY, '--json') === (before.checked !== 'true'), `The save landed in the global config (${KEY} flipped)`, omp(agentDir, 'config', 'get', KEY, '--json'));

    // (d) reopening Settings writes nothing.
    const configBefore = sha256OfFile(configFile);
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await openSettingsSection(cdp, 'Models', 'Advisor');
    await openSettingsSection(cdp, 'Advanced', 'File read line limit');
    await sleep(4000);
    const configAfter = sha256OfFile(configFile);
    check(configBefore === configAfter, 'FR-040: reopening Settings leaves config.yml byte-identical', { configBefore, configAfter });
    const lateSaving = await cdp.evaluate(`window.__sampler2002.events.filter((e) => e.ms > ${events.at(-1).ms} && e.anySaving.length > 0)`);
    check(lateSaving.length === 0, 'Reopening Settings shows no "Saving..." anywhere', lateSaving);
  } catch (err) {
    report.checks.push({ label: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(EVIDENCE_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    report.screenshots = shotNames.map((name) => ({ name, sha256: sha256OfFile(path.join(EVIDENCE_DIR, name)) }));
    writeFileSync(path.join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(EVIDENCE_DIR, 'sha256.json'), JSON.stringify({ exe: report.inputs.exeSha256, screenshots: report.screenshots, report: sha256OfFile(path.join(EVIDENCE_DIR, 'report.json')) }, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
  }
  if (report.checks.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${EVIDENCE_DIR}; ${readdirSync(EVIDENCE_DIR).length} files`);
}

main();
