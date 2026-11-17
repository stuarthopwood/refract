#!/usr/bin/env node
// Live CDP check for #1860 (agents archive, unarchive, stop, pause, resume and delete Sessions). A fake omp replays
// `host_tool_call` frames for the six end tools and records each `host_tool_result`, so every proof is on the wire the
// real omp uses: cards and their Approve/Deny, the one-card archive cascade, the unarchive child gate, stop and
// pause/resume states, the delete card in yolo with re-rooting and the background removal, the refusals, and no toast.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1860_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1860.mjs

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1860_SHOTS_DIR || path.join(tmpdir(), 'refract-1860-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const SIX = ['refract_archive_session', 'refract_unarchive_session', 'refract_stop_session', 'refract_pause_session', 'refract_resume_session', 'refract_delete_session'];
const findings = [];
const failures = [];
const shots = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));

const sessionRow = (id) => `document.querySelector('[data-session-open=${JSON.stringify(id)}]')`;
const approveCount = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`;
const code = (r) => r.body?.error?.code;
// The card text comes from the element around the Approve button, so words elsewhere on the page cannot satisfy a check.
const approvalCards = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').map((el) => el.closest('[data-slot="card"]')).filter(Boolean)`;
const headline = (s) => `${s.id.slice(0, 8)} ${s.name}`;
const inOrder = (text, parts) => {
  let at = 0;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
};

