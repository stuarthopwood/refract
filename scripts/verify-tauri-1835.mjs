#!/usr/bin/env node
// Live CDP check for issue #1835: Pause cancels the Session's subagents, against the scratch Tauri debug build and the
// REAL omp (18.18.3, Probe520 copy) pointed at a scratch HOME and an in-process mock model. No real model is ever called.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1835.mjs
// Env: REFRACT_1835_SHOTS_DIR overrides the evidence directory; REFRACT_1835_OMP_EXE overrides the real omp binary.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim, connectCdp, pressRealEnter, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { startMockModel } from './verify-tauri-1835-mock-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1835';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1835_SHOTS_DIR;
if (!SHOTS_DIR) throw new Error('verify-1835: set REFRACT_1835_SHOTS_DIR to a scratch directory');
const OMP_EXE = process.env.REFRACT_1835_OMP_EXE || 'C:/Users/shopwood/AppData/Local/Temp/Probe520/bin/omp-windows-x64.exe';
const PROFILE = 'probe520';
const MODEL = 'probe-mock/probe-model';
const WIRE_LOG = path.join(SHOTS_DIR, 'wire.jsonl');
const MOCK_LOG = path.join(SHOTS_DIR, 'mock-requests.jsonl');

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence).slice(0, 600)}`);
  if (ok !== true) process.exitCode = 1;
}

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

async function sendPrompt(cdp, text) {
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.send('Input.insertText', { text });
  await pressRealEnter(cdp);
}

const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const wireLines = () => readJsonl(WIRE_LOG);

/** Runs `get_subagents` on the real omp through the wrapper (not through Refract) and returns omp's own answer. */
let injectCount = 0;
async function ompSubagents(injectDir) {
  const id = `verify-${++injectCount}`;
  writeFileSync(path.join(injectDir, `inject-${injectCount}.json`), JSON.stringify({ id, type: 'get_subagents' }));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const hit = wireLines().find((l) => l.dir === 'omp->refract' && l.frame?.id === id);
    if (hit) return hit.frame;
    await sleep(200);
  }
  throw new Error(`omp never answered injected ${id}`);
}
const listedIds = (response) => (response?.data?.subagents ?? response?.data ?? []).map((s) => s.id ?? s.subagentId);

/** Frames Refract sent to or received from omp, optionally only after a timestamp. */
const refractRpcs = (type, since = 0) => wireLines().filter((l) => l.dir === 'refract->omp' && !l.injected && l.frame?.type === type && l.at >= since);
const lifecycle = (status, since = 0) => wireLines().filter((l) => l.dir === 'omp->refract' && l.frame?.type === 'subagent_lifecycle' && (l.frame?.status ?? l.frame?.payload?.status) === status && l.at >= since);

const sessionRow = (cdp, sessionId) => cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? r.value.find((s) => s.id === ${JSON.stringify(sessionId)}) ?? null : null).then((s) => s && { status: s.status, pause: s.pause ?? null })`);
const bodyText = (cdp) => cdp.evaluate('document.body.innerText');
const announcements = [];
/** Waits for the PausedBody polite live region to hold `needle`; records and returns its text. */
async function announced(cdp, needle) {
  const expr = `[...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent).find((t) => t.includes(${JSON.stringify(needle)})) ?? null`;
  const ok = await cdp.waitFor(`!!(${expr})`, { timeoutMs: 15_000, label: `announcement "${needle}"` }).catch(() => false);
  const text = ok ? await cdp.evaluate(expr) : null;
  announcements.push(text);
  return text;
}

