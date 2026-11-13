#!/usr/bin/env node
// Live CDP check for #1859 (agents create and nest Sessions). A fake omp replays `host_tool_call` frames for
// refract_create_session / refract_update_session and records each `host_tool_result`, so every proof is on the wire
// the real omp uses: create under the approval card, the 4th child and the 5th (`child_limit`), a depth-3 child and a
// depth-4 refusal (`depth_limit`), update inside the own tree without a card, update outside it with a card that is
// denied, the child's first turn naming its parent, the five Session tools at depth 3, and the delegation rule text.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1859_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1859.mjs

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
const SHOTS_DIR = process.env.REFRACT_1859_SHOTS_DIR || path.join(tmpdir(), 'refract-1859-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const FIVE_TOOLS = ['refract_list_sessions', 'refract_get_session_status', 'refract_send_session_message', 'refract_create_session', 'refract_update_session'];
const findings = [];
const failures = [];
const shots = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));

const sessionRow = (id) => `document.querySelector('[data-session-open=${JSON.stringify(id)}]')`;
const approveCount = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`;

async function main() {
  const dirs = [];
  let child, targetPid, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  try {
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1859-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1859');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1859: git HEAD ${gitHeadSha}; shots ${SHOTS_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1859' });
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
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
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
    const call = async (toolName, args, pid) => {
      const id = post(toolName, args, pid);
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
    const listRow = (id) => cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.find((s) => s.id === ${JSON.stringify(id)}) ?? null : null))`);
    const openSession = async (id) => {
      await cdp.click(sessionRow(id));
      await cdp.waitFor(`${sessionRow(id)}?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: `Session ${id} open` });
    };
    const waitCard = () => cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: 'approval card' });
    const resolveCard = async (label) => {
      await waitCard();
      await sleep(300);
      await cdp.clickByText(label);
    };
    const knownPids = [];
    const known = (pid) => (knownPids.push(pid), pid);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const root = await latestSessionIdAndName(cdp, repoName, []);
    const pidRoot = known(await pidAfter([]));
    await waitForSessionStatus(cdp, root.id, 'idle');
    await openSession(root.id);
    const toastsBefore = await toasts();

    // Create under the card: Approve makes the child, linked to the caller, with a first turn naming the parent.
    const create = async (args, pid, label = 'Approve') => {
      const id = post('refract_create_session', args, pid);
      if (label) await resolveCard(label);
      return { id, ...(await resultFor(id)) };
    };
    const children = [];
    for (const [i, nm] of ['child-one', 'child-two', 'child-three', 'child-four'].entries()) {
      const id = post('refract_create_session', { prompt: `Do task ${i + 1}`, name: nm }, pidRoot);
      await waitCard();
      if (i === 0) await shot('01-create-approval-card.png');
      await sleep(300);
      await cdp.clickByText('Approve');
      const res = { id, ...(await resultFor(id)) };
      const pid = known(await pidAfter(knownPids));
      const row = await listRow(res.body.id);
      children.push({ ...res.body, pid });
      check(
        !res.isError && res.body.name === nm && res.body.parentId === root.id && row?.parentSessionId === root.id && !!res.body.branch,
        `create #${i + 1} (${nm}) after Approve returned id ${res.body.id}, branch ${res.body.branch}, parentId = caller; the registry row carries parentSessionId.`,
        `create #${i + 1}: ${JSON.stringify(res)} row ${JSON.stringify(row)}`
      );
    }
    await shot('02-four-children-listed.png');
    const firstTurn = readFileSync(debugLog, 'utf8').split('\n').find((l) => l.includes('RECV') && l.includes('"type":"prompt"') && l.includes('Do task 1'));
    check(
      !!firstTurn && firstTurn.includes(`[Parent Session: \\"${root.name}\\" (id ${root.id}).`) && firstTurn.includes('refract_send_session_message'),
      `Child one's first prompt frame names the parent "${root.name}" (id ${root.id}) and says to report back with refract_send_session_message.`,
      `first turn line: ${firstTurn}`
    );

    // Past the limit: the 5th live child is a tool error before any card, and no toast.
    const fifth = await call('refract_create_session', { prompt: 'one too many' }, pidRoot);
    check(fifth.isError && fifth.body.error?.code === 'child_limit', 'The 5th child returned child_limit.', `5th child: ${JSON.stringify(fifth)}`);
    check((await cdp.evaluate(approveCount)) === 0, 'child_limit raised no approval card.', 'a card appeared for the refused 5th child');
    await shot('03-child-limit-no-card-no-toast.png');

    // Update inside the own tree: rename and un-nest and re-nest run with no card.
    const renamed = await call('refract_update_session', { id: children[3].id, name: 'renamed-four' }, pidRoot);
    const rowRenamed = await listRow(children[3].id);
    check(!renamed.isError && renamed.body.name === 'renamed-four' && rowRenamed?.name === 'renamed-four', 'Rename of an own-tree Session ran with no card and the list shows the new name.', `rename: ${JSON.stringify(renamed)} row ${JSON.stringify(rowRenamed)}`);
    // Un-nest the child just renamed; it is a Root afterwards, so a later nest of it is outside the own tree and is not tried here.
    const unnested = await call('refract_update_session', { id: children[3].id, parent_id: null }, pidRoot);
    const rowUnnested = await listRow(children[3].id);
    check(!unnested.isError && unnested.body.parentId === undefined && !rowUnnested?.parentSessionId, 'parent_id:null un-nested an own-tree Session with no card; the row has no parent.', `un-nest: ${JSON.stringify(unnested)} row ${JSON.stringify(rowUnnested)}`);
    check((await cdp.evaluate(approveCount)) === 0, 'No approval card appeared for any own-tree update.', 'a card appeared for an own-tree update');
    await shot('04-own-tree-updates-no-card.png');

    // Depth: a child (depth 2) creates a grandchild (depth 3); that grandchild gets the tools but cannot create (depth_limit).
    await openSession(children[0].id);
    const grand = await create({ prompt: 'Do the grandchild task', name: 'grandchild' }, children[0].pid);
    const pidGrand = known(await pidAfter(knownPids));
    check(!grand.isError && grand.body.parentId === children[0].id, 'A depth-2 child created a depth-3 grandchild under the card.', `grandchild: ${JSON.stringify(grand)}`);
    const grandTools = records().find((r) => r.pid === pidGrand && r.frame.type === 'set_host_tools')?.frame.tools.map((t) => t.name) ?? [];
    check(FIVE_TOOLS.every((t) => grandTools.includes(t)), 'The depth-3 Session registered all five Session tools.', `depth-3 tools: ${JSON.stringify(grandTools)}`);
    const tooDeep = await call('refract_create_session', { prompt: 'too deep' }, pidGrand);
    check(tooDeep.isError && tooDeep.body.error?.code === 'depth_limit', 'A depth-3 Session creating a child returned depth_limit.', `depth-4: ${JSON.stringify(tooDeep)}`);
    await shot('05-depth-limit.png');

    // Root, four children and the grandchild are six live Sessions: a seventh create, even from a Session with free child slots, is session_limit before any card.
    const seventh = await call('refract_create_session', { prompt: 'seventh' }, children[1].pid);
    check(seventh.isError && seventh.body.error?.code === 'session_limit', 'A 7th live Session create in the Project returned session_limit.', `7th: ${JSON.stringify(seventh)}`);
    check((await cdp.evaluate(approveCount)) === 0, 'session_limit raised no approval card.', 'a card appeared for the refused 7th Session');

    // Outside the own tree: child-two updating its sibling raises the card; Deny refuses and changes nothing.
    await openSession(children[1].id);
    const outsideId = post('refract_update_session', { id: children[2].id, name: 'hijacked' }, children[1].pid);
    await waitCard();
    await shot('06-outside-tree-card.png');
    await sleep(300);
    await cdp.clickByText('Deny');
    const outside = { id: outsideId, ...(await resultFor(outsideId)) };
    const rowOutside = await listRow(children[2].id);
    check(outside.isError && rowOutside?.name === 'child-three', 'Update outside the own tree raised the card; Deny returned a tool error and the name is unchanged.', `outside deny: ${JSON.stringify(outside)} row ${JSON.stringify(rowOutside)}`);
    await shot('07-after-deny.png');

    check((await toasts()) === toastsBefore, 'No error result raised a toast.', `toasts ${toastsBefore} -> ${await toasts()}`);

    // The delegation rule reaches every launch through the appended rules file.
    const argvLine = readFileSync(debugLog, 'utf8').split('\n').find((l) => l.includes('--append-system-prompt'));
    const rulesPath = argvLine && JSON.parse(/argv=(\[.*?\]) cwd=/.exec(argvLine)[1]).reduce((acc, a, i, all) => (all[i - 1] === '--append-system-prompt' ? a : acc), null);
    const rules = rulesPath && existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
    check(rules.includes('Pick the right way to delegate'), `The rules file passed with --append-system-prompt (${rulesPath}) contains "Pick the right way to delegate".`, `rules file missing the block: ${rulesPath}`);
    if (rules) writeFileSync(path.join(SHOTS_DIR, 'refract-rules.md'), rules);

    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, shots, findings, failures, verdict }, null, 2));
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1859: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1859: FAILED:', err?.stack ?? err);
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