async function main() {
  const dirs = [];
  let child, targetPid, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  const registryDumps = {};
  try {
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1860-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1860');
    const repoDirQ = makeScratchRepo(mk('repoq'), 'verify-1860q');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const repoNameQ = path.basename(repoDirQ);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1860: git HEAD ${gitHeadSha} dirty=${dirty}; shots ${SHOTS_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1860' });
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
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        await sleep(150);
      }
      throw new Error(`no host_tool_result for ${id} within 30s`);
    };
    let n = 0;
    const post = (toolName, args, pid) => {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args, __pid: pid })}\n`);
      return id;
    };
    const toastLog = () => cdp.evaluate(`window.__toastLog.slice()`);
    // Watches insertions, so a toast shown and dismissed between two checks is still caught; a probe node proves the watcher can see one.
    const watchToasts = async () => {
      await cdp.evaluate(`(() => { window.__toastLog = []; const note = (node) => { if (node.nodeType !== 1) return; const hits = node.matches('[data-sonner-toast]') ? [node] : Array.from(node.querySelectorAll('[data-sonner-toast]')); for (const t of hits) window.__toastLog.push({ type: t.getAttribute('data-type'), text: (t.textContent ?? '').slice(0, 160) }); }; new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach(note); }).observe(document.body, { childList: true, subtree: true }); return true; })()`);
      await cdp.evaluate(`(() => { const probe = document.createElement('li'); probe.setAttribute('data-sonner-toast', ''); probe.setAttribute('data-type', 'probe'); document.body.appendChild(probe); return true; })()`);
      await sleep(200);
      const seen = (await toastLog()).some((t) => t.type === 'probe');
      await cdp.evaluate(`(() => { document.querySelector('[data-type="probe"]')?.remove(); window.__toastLog.length = 0; return true; })()`);
      return seen;
    };
    const noNewToast = async (mark, what) => {
      await sleep(400);
      const fresh = (await toastLog()).slice(mark);
      check(fresh.length === 0, `${what} raised no toast.`, `${what} raised toasts: ${JSON.stringify(fresh)}`);
    };
    const readCard = () => cdp.evaluate(`(() => { const cards = ${approvalCards}; return { count: cards.length, text: (cards[0]?.innerText ?? '').replace(/\\s+/g, ' ').trim() }; })()`);
    const shot = async (name) => {
      await cdp.screenshot(path.join(SHOTS_DIR, name));
      shots.push({ name, sha256: createHash('sha256').update(readFileSync(path.join(SHOTS_DIR, name))).digest('hex') });
    };
    const knownPids = [];
    const pidAfter = async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !knownPids.includes(r.pid));
        if (hit) return (knownPids.push(hit.pid), hit.pid);
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    };
    const listRow = (id) => cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.find((s) => s.id === ${JSON.stringify(id)}) ?? null : null))`);
    const openSession = async (id) => {
      // The list pane is short, so a row can sit below the clipped edge where a coordinate click misses it.
      await cdp.waitFor(`!!${sessionRow(id)}`, { timeoutMs: 10_000, label: `row ${id} mounted` });
      await cdp.evaluate(`${sessionRow(id)}.scrollIntoView({ block: 'center' })`);
      await sleep(200);
      await cdp.click(sessionRow(id));
      await cdp.waitFor(`${sessionRow(id)}?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: `Session ${id} open` });
      await sleep(300);
    };
    const waitCard = async () => {
      try {
        await cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: 'approval card' });
      } catch (err) {
        await shot('zz-no-card-failure.png').catch(() => {});
        throw err;
      }
    };
    // A call from `caller` that raises a card in the caller's pane; `onCard(text, count)` sees the card before `answer` is clicked.
    const withCard = async (caller, tool, args, answer, onCard) => {
      await openSession(caller.id);
      const id = post(tool, args, caller.pid);
      await waitCard();
      await sleep(300);
      const card = await readCard();
      if (onCard) await onCard(card.text, card.count);
      await cdp.clickByText(answer);
      return { id, cardText: card.text, ...(await resultFor(id)) };
    };
    // A call that must raise no card; the caller's pane is open so a card would be seen.
    const noCard = async (caller, tool, args) => {
      await openSession(caller.id);
      const id = post(tool, args, caller.pid);
      const res = await resultFor(id);
      await sleep(400);
      const cards = await cdp.evaluate(approveCount);
      return { id, ...res, cards };
    };
    const statusOf = async (caller, id) => (await noCard(caller, 'refract_get_session_status', { id })).body.status;
    const create = async (parent, args) => {
      const res = await withCard(parent, 'refract_create_session', args, 'Approve');
      const pid = await pidAfter();
      return { ...res.body, pid };
    };

    // ---- Project Q: a parent with four live children, for the unarchive gate.
    await addRepository(cdp, repoDirQ);
    await createSessionViaQuickCreate(cdp, repoNameQ);
    const q = await latestSessionIdAndName(cdp, repoNameQ, []);
    q.pid = await pidAfter();
    await waitForSessionStatus(cdp, q.id, 'idle');
    const qKids = [];
    for (const nm of ['q-one', 'q-two', 'q-three', 'q-four']) qKids.push(await create(q, { prompt: `Do ${nm}`, name: nm }));
    const archivedKid = await cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(qKids[3].id)})`);
    const fifth = await create(q, { prompt: 'Do q-five', name: 'q-five' });
    // A caller in Q but outside the full parent's tree, so only the 4-child limit can refuse.
    await createSessionViaQuickCreate(cdp, repoNameQ);
    const QD = await latestSessionIdAndName(cdp, repoNameQ, [q.id, ...qKids.map((k) => k.id), fifth.id]);
    QD.pid = await pidAfter();
    await waitForSessionStatus(cdp, QD.id, 'idle');

    // ---- Project 1: A (caller, ask) with child B and grandchild C; unrelated D; Y (yolo caller) added later.
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const A = await latestSessionIdAndName(cdp, repoName, []);
    A.pid = await pidAfter();
    await waitForSessionStatus(cdp, A.id, 'idle');
    await createSessionViaQuickCreate(cdp, repoName);
    const D = await latestSessionIdAndName(cdp, repoName, [A.id]);
    D.pid = await pidAfter();
    await waitForSessionStatus(cdp, D.id, 'idle');
    const bRes = await create(A, { prompt: 'Do task B', name: 'child-b' });
    const B = { id: bRes.id, name: 'child-b', pid: bRes.pid };
    const cRes = await create(B, { prompt: 'Do task C', name: 'child-c' });
    const C = { id: cRes.id, name: 'child-c', pid: cRes.pid };
    check(bRes.parentId === A.id && cRes.parentId === B.id, 'Seed: B is a child of A and C a child of B.', `seed parents: ${JSON.stringify({ bRes, cRes })}`);
    const settingsSet = await cdp.evaluate(`window.refract.settings.setApprovalMode('auto')`);
    if (!settingsSet?.ok) throw new Error(`setApprovalMode(auto) failed: ${JSON.stringify(settingsSet)}`);
    await createSessionViaQuickCreate(cdp, repoName);
    const Y = await latestSessionIdAndName(cdp, repoName, [A.id, B.id, C.id, D.id]);
    Y.pid = await pidAfter();
    await waitForSessionStatus(cdp, Y.id, 'idle');
    await createSessionViaQuickCreate(cdp, repoName);
    const E = await latestSessionIdAndName(cdp, repoName, [A.id, B.id, C.id, D.id, Y.id]);
    E.pid = await pidAfter();
    await waitForSessionStatus(cdp, E.id, 'idle');
    const personalRes = await cdp.evaluate(`window.refract.sessions.openPersonalAgent()`);
    if (!personalRes?.ok) throw new Error(`openPersonalAgent failed: ${JSON.stringify(personalRes)}`);
    const P = { id: personalRes.value.id };
    // B stays `working` while it holds the open create call; only the leaf must settle.
    await waitForSessionStatus(cdp, C.id, 'idle');
    const watching = await watchToasts();
    check(watching, 'The toast watcher saw a probe toast node, so a clean log means no toast was inserted.', 'the toast watcher did not see a probe toast node');
    registryDumps.before = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => ({ id: s.id, name: s.name, parent: s.parentSessionId ?? null, archivedAt: s.archivedAt, kind: s.kind })))`);

    // ---- e. Self, ancestor and Personal Agent refusal: six tools each, no card.
    let refusals = 0;
    let refusalBad = [];
    for (const [caller, targets] of [[C, [C, B, A, P]], [A, [A]]]) {
      for (const target of targets) {
        for (const tool of SIX) {
          const r = await noCard(caller, tool, { id: target.id });
          refusals += 1;
          if (!(r.isError && code(r) === 'invalid_target' && r.cards === 0)) refusalBad.push({ caller: caller.name, tool, target: target.id, r });
        }
      }
    }
    check(refusalBad.length === 0, `${refusals} calls (six tools on self, ancestors B and A, and the Personal Agent) all returned invalid_target with no card.`, `refusals not invalid_target: ${JSON.stringify(refusalBad)}`);
    const unknown = await noCard(A, 'refract_stop_session', { id: 'no-such-session' });
    check(unknown.isError && code(unknown) === 'not_found', 'An unknown id returned not_found.', `unknown id: ${JSON.stringify(unknown)}`);

    // ---- a. Archive a child: card, approve sets archivedAt; deny changes nothing.
    const arch = await withCard(A, 'refract_archive_session', { id: C.id }, 'Approve', async (text, count) => {
      check(count === 1 && inOrder(text, [`Archive Session ${headline(C)}`, 'Below the calling Session', `Child of ${B.name}`]), `The archive card is titled "Archive Session ${headline(C)}" and shows "Below the calling Session" then "Child of ${B.name}".`, `archive card (${count} cards): ${text.slice(0, 400)}`);
      await shot('01-archive-card.png');
    });
    const rowC = await listRow(C.id);
    check(!arch.isError && arch.body.outcome === 'archived' && !!rowC?.archivedAt, 'archive_session on child C raised a card; after Approve archivedAt is set.', `archive C: ${JSON.stringify(arch.body)} row ${JSON.stringify(rowC)}`);
    const denyMark = (await toastLog()).length;
    const denied = await withCard(A, 'refract_archive_session', { id: B.id }, 'Deny');
    const rowB = await listRow(B.id);
    check(denied.isError && code(denied) === 'denied' && !rowB?.archivedAt, 'Deny on the archive card returned the denied error and B stayed live.', `deny: ${JSON.stringify(denied.body)} row ${JSON.stringify(rowB)}`);
    await noNewToast(denyMark, 'The denied archive');

    // ---- b. Unarchive a descendant: no card. The child-limit gate runs in Project Q.
    const unarch = await noCard(A, 'refract_unarchive_session', { id: C.id });
    const rowC2 = await listRow(C.id);
    check(!unarch.isError && unarch.cards === 0 && !rowC2?.archivedAt, 'unarchive_session on descendant C raised no card and restored it.', `unarchive C: ${JSON.stringify(unarch)} row ${JSON.stringify(rowC2)}`);
    const gate = await noCard(q, 'refract_unarchive_session', { id: qKids[3].id });
    check(archivedKid?.ok && gate.isError && code(gate) === 'child_limit', 'unarchive with 4 live children under the parent returned child_limit.', `gate: ${JSON.stringify(gate)} archive ${JSON.stringify(archivedKid)}`);
    const gateOutside = await noCard(QD, 'refract_unarchive_session', { id: qKids[3].id });
    check(gateOutside.isError && code(gateOutside) === 'child_limit' && gateOutside.cards === 0, 'From outside the parent tree, unarchive into a full parent returned child_limit with no approval card.', `gate outside: ${JSON.stringify(gateOutside)}`);
    const freed = await cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(fifth.id)})`);
    const ok4 = await noCard(q, 'refract_unarchive_session', { id: qKids[3].id });
    const row5 = await listRow(fifth.id);
    check(freed?.ok && !ok4.isError && !(await listRow(qKids[3].id))?.archivedAt && !!row5?.archivedAt, 'After one child was archived, unarchive succeeded and restored only the named Session.', `unarchive after free: ${JSON.stringify(ok4)} fifth ${JSON.stringify(row5)}`);

    // ---- c. Pause, resume, stop.
    // B holds an open create call, so it is `working`: pause reports `pausing` and the status stays `working`.
    const pauseB = await noCard(A, 'refract_pause_session', { id: B.id });
    const pausedPhase = (await listRow(B.id))?.pause;
    check(!pauseB.isError && pauseB.cards === 0 && ['pausing', 'paused'].includes(pausedPhase), 'pause_session on running descendant B raised no card; its pause state reads pausing.', `pause B: ${JSON.stringify(pauseB)} pause ${pausedPhase}`);
    const pauseAgain = await noCard(A, 'refract_pause_session', { id: B.id });
    check(pauseAgain.isError && code(pauseAgain) === 'invalid_state', 'Pause again returned invalid_state.', `pause again: ${JSON.stringify(pauseAgain)}`);
    const resumeB = await noCard(A, 'refract_resume_session', { id: B.id });
    const resumedPhase = (await listRow(B.id))?.pause ?? null;
    check(!resumeB.isError && resumeB.cards === 0 && resumedPhase === null, 'resume_session on B raised no card; B is no longer paused.', `resume B: ${JSON.stringify(resumeB)} pause ${resumedPhase}`);
    // E is a live idle root outside A's tree: stop asks everywhere.
    const stopE = await withCard(A, 'refract_stop_session', { id: E.id }, 'Approve');
    await waitForSessionStatus(cdp, E.id, 'stopped');
    check(!stopE.isError && stopE.body.outcome === 'stopped', 'stop_session on running Session E raised a card; after Approve E is stopped.', `stop E: ${JSON.stringify(stopE)}`);
    const stopAgain = await noCard(A, 'refract_stop_session', { id: E.id });
    check(stopAgain.isError && code(stopAgain) === 'session_not_running' && stopAgain.cards === 0, 'Stop on a stopped Session returned session_not_running with no card.', `stop again: ${JSON.stringify(stopAgain)}`);
    const pidsBefore = new Set(records().filter((r) => r.frame.type === 'set_host_tools').map((r) => r.pid)).size;
    const resumeStopped = await noCard(A, 'refract_resume_session', { id: E.id });
    await sleep(1500);
    const pidsAfter = new Set(records().filter((r) => r.frame.type === 'set_host_tools').map((r) => r.pid)).size;
    check(resumeStopped.isError && code(resumeStopped) === 'session_not_running' && pidsAfter === pidsBefore && (await listRow(E.id))?.status === 'stopped', `resume on stopped E returned session_not_running and did not start it (omp processes ${pidsBefore} -> ${pidsAfter}).`, `resume stopped: ${JSON.stringify(resumeStopped)} pids ${pidsBefore}->${pidsAfter}`);

    // ---- f. Outside the caller's tree: pause raises a card; yolo skips it.
    const pauseD = await withCard(B, 'refract_pause_session', { id: D.id }, 'Approve');
    check(!pauseD.isError && (await statusOf(A, D.id)) === 'paused', 'pause_session by B on unrelated D raised a card; after Approve D is paused.', `pause D: ${JSON.stringify(pauseD)}`);
    const yoloResume = await noCard(Y, 'refract_resume_session', { id: D.id });
    check(!yoloResume.isError && yoloResume.cards === 0, 'In yolo, resume of D (outside the tree) raised no card.', `yolo resume: ${JSON.stringify(yoloResume)}`);
    const yoloPause = await noCard(Y, 'refract_pause_session', { id: D.id });
    check(!yoloPause.isError && yoloPause.cards === 0 && (await statusOf(A, D.id)) === 'paused', 'In yolo, pause of D (outside the tree) raised no card and D is paused.', `yolo pause: ${JSON.stringify(yoloPause)}`);
    const yoloResume2 = await noCard(Y, 'refract_resume_session', { id: D.id });
    check(!yoloResume2.isError && yoloResume2.cards === 0, 'D was resumed again in yolo, no card.', `yolo resume 2: ${JSON.stringify(yoloResume2)}`);

    // ---- a. Archive cascade: one card listing the target and every descendant.
    await sleep(500);
    const cascadeMark = (await toastLog()).length;
    const cascadeDeny = await withCard(D, 'refract_archive_session', { id: A.id, include_children: true }, 'Deny', async (text, count) => {
      const heads = [A, B, C].map((s) => `${headline(s)} (Outside this Session's tree)`);
      check(count === 1 && inOrder(text, ['Archive 3 Sessions', ...heads]), `ONE card titled "Archive 3 Sessions" lists all three Sessions, each ending "(Outside this Session's tree)" since caller D is not above them (${heads.join(', ')}).`, `cascade card (${count} cards): ${text.slice(0, 600)}`);
      await shot('02-archive-cascade-card.png');
    });
    const afterDeny = await Promise.all([A, B, C].map((s) => listRow(s.id)));
    check(cascadeDeny.isError && code(cascadeDeny) === 'denied' && afterDeny.every((r) => !r?.archivedAt), 'Deny on the cascade card returned the denied error and changed nothing: all three Sessions stay live.', `cascade deny: ${JSON.stringify(cascadeDeny.body)} rows ${JSON.stringify(afterDeny)}`);
    await noNewToast(cascadeMark, 'The denied cascade');
    const cascade = await withCard(D, 'refract_archive_session', { id: A.id, include_children: true }, 'Approve');
    const afterApprove = await Promise.all([A, B, C].map((s) => listRow(s.id)));
    check(!cascade.isError && cascade.body.ids?.length === 3 && afterApprove.every((r) => !!r?.archivedAt), 'After Approve the three Sessions are archived; the result lists their 3 ids.', `cascade: ${JSON.stringify(cascade.body)} rows ${JSON.stringify(afterApprove)}`);

    // ---- Restore the tree (yolo, no card), then d. delete in yolo.
    for (const s of [A, B, C]) {
      const r = await noCard(Y, 'refract_unarchive_session', { id: s.id });
      check(!r.isError && r.cards === 0, `Y unarchived ${s.name} with no card.`, `unarchive ${s.name}: ${JSON.stringify(r)}`);
    }
    const bBefore = await listRow(B.id);
    registryDumps.beforeDelete = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => ({ id: s.id, name: s.name, parent: s.parentSessionId ?? null, archivedAt: s.archivedAt })))`);
    await openSession(Y.id);
    const delId = post('refract_delete_session', { id: B.id }, Y.pid);
    await waitCard();
    await sleep(300);
    const delCard = await readCard();
    const delLines = [`Delete Session ${headline(B)}`, "Outside this Session's tree", `Child of ${A.name}`, 'Its worktree and Conversations are removed.', 'Live child Sessions become root Sessions.'];
    check(delCard.count === 1 && inOrder(delCard.text, delLines), `In yolo, delete_session by Y (outside B's tree) still raised ONE card titled "Delete Session ${headline(B)}" with the relationship, parent, removal and re-root lines in order.`, `delete card (${delCard.count} cards): ${delCard.text.slice(0, 600)}`);
    await shot('03-delete-card-yolo.png');
    await cdp.clickByText('Approve');
    // A stop racing the removal would depend on timing; the unit test `a_delete_already_in_flight_is_invalid_state` proves that code.
    const del = { id: delId, ...(await resultFor(delId)) };
    check(!del.isError && del.body.outcome === 'deleting', 'After Approve delete_session returned outcome "deleting".', `delete: ${JSON.stringify(del)}`);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && !r.value.some((s) => s.id === ${JSON.stringify(B.id)}))`, { timeoutMs: 60_000, label: 'B row removed' });
    const rowCAfter = await listRow(C.id);
    check(!existsSync(bBefore.worktreePath), `The background delete removed B's worktree (${bBefore.worktreePath}) and its row.`, `worktree still exists: ${bBefore.worktreePath}`);
    check(rowCAfter && !rowCAfter.parentSessionId, 'C, a live child of the deleted B, was re-rooted: its parent link is cleared.', `C after delete: ${JSON.stringify(rowCAfter)}`);
    registryDumps.afterDelete = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => ({ id: s.id, name: s.name, parent: s.parentSessionId ?? null, archivedAt: s.archivedAt })))`);
    await shot('04-after-delete.png');

    const gone = await noCard(Y, 'refract_stop_session', { id: B.id });
    check(gone.isError && code(gone) === 'not_found' && gone.cards === 0, 'A call on the deleted Session returned not_found with no card.', `after delete: ${JSON.stringify(gone)}`);
    const allToasts = await toastLog();
    check(allToasts.length === 0, 'No error result raised a toast: none was inserted from the first refusal to the end.', `toasts inserted: ${JSON.stringify(allToasts)}`);

    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, shots, findings, failures, registryDumps, verdict }, null, 2));
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1860: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1860: FAILED:', err?.stack ?? err);
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, findings, failures, registryDumps, error: String(err?.stack ?? err) }, null, 2));
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, 'zz-error.png')).catch(() => {});
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