async function waitForPause(cdp, sessionId, want, timeoutMs = 60_000) {
  await cdp.waitFor(`window.refract.sessions.list().then((r) => { const s = r.ok && r.value.find((x) => x.id === ${JSON.stringify(sessionId)}); return ${want === null ? '!!s && !s.pause' : `!!s && s.pause === ${JSON.stringify(want)}`}; })`, { timeoutMs, label: `pause state ${want}` });
}
async function waitForText(cdp, needle, timeoutMs = 30_000) {
  await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(needle)})`, { timeoutMs, label: `text "${needle}"` });
}
async function waitUntil(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out: ${label}`);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  writeFileSync(WIRE_LOG, '');
  writeFileSync(MOCK_LOG, '');
  const scratch = (label) => mkdtempSync(path.join(tmpdir(), `refract-1835-${label}-`));
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir, ompHome, injectDir] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim', 'home', 'inject'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1835');
  const dirs = [dataDir, importSourceDir, repoDirBase, worktreesDirFor(repoDir), exeDir, launcherDir, shimDir, ompHome, injectDir];
  let cdp;
  let child;
  let mock;
  try {
    if (!existsSync(OMP_EXE)) throw new Error(`real omp binary not found at ${OMP_EXE}`);
    const agentDir = path.join(ompHome, '.omp', 'profiles', PROFILE, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const mockPort = await getFreePort();
    writeFileSync(path.join(agentDir, 'models.yml'), ['providers:', '  probe-mock:', `    baseUrl: http://127.0.0.1:${mockPort}/v1`, '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-model', '        name: Probe Model', '        api: openai-completions', '        contextWindow: 8000', '        maxTokens: 1000', ''].join('\n'));
    writeFileSync(path.join(agentDir, 'config.yml'), `modelRoles:\n  default: ${MODEL}\n`);
    mock = await startMockModel({ port: mockPort, logFile: MOCK_LOG });

    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: built.hash, exeMtime: built.mtime, builtDuringThisRun: built.builtDuringThisRun, ompExe: OMP_EXE, ompExeSha256: sha256OfFile(OMP_EXE) } });
    check([exeDir, dataDir, importSourceDir, ompHome].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir, import source and omp HOME are scratch dirs; the real ~/.omp is never used', { dataDir, ompHome });

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-1835-omp-wrapper.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_1835_OMP_EXE: OMP_EXE,
        REFRACT_1835_OMP_HOME: ompHome,
        REFRACT_1835_WIRE_LOG: WIRE_LOG,
        REFRACT_1835_MODEL: MODEL,
        REFRACT_1835_PROFILE: PROFILE,
        REFRACT_1835_INJECT_DIR: injectDir
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    const sessions = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? r.value.map((s) => s.id) : [])`);
    if (sessions.length !== 1) throw new Error(`expected exactly the one Session this run created, got ${JSON.stringify(sessions)}`);
    const sessionId = sessions[0];

    // ---- 1. Pause cancels both running subagents and the Session reaches Paused.
    await sendPrompt(cdp, 'SPAWN NOW: start two long-running subagents.');
    await waitUntil(() => mock.subagents.length >= 2 && lifecycle('started').length >= 2, 'two subagents started and waiting on the model', 120_000);
    const before = await ompSubagents(injectDir);
    const runningBefore = listedIds(before);
    check(runningBefore.length === 2, '1a. Before Pause, omp reports two running subagents', before);
    await sleep(1500);
    await shoot(cdp, '01-two-subagents-running-before-pause.png');
    const statusBefore = await sessionRow(cdp, sessionId);

    const pausedAt = Date.now();
    const pauseResult = await cdp.evaluate(`window.refract.chat.pause(${JSON.stringify(sessionId)})`);
    check(pauseResult?.ok === true, '1b. chat.pause returns ok', pauseResult);
    await waitForPause(cdp, sessionId, 'paused');
    const rowPaused = await sessionRow(cdp, sessionId);
    check(rowPaused?.pause === 'paused' && rowPaused.status !== 'working', '1c. The Session reaches Paused (pause=paused, no longer working)', { statusBefore, rowPaused });
    const after = await ompSubagents(injectDir);
    check(listedIds(after).length === 0, '1d. After Pause, omp get_subagents shows no running subagent', after);
    const cancelRpcs = refractRpcs('cancel_subagent', pausedAt);
    const cancelledIds = cancelRpcs.map((l) => l.frame.subagentId).sort();
    check(cancelledIds.length === 2 && JSON.stringify(cancelledIds) === JSON.stringify([...runningBefore].sort()), '1e. Refract sent cancel_subagent for exactly the two running ids', { cancelledIds, runningBefore });
    await waitUntil(() => mock.subagents.filter((s) => s.abortedAt).length === 2, 'both subagent model requests aborted', 15_000).catch(() => {});
    check(mock.subagents.slice(0, 2).every((s) => s.abortedAt), '1f. Both subagents stopped calling the model (their requests were aborted)', mock.subagents);
    await waitForText(cdp, 'Pause cancelled 2 subagents');
    const pauseNotice = (await bodyText(cdp)).split('\n').find((t) => t.includes('Pause cancelled 2 subagents'));
    check(!!pauseNotice, '1g. A notice names the two cancelled subagents', pauseNotice);
    const announcedPause = await announced(cdp, 'Pause cancelled 2 subagents');
    check(!!announcedPause, '4. While Paused the cancel notice is announced by the polite live region', announcedPause);
    await shoot(cdp, '02-paused-both-subagents-cancelled-notice.png');

    // The Subagents panel shows them as Cancelled (FR-009).
    // The Paused overlay covers the readout chip, so open the panel from the right rail.
    await cdp.click(`document.querySelector('[data-rail-button="subagents"]')`);
    const panelOpen = await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel' }).catch(() => false);
    const panelText = panelOpen ? await cdp.evaluate(`document.querySelector('[role="tree"][aria-label="Subagents"]').innerText`) : null;
    check(!!panelText && /cancel/i.test(panelText), '1h. The Subagents panel shows the subagents as Cancelled', panelText);
    await shoot(cdp, '03-subagents-panel-cancelled.png');

    // ---- 3. Resume posts the notice and revives nothing.
    const resumedAt = Date.now();
    const subagentRequestsBeforeResume = mock.subagents.length;
    const resumeResult = await cdp.evaluate(`window.refract.chat.resume(${JSON.stringify(sessionId)})`);
    check(resumeResult?.ok === true, '3a. chat.resume returns ok', resumeResult);
    await waitForPause(cdp, sessionId, null);
    await waitForText(cdp, 'Pause had cancelled 2 subagents');
    const resumeNotice = (await bodyText(cdp)).split('\n').find((t) => t.includes('Pause had cancelled 2 subagents'));
    check(/^Resumed\. Pause had cancelled 2 subagents: .+\. They are not restarted/.test(resumeNotice ?? ''), '3b. Resume posts "Pause had cancelled 2 subagents" and says they are not restarted', resumeNotice);
    const announcedResume = await announced(cdp, 'Pause had cancelled 2 subagents');
    check(!!announcedResume && /not restarted/.test(announcedResume), '4a. Resume announces the cancelled count once, after the status change', announcedResume);
    await sleep(6000);
    const revived = await ompSubagents(injectDir);
    check(listedIds(revived).length === 0 && mock.subagents.length === subagentRequestsBeforeResume && lifecycle('started', resumedAt).length === 0, '3c. Resume revives nothing (no running subagent, no new subagent model request, no new started frame)', { revived, subagentRequests: mock.subagents.length, startedAfterResume: lifecycle('started', resumedAt).length });
    await shoot(cdp, '04-resumed-notice-nothing-revived.png');

    // ---- 2. A subagent spawned while Paused is auto-cancelled with a notice.
    await sendPrompt(cdp, 'SPAWN LATE HOLD: start one long-running subagent after I pause.');
    await waitUntil(() => mock.heldCount() >= 1, 'the parent turn is parked on the model', 60_000);
    const latePausedAt = Date.now();
    const latePause = await cdp.evaluate(`window.refract.chat.pause(${JSON.stringify(sessionId)})`);
    await waitForPause(cdp, sessionId, 'pausing');
    const rowPausing = await sessionRow(cdp, sessionId);
    check(latePause?.ok === true && rowPausing?.pause === 'pausing' && rowPausing.status === 'working', '2a. Pause during a running turn shows Pausing (turn still working)', rowPausing);
    await shoot(cdp, '05-pausing-parent-turn-parked-before-spawn.png');
    mock.release(); // the parent now spawns a subagent while the Session is paused
    await waitUntil(() => lifecycle('started', latePausedAt).length >= 1, 'the late subagent started', 60_000);
    const lateStarted = lifecycle('started', latePausedAt)[0].frame;
    const lateId = lateStarted.id ?? lateStarted.payload?.id;
    await waitForText(cdp, 'which started while this Session was paused');
    const lateNotice = (await bodyText(cdp)).split('\n').find((t) => t.includes('which started while this Session was paused'));
    check(!!lateNotice && lateNotice.includes(lateId), '2b. The subagent that started while paused is auto-cancelled, with a notice naming it', { lateId, lateNotice });
    const announcedAuto = await announced(cdp, 'started while paused');
    check(!!announcedAuto && announcedAuto.includes(lateId), '4b. The auto-cancel notice is announced by the polite live region while Paused', announcedAuto);
    const lateCancels = refractRpcs('cancel_subagent', latePausedAt).map((l) => l.frame.subagentId);
    check(lateCancels.length === 1 && lateCancels[0] === lateId, '2c. Refract sent cancel_subagent for that id', { lateCancels, lateId });
    await waitForPause(cdp, sessionId, 'paused');
    const lateAfter = await ompSubagents(injectDir);
    // The late subagent is cancelled before it reaches its model call, so a model request is optional; one that did arrive must be aborted.
    const lateAborted = lifecycle('aborted', latePausedAt).some((l) => (l.frame.payload?.id ?? l.frame.id) === lateId);
    // The "any model request was aborted" clause is vacuous when the subagent made no request.
    check(listedIds(lateAfter).length === 0 && lateAborted && mock.subagents.slice(2).every((s) => s.abortedAt), '2d. Afterwards omp lists no running subagent and an aborted frame arrived for it (any model request it made was aborted; vacuous if none)', { lateAfter, lateAborted, lateModelRequests: mock.subagents.slice(2) });
    await shoot(cdp, '06-paused-late-subagent-auto-cancelled-notice.png');

    // Resume once more: the notice names the auto-cancelled subagent.
    const lateResume = await cdp.evaluate(`window.refract.chat.resume(${JSON.stringify(sessionId)})`);
    await waitForPause(cdp, sessionId, null);
    await waitForText(cdp, 'Pause had cancelled 1 subagent');
    const lateResumeNotice = (await bodyText(cdp)).split('\n').find((t) => t.includes('Pause had cancelled 1 subagent'));
    check(lateResume?.ok === true && !!lateResumeNotice && lateResumeNotice.includes(lateId), '2e. Resume after the auto-cancel posts "Pause had cancelled 1 subagent" naming it', lateResumeNotice);
    await shoot(cdp, '07-resumed-after-late-auto-cancel-notice.png');
    const announcedLate = await announced(cdp, 'Pause had cancelled 1 subagent');
    check(!!announcedLate, '4c. Resume after the auto-cancel announces the cancelled count', announcedLate);
    writeFileSync(path.join(SHOTS_DIR, 'notices.txt'), (await bodyText(cdp)).split('\n').filter((t) => /Pause (cancelled|could not)|Resumed\./.test(t)).join('\n') + '\n');
    writeFileSync(path.join(SHOTS_DIR, 'announcements.txt'), announcements.filter(Boolean).join('\n') + '\n');
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '99-crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    if (mock) mock.server.close();
    const hashes = {};
    for (const name of [...shotNames, 'wire.jsonl', 'mock-requests.jsonl', 'notices.txt', 'app.log']) {
      const file = path.join(SHOTS_DIR, name);
      if (existsSync(file)) hashes[name] = sha256OfFile(file);
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(hashes, null, 2));
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => !r.ok);
  console.log(`${LOG}: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}; evidence in ${SHOTS_DIR}`);
}

main();
