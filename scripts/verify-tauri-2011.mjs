#!/usr/bin/env node
// Live CDP check for #2011 (Checklist store, T025). A fake omp replays `host_tool_call` frames for `refract_checklist`
// and records each `host_tool_result`; the developer side goes through `window.refract.checklist`. Proves, on the wire:
// create (owner human), update, get, a developer tick with its `checklist:update` event (by developer, whole
// checklist), the file on disk, a restart on the same data dir that keeps it, and Session delete removing the file.
// Usage: REFRACT_2011_ROOT=<task folder> REFRACT_2011_EXE=<private exe copy> node scripts/verify-tauri-2011.mjs

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.REFRACT_2011_ROOT;
const EXE = process.env.REFRACT_2011_EXE;
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_2011_ROOT and REFRACT_2011_EXE');
const EVIDENCE = path.join(ROOT, 'evidence');
for (const d of ['data', 'webview2', 'import', 'shim', 'launcher', 'repo', 'fake']) mkdirSync(path.join(ROOT, d), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const transcript = [];
const failures = [];
const log = (step, value) => transcript.push({ step, value });
const check = (ok, what, detail) => {
  log(`${ok ? 'PASS' : 'FAIL'}: ${what}`, detail);
  if (!ok) failures.push(`${what}: ${JSON.stringify(detail)}`);
};

async function launch(extraEnv, shimDir, launcherExe, dataDir, importDir, tag) {
  const port = await getFreePort();
  const launched = await launchBuiltExeWithEnv(launcherExe, EXE, {
    port,
    dataDir,
    importSourceDir: importDir,
    pathPrepend: shimDir,
    logFile: path.join(ROOT, `app-${tag}.log`),
    extraEnv
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
  await cdp.waitFor(`!!window.refract?.checklist`, { timeoutMs: 30_000, label: 'bridge mounted' });
  return { ...launched, cdp, port };
}

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const importDir = path.join(ROOT, 'import');
  const shimDir = path.join(ROOT, 'shim');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  writeFileSync(recordFile, '');
  writeFileSync(callsFile, '');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-2011');
  const repoName = path.basename(repoDir);
  buildOmpShim(shimDir);
  const launcherExe = buildLauncher(path.join(ROOT, 'launcher'));
  const env = {
    REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
    REFRACT_FAKE_OMP_NODE: process.execPath,
    REFRACT_FAKE_OMP_SCENARIO: 'session-tools-1858',
    REFRACT_FAKE_OMP_DEBUG_LOG: path.join(ROOT, 'fake', 'invocations.log'),
    REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
    REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile
  };
  log('provenance', { gitHead: gitHead(REPO_ROOT), exe: EXE, exeSha256: sha256OfFile(EXE), dataDir });

  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  const call = async (args, pid) => {
    const id = `hc-${++n}`;
    appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName: 'refract_checklist', arguments: args, __pid: pid })}\n`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
      if (hit) {
        const out = { id, isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        log(`tool ${args.action}`, { args, result: out });
        return out;
      }
      await sleep(150);
    }
    throw new Error(`no host_tool_result for ${id} within 20s`);
  };

  let first, second;
  try {
    first = await launch(env, shimDir, launcherExe, dataDir, importDir, 'first');
    const cdp = first.cdp;
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const session = await latestSessionIdAndName(cdp, repoName, []);
    await waitForSessionStatus(cdp, session.id, 'idle');
    const sessions = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`);
    check(sessions.length === 1 && sessions[0] === session.id, 'scratch data dir holds exactly the one Session this run created', sessions);
    const pid = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools');
        if (hit) return hit.pid;
        await sleep(200);
      }
      throw new Error('omp never registered host tools');
    })();
    const filePath = path.join(dataDir, 'checklists', `${session.id}.json`);
    check(!existsSync(filePath), 'no checklist file before the first create', filePath);

    await cdp.evaluate(`window.__cl = []; window.__unsub = window.refract.checklist.onUpdate((p) => window.__cl.push(p)); 1`);
    const events = () => cdp.evaluate(`window.__cl`);
    const get = () => cdp.evaluate(`window.refract.checklist.get(${JSON.stringify(session.id)})`);

    const created = await call(
      { action: 'create', requestId: 'live-create-1', title: 'Live check', items: [{ text: 'Agent step' }, { text: 'Ship it by hand', owner: 'human' }] },
      pid
    );
    const addedIds = created.body.addedIds ?? created.body.createdIds ?? created.body.ids;
    check(!created.isError && created.body.state === 'active' && created.body.itemCount === 2 && Array.isArray(addedIds) && addedIds.length === 2, 'agent create returned 2 item ids, state active', created.body);
    const [agentItem, humanItem] = addedIds;
    const afterCreate = (await get()).value;
    const humanRow = afterCreate?.items.find((i) => i.id === humanItem);
    check(afterCreate?.id === created.body.checklistId && humanRow?.owner === 'human' && afterCreate.items.find((i) => i.id === agentItem)?.owner === 'agent', 'owner human kept on the created item, default agent on the other', afterCreate?.items.map((i) => [i.id, i.owner]));
    check(existsSync(filePath), 'checklist file written on create', filePath);
    const createEvents = await events();
    check(createEvents.length === 1 && createEvents[0].by === 'agent' && createEvents[0].opened === true && createEvents[0].sessionId === session.id && createEvents[0].checklist.items.length === 2, 'checklist:update after create: by agent, opened, whole checklist', createEvents.map((e) => ({ by: e.by, opened: e.opened, rev: e.checklist.rev })));

    const updated = await call(
      { action: 'update', baseRev: created.body.seenRev, requestId: 'live-update-1', ops: [{ op: 'add', item: { text: 'Added by agent', owner: 'either' } }, { op: 'setStatus', id: agentItem, status: 'in_progress' }] },
      pid
    );
    check(!updated.isError && updated.body.rev > created.body.rev && updated.body.itemCount === 3, 'agent update applied: rev advanced, 3 items', { rev: updated.body.rev, itemCount: updated.body.itemCount });
    const got = await call({ action: 'get', full: true }, pid);
    const gotItems = got.body.items ?? [];
    check(!got.isError && got.body.rev === updated.body.rev && gotItems.length === 3 && gotItems.find((i) => i.id === agentItem)?.status === 'in_progress' && gotItems.find((i) => i.id === humanItem)?.owner === 'human', 'agent get returns rev, 3 items, in_progress and owner human', { rev: got.body.rev, items: gotItems.map((i) => [i.id, i.status, i.owner]) });

    const before = (await events()).length;
    const tick = await cdp.evaluate(`window.refract.checklist.mutate(${JSON.stringify(session.id)}, ${JSON.stringify(created.body.checklistId)}, ${got.body.rev}, 'live-tick-1', { op: 'setStatus', id: ${JSON.stringify(humanItem)}, status: 'complete' })`);
    check(tick.ok === true && tick.value.items.find((i) => i.id === humanItem)?.status === 'complete' && tick.value.items.find((i) => i.id === humanItem)?.completedBy === 'developer', 'developer tick returned the checklist with the item complete, completedBy developer', tick.ok ? tick.value.items.map((i) => [i.id, i.status, i.completedBy]) : tick);
    await cdp.waitFor(`window.__cl.length > ${before}`, { timeoutMs: 10_000, label: 'checklist:update after tick' });
    const tickEvent = (await events())[before];
    check(tickEvent.by === 'developer' && tickEvent.sessionId === session.id && tickEvent.checklist.items.length === 3 && tickEvent.checklist.rev === tick.value.rev && tickEvent.checklist.items.find((i) => i.id === humanItem)?.status === 'complete' && tickEvent.opened === undefined, 'checklist:update by developer carries the whole checklist at the new rev', { by: tickEvent.by, rev: tickEvent.checklist.rev, items: tickEvent.checklist.items.length });
    const stale = await cdp.evaluate(`window.refract.checklist.mutate(${JSON.stringify(session.id)}, 'ck-bogus', 0, null, { op: 'setStatus', id: ${JSON.stringify(agentItem)}, status: 'complete' })`);
    check(stale.ok === true && stale.value?.error?.code === 'invalid_input' && stale.value.checklist?.rev === tick.value.rev, 'a mutate against a wrong checklist id is refused (invalid_input) and the live checklist stays at the tick rev', { code: stale.value?.error?.code, rev: stale.value?.checklist?.rev });
    writeFileSync(path.join(EVIDENCE, 'events-first-run.json'), JSON.stringify(await events(), null, 2));
    const fileBefore = JSON.parse(readFileSync(filePath, 'utf8'));
    check(fileBefore.version === 1 && fileBefore.active?.rev === tick.value.rev && fileBefore.active.items.length === 3, 'file on disk matches the live checklist rev and item count', { version: fileBefore.version, rev: fileBefore.active?.rev });
    writeFileSync(path.join(EVIDENCE, 'checklist-file-before-restart.json'), JSON.stringify(fileBefore, null, 2));
    log('files', { checklists: readdirSync(path.join(dataDir, 'checklists')) });

    cdp.close();
    await stopLauncher(first.child).catch(() => {});
    first = null;
    await sleep(2000);

    second = await launch(env, shimDir, launcherExe, dataDir, importDir, 'second');
    const cdp2 = second.cdp;
    await cdp2.waitFor(`!!document.querySelector('[data-session-open=${JSON.stringify(session.id)}]')`, { timeoutMs: 60_000, label: 'Session row after restart' });
    const reloaded = (await cdp2.evaluate(`window.refract.checklist.get(${JSON.stringify(session.id)})`));
    check(reloaded.ok === true && reloaded.value?.id === created.body.checklistId && reloaded.value.rev === tick.value.rev && reloaded.value.items.find((i) => i.id === humanItem)?.status === 'complete' && reloaded.value.items.length === 3, 'after restart on the same data dir the checklist persists (id, rev, tick)', reloaded.ok ? { id: reloaded.value?.id, rev: reloaded.value?.rev, items: reloaded.value?.items.map((i) => [i.id, i.status]) } : reloaded);
    const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
    check(canon(reloaded.value) === canon(fileBefore.active), 'reloaded checklist deep-equals the active checklist in the file written before the restart (keys sorted)', null);
    check(existsSync(filePath), 'file still at <data>/checklists/<sessionId>.json after restart', filePath);
    writeFileSync(path.join(EVIDENCE, 'checklist-after-restart.json'), JSON.stringify(reloaded.value, null, 2));

    const del = await cdp2.evaluate(`window.refract.sessions.delete(${JSON.stringify(session.id)}, { confirmed: true })`);
    check(del.ok === true, 'sessions.delete accepted', del);
    const deadline = Date.now() + 60_000;
    while (existsSync(filePath) && Date.now() < deadline) await sleep(300);
    check(!existsSync(filePath), 'checklist file is gone after the Session delete', { filePath, remaining: existsSync(path.join(dataDir, 'checklists')) ? readdirSync(path.join(dataDir, 'checklists')) : 'no dir' });
    const afterDelete = await cdp2.evaluate(`window.refract.checklist.get(${JSON.stringify(session.id)})`);
    check(afterDelete.ok === false || afterDelete.value === null, 'checklist.get for the deleted Session no longer returns a checklist', afterDelete);
    cdp2.close();
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
    log('exception', String(err?.stack ?? err));
  } finally {
    for (const r of [first, second]) {
      if (r?.child) await stopLauncher(r.child).catch(() => {});
    }
    const verdict = failures.length ? 'FAILED' : 'PASSED';
    writeFileSync(path.join(EVIDENCE, 'transcript.json'), JSON.stringify({ verdict, failures, transcript }, null, 2));
    writeFileSync(path.join(EVIDENCE, 'host-tools.jsonl'), readFileSync(recordFile));
    console.log(transcript.map((t) => `${t.step}${t.value === null ? '' : ` :: ${JSON.stringify(t.value)}`}`).join('\n'));
    console.log(`\nverify-2011: ${verdict}`);
    process.exitCode = failures.length ? 1 : 0;
  }
}

main();
