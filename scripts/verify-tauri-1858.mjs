#!/usr/bin/env node
// Live CDP check for #1858 (Session read and send tools). A fake omp replays `host_tool_call` frames from a scratch
// file for the three Session tools and records each `host_tool_result`, so every proof is on the wire the real omp
// uses: list (with and without archived), status (idle, stopped), send (sent, session_not_running, invalid_target),
// no approval card and no toast, then the target's user turn with its "From Session <name>" line and the link back.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1858_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1858.mjs

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1858_SHOTS_DIR || path.join(tmpdir(), 'refract-1858-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const MESSAGE = 'Please summarise the build status for me.';
const findings = [];
const failures = [];
const shots = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));

const sessionRow = (id) => `document.querySelector('[data-session-open=${JSON.stringify(id)}]')`;
const approveButtons = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`;

async function main() {
  const dirs = [];
  let child, targetPid, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  try {
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1858-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1858');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1858: git HEAD ${gitHeadSha}; shots ${SHOTS_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1858' });
    exeHash = built.hash;
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session-tools-1858',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
        REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${targetPid}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });

    const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
    const call = async (toolName, args, pid) => {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args, __pid: pid })}\n`);
      return { id, ...(await resultFor(id)) };
    };
    const toasts = () => cdp.evaluate(`document.querySelectorAll('[data-sonner-toast]').length`);
    const shot = async (name) => {
      await cdp.screenshot(path.join(SHOTS_DIR, name));
      shots.push({ name, sha256: createHash('sha256').update(readFileSync(path.join(SHOTS_DIR, name))).digest('hex') });
    };
    const pidAfter = async (known) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !known.includes(r.pid));
        if (hit) return hit.pid;
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    };

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    const pidA = await pidAfter([]);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
    await pidAfter([pidA]);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionC = await latestSessionIdAndName(cdp, repoName, [sessionA.id, sessionB.id]);
    for (const s of [sessionA, sessionB, sessionC]) await waitForSessionStatus(cdp, s.id, 'idle');
    const stopped = await cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(sessionC.id)})`);
    if (!stopped?.ok) throw new Error(`stopAgent(C) failed: ${JSON.stringify(stopped)}`);
    await waitForSessionStatus(cdp, sessionC.id, 'stopped');
    // Calls come from Session A, so its pane is the one a (wrongly raised) approval card would appear in.
    await cdp.click(sessionRow(sessionA.id));
    await cdp.waitFor(`${sessionRow(sessionA.id)}?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: 'Session A open' });

    const names = JSON.stringify(Object.fromEntries([sessionA, sessionB, sessionC].map((s) => [s.id, s.name])));
    const toastsBefore = await toasts();

    const listed = await call('refract_list_sessions', {}, pidA);
    const rows = listed.body.sessions ?? [];
    const rowA = rows.find((r) => r.id === sessionA.id);
    check(
      !listed.isError && rows.length === 3 && rowA?.self === true && rows.filter((r) => r.self).length === 1 && rows.every((r) => !r.archived),
      `list_sessions returned the 3 Sessions, only Session A marked self; names ${names}.`,
      `list_sessions: ${JSON.stringify(listed)}`
    );

    const idle = await call('refract_get_session_status', { id: sessionB.id }, pidA);
    check(!idle.isError && idle.body.status === 'idle' && idle.body.stopReason === undefined, 'get_session_status for Session B reports idle with no stopReason.', `status B: ${JSON.stringify(idle)}`);
    const stoppedStatus = await call('refract_get_session_status', { id: sessionC.id }, pidA);
    check(
      !stoppedStatus.isError && stoppedStatus.body.status === 'stopped' && stoppedStatus.body.stopReason === 'stopped-on-request',
      'get_session_status for Session C reports stopped / stopped-on-request.',
      `status C: ${JSON.stringify(stoppedStatus)}`
    );

    const sent = await call('refract_send_session_message', { id: sessionB.id, text: MESSAGE }, pidA);
    check(!sent.isError && sent.body.outcome === 'sent', 'send_session_message to idle Session B returned outcome "sent".', `send B: ${JSON.stringify(sent)}`);
    const notRunning = await call('refract_send_session_message', { id: sessionC.id, text: MESSAGE }, pidA);
    check(notRunning.isError && notRunning.body.error?.code === 'session_not_running', 'send to stopped Session C returned session_not_running.', `send C: ${JSON.stringify(notRunning)}`);
    const self = await call('refract_send_session_message', { id: sessionA.id, text: MESSAGE }, pidA);
    check(self.isError && self.body.error?.code === 'invalid_target', 'send to Session A itself returned invalid_target.', `send self: ${JSON.stringify(self)}`);

    await sleep(1000);
    check((await cdp.evaluate(approveButtons)) === 0, 'No approval card appeared in Session A for any of the calls.', 'an approval card appeared during the Session tool calls');
    check((await toasts()) === toastsBefore, 'The error results raised no toast.', `toasts ${toastsBefore} -> ${await toasts()}`);
    const stoppedAfter = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionC.id)})?.status)`);
    check(stoppedAfter === 'stopped', 'The refused send did not start stopped Session C.', `Session C status after refused send: ${stoppedAfter}`);

    // The target's turn: muted "From Session" line, the sender's name as a real button, the envelope not shown raw.
    await cdp.click(sessionRow(sessionB.id));
    const tag = `Array.from(document.querySelectorAll('[data-slot="source-tag"]')).find((el) => el.textContent.includes('From Session'))`;
    await cdp.waitFor(`!!(${tag})`, { timeoutMs: 20_000, label: 'From Session line in Session B' });
    const tagInfo = await cdp.evaluate(`(() => { const el = ${tag}; const b = el.querySelector('button'); return { text: el.textContent, button: b?.textContent ?? null, bodyHasEnvelope: document.body.innerText.includes('<session-message'), bodyHasText: document.body.innerText.includes(${JSON.stringify(MESSAGE)}) }; })()`);
    check(
      tagInfo.text.startsWith('From Session') && tagInfo.button === sessionA.name && !tagInfo.bodyHasEnvelope && tagInfo.bodyHasText,
      `Session B shows "From Session ${sessionA.name}" over the plain message, with no raw envelope.`,
      `source line: ${JSON.stringify(tagInfo)}`
    );
    check((await cdp.evaluate(approveButtons)) === 0, 'No approval card in Session B either.', 'an approval card appeared in Session B');
    await shot('01-target-user-turn-from-session.png');

    await cdp.click(`Array.from(${tag}.querySelectorAll('button')).find((b) => b.textContent === ${JSON.stringify(sessionA.name)})`);
    await cdp.waitFor(`${sessionRow(sessionA.id)}?.getAttribute('aria-current') === 'true' && ${sessionRow(sessionB.id)}?.getAttribute('aria-current') !== 'true'`, { timeoutMs: 10_000, label: 'sender Session opened' });
    check(true, `Clicking "${sessionA.name}" opened the sender Session A.`, '');
    await shot('02-sender-session-opened.png');

    // Archived Sessions appear only on request.
    const archived = await cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(sessionC.id)})`);
    if (!archived?.ok) throw new Error(`archive(C) failed: ${JSON.stringify(archived)}`);
    const without = await call('refract_list_sessions', {}, pidA);
    const withArchived = await call('refract_list_sessions', { include_archived: true }, pidA);
    const archivedRow = (withArchived.body.sessions ?? []).find((r) => r.id === sessionC.id);
    check(
      !without.isError && without.body.sessions.length === 2 && !without.body.sessions.some((r) => r.id === sessionC.id),
      'list_sessions without include_archived leaves out archived Session C.',
      `list default after archive: ${JSON.stringify(without)}`
    );
    check(
      !withArchived.isError && withArchived.body.sessions.length === 3 && archivedRow?.archived === true,
      'list_sessions with include_archived returns Session C with archived: true.',
      `list include_archived: ${JSON.stringify(withArchived)}`
    );

    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, shots, findings, failures, verdict }, null, 2));
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1858: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1858: FAILED:', err?.stack ?? err);
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err) }, null, 2));
    } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const name of ['app.log', 'fake-omp-invocations.log', 'host-tools.jsonl', 'host-calls.jsonl']) if (exeDir && existsSync(path.join(exeDir, name))) copyFileSync(path.join(exeDir, name), path.join(SHOTS_DIR, name));
    } catch {}
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main();
