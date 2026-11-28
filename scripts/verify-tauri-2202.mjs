#!/usr/bin/env node
// Live CDP check for #2202 (a peer Session message steers into a busy target). Two Sessions, A and B; tape
// scripts/fixtures/omp-frames/steer-2202.jsonl. Session A's fake omp emits a `host_tool_call` for
// `refract_send_session_message`, the wire the real omp uses; the proof is the fake omp's own RECV log for B.
// Env: REFRACT_2202_SCRATCH_DIR, REFRACT_2202_SHOTS_DIR. Needs the shared CARGO_TARGET_DIR.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.REFRACT_2202_SCRATCH_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/live-2202';
const SHOTS_DIR = process.env.REFRACT_2202_SHOTS_DIR || path.join(SCRATCH, `shots-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEER_BUSY = 'Peer note while you are busy.';
const PEER_IDLE = 'Peer note while you are idle.';

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  const check = (name, ok, detail) => {
    findings.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failures.push(`#2202: ${name}: ${detail}`);
  };
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    mkdirSync(SCRATCH, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(SCRATCH, `${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(SCRATCH, 'repo-')), 'verify-2202');
    const callsFile = path.join(dirs.data, 'host-calls.jsonl');
    const recordFile = path.join(dirs.data, 'host-tools.jsonl');
    const invocationLog = path.join(dirs.exe, 'fake-omp-invocations.log');
    writeFileSync(callsFile, '');
    writeFileSync(recordFile, '');

    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-2202' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'steer-2202',
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
        REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: invocationLog
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });

    const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pidAfter = async (known) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !known.includes(r.pid));
        if (hit) return hit.pid;
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    };
    const resultFor = async (id) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        await sleep(150);
      }
      throw new Error(`no host_tool_result for ${id} within 20s`);
    };
    let n = 0;
    const sendFromA = async (pidA, id, text) => {
      const callId = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id: callId, toolCallId: `t-${n}`, toolName: 'refract_send_session_message', arguments: { id, text }, __pid: pidA })}\n`);
      return resultFor(callId);
    };
    // The B prompts the fake omp received, in order, read from its own invocation log.
    const promptsFor = (pid) =>
      readFileSync(invocationLog, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith(`pid=${pid} RECV `))
        .map((l) => JSON.parse(l.slice(`pid=${pid} RECV `.length).replace(/ \(waitingFor=.*\)$/, '')))
        .filter((cmd) => cmd.type === 'prompt');
    const waitForPrompts = async (pid, count) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const got = promptsFor(pid);
        if (got.length >= count) return got;
        await sleep(150);
      }
      throw new Error(`pid ${pid} received ${promptsFor(pid).length} prompts, wanted ${count}`);
    };

    const repoName = path.basename(dirs.repo);
    await addRepository(cdp, dirs.repo);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    const pidA = await pidAfter([]);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
    const pidB = await pidAfter([pidA]);
    await waitForSessionStatus(cdp, sessionA.id, 'idle');
    await waitForSessionStatus(cdp, sessionB.id, 'idle');
    findings.push(`sessions: ${JSON.stringify({ sessionA, sessionB, pidA, pidB })}`);

    // B is the open Session: start its turn, which the tape holds open.
    await cdp.typeIntoByLabel('Message', 'Start a long turn (issue #2202 live check).');
    await cdp.clickByLabel('Send message');
    await waitForSessionStatus(cdp, sessionB.id, 'working');

    const busy = await sendFromA(pidA, sessionB.id, PEER_BUSY);
    check('send to busy B returned outcome "queued" (the tool name for a steer into a running turn)', !busy.isError && busy.body.outcome === 'queued', JSON.stringify(busy));
    const afterBusy = await waitForPrompts(pidB, 2);
    const steered = afterBusy[1];
    check('busy B received the peer message as streamingBehavior "steer"', steered.streamingBehavior === 'steer' && String(steered.message).includes(PEER_BUSY), JSON.stringify(steered));
    check('first (typed) prompt carries no streamingBehavior', afterBusy[0].streamingBehavior === undefined, JSON.stringify(afterBusy[0]));
    check('no prompt to B used followUp', !afterBusy.some((p) => p.streamingBehavior === 'followUp'), JSON.stringify(afterBusy.map((p) => p.streamingBehavior ?? null)));

    await cdp.waitFor(`document.body.innerText.includes('turn one done')`, { timeoutMs: 30_000, label: 'B turn one settled' });
    await waitForSessionStatus(cdp, sessionB.id, 'idle');

    const idle = await sendFromA(pidA, sessionB.id, PEER_IDLE);
    check('send to idle B returned outcome "sent"', !idle.isError && idle.body.outcome === 'sent', JSON.stringify(idle));
    const afterIdle = await waitForPrompts(pidB, 3);
    const plain = afterIdle[2];
    check('idle B received the peer message as a plain prompt with no streamingBehavior', plain.type === 'prompt' && !('streamingBehavior' in plain) && String(plain.message).includes(PEER_IDLE), JSON.stringify(plain));
    await cdp.waitFor(`document.body.innerText.includes('turn two done')`, { timeoutMs: 30_000, label: 'B turn two settled' });
    await cdp.screenshot(path.join(SHOTS_DIR, '2202-b-after-both-messages.png'));

    findings.push(`prompts to B: ${JSON.stringify(afterIdle.map((p) => ({ streamingBehavior: p.streamingBehavior ?? null, message: String(p.message).slice(0, 80) })))}`);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ findings, failures, shotsDir: SHOTS_DIR }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '2202-error.png')).catch(() => {});
    } catch {}
    console.error('verify-2202: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const f of ['app.log', 'fake-omp-invocations.log']) {
        if (dirs.exe && existsSync(path.join(dirs.exe, f))) copyFileSync(path.join(dirs.exe, f), path.join(SHOTS_DIR, f));
      }
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
