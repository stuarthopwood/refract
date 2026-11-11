#!/usr/bin/env node
// Live CDP check for #1193 (OMP host tool channel + panel tools). A fake omp records `set_host_tools` and
// `host_tool_result` frames and replays `host_tool_call` frames this script appends, so every proof is on
// the wire the real omp would use: registration at launch, the overlay `--config`, list/open/invoke, the
// approval card (Deny then Approve), an unknown panel, and a reply for another Session's id.

import { mkdtempSync, writeFileSync, appendFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme, clearKnownOutputFiles } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACT = JSON.parse(readFileSync(path.join(REPO_ROOT, 'specs/124-tool-channel-1193/contracts/panel-actions.json'), 'utf8'));
const SHOTS_DIR = process.env.REFRACT_1193_SHOTS_DIR || path.join(tmpdir(), `refract-1193-tool-channel-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = ['01-changes-opened-by-agent.png', '02-approval-card.png', '03-after-approve.png', '1193-dark.png', 'report.json', 'app.log', 'fake-omp-invocations.log', 'host-tools.jsonl'];

const COMPOSER = `document.querySelector('[aria-label="Message"]')`;
const findings = [];
const failures = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));

async function main() {
  let dirs = [];
  let child, targetPid, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1193-tool-channel-shots', SHOT_NAMES);
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1193-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1193');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1193: git HEAD ${gitHeadSha}; shots ${SHOTS_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1193' });
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
        REFRACT_FAKE_OMP_SCENARIO: 'session',
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
        if (hit) {
          const body = JSON.parse(hit.frame.result.content[0].text);
          return { isError: hit.frame.isError === true, body };
        }
        await sleep(150);
      }
      throw new Error(`no host_tool_result for ${id} within 20s`);
    };
    let n = 0;
    const call = (toolName, args, pid) => {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args, ...(pid ? { __pid: pid } : {}) })}\n`);
      return id;
    };

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    await cdp.waitFor(`!!${COMPOSER}`, { label: 'Composer mounted' });
    const norm = (p) => path.resolve(p).toLowerCase();
    const wt = spawnSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout
      .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()).find((p) => norm(p) !== norm(repoDir));
    if (!wt) throw new Error('the Session has no linked worktree');
    writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    const registered = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools');
        if (hit) return hit;
        await sleep(200);
      }
      return null;
    })();
    const pidA = registered?.pid;
    const tools = registered?.frame.tools ?? [];
    check(
      tools.length === 3 && tools.every((t) => t.name.startsWith('refract_') && t.loadMode === 'essential'),
      `set_host_tools sent at launch with ${tools.map((t) => t.name).join(', ')}, all loadMode essential.`,
      `set_host_tools missing or wrong at launch: ${JSON.stringify(tools.map((t) => [t.name, t.loadMode]))}`
    );
    const launchLines = readFileSync(path.join(exeDir, 'fake-omp-invocations.log'), 'utf8').split('\n').filter((l) => l.includes(`pid=${pidA} argv=`));
    const configCount = (launchLines[0]?.match(/"--config"/g) ?? []).length;
    check(
      configCount >= 2 && /agent-tools-approval\.yml/.test(launchLines[0] ?? ''),
      `omp launched with ${configCount} --config args, one being agent-tools-approval.yml.`,
      `omp argv lacks the approval overlay as a second --config: ${launchLines[0]}`
    );

    // list_panels
    const listId = call('refract_list_panels', {});
    const list = await resultFor(listId);
    const listed = (list.body.panels ?? []).map((p) => p.id).sort();
    const contract = CONTRACT.panels.map((p) => p.id).sort();
    check(!list.isError && JSON.stringify(listed) === JSON.stringify(contract), `list_panels returned the ${contract.length} contract panels.`, `list_panels ids ${JSON.stringify(listed)} != contract ${JSON.stringify(contract)}`);

    // open_panel without stealing focus, announced
    await cdp.click(COMPOSER);
    const focusBefore = await cdp.evaluate(`document.activeElement === ${COMPOSER}`);
    const openId = call('refract_open_panel', { panelId: 'git-changes' });
    const opened = await resultFor(openId);
    await cdp.waitFor(`(document.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]')?.textContent ?? '').includes('Agent opened Git changes')`, { timeoutMs: 10_000, label: 'Open announced' });
    const focusAfter = await cdp.evaluate(`document.activeElement === ${COMPOSER}`);
    check(!opened.isError && focusBefore && focusAfter, 'open_panel opened Git changes, announced "Agent opened Git changes", and the composer kept focus.', `open_panel: isError=${opened.isError} focusBefore=${focusBefore} focusAfter=${focusAfter}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-changes-opened-by-agent.png'));
    await cdp.waitFor(`document.body.innerText.includes('a.txt')`, { timeoutMs: 15_000, label: 'a.txt shown in the Changes panel' });
    await cdp.screenshot(path.join(SHOTS_DIR, '01-changes-opened-by-agent.png'));

    // stage_file: Deny, then Approve
    const approveBtns = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve')`;
    const denyId = call('refract_invoke_panel_action', { panelId: 'git-changes', action: 'stage_file', input: { path: 'a.txt' } });
    await cdp.waitFor(`${approveBtns}.length === 1`, { timeoutMs: 20_000, label: 'exactly one approval card' });
    await sleep(500);
    const cards = await cdp.evaluate(`${approveBtns}.length`);
    check(cards === 1, 'stage_file raised exactly one approval card.', `expected one approval card, saw ${cards}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-approval-card.png'));
    await cdp.clickByText('Deny');
    const denied = await resultFor(denyId);
    check(denied.isError && denied.body.error?.code === 'denied', 'Deny returned a `denied` tool error.', `Deny result: ${JSON.stringify(denied)}`);
    const stagedAfterDeny = spawnSync('git', ['-C', wt, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout.trim();
    check(stagedAfterDeny === '', 'Nothing was staged after Deny.', `Deny staged: ${stagedAfterDeny}`);

    const approveId = call('refract_invoke_panel_action', { panelId: 'git-changes', action: 'stage_file', input: { path: 'a.txt' } });
    await cdp.waitFor(`${approveBtns}.length === 1`, { timeoutMs: 20_000, label: 'approval card again' });
    await cdp.clickByText('Approve');
    const approved = await resultFor(approveId);
    const stagedAfterApprove = spawnSync('git', ['-C', wt, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout.trim();
    check(!approved.isError && stagedAfterApprove === 'a.txt', 'Approve staged a.txt (git diff --cached lists it).', `Approve: ${JSON.stringify(approved)}; staged=${JSON.stringify(stagedAfterApprove)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-after-approve.png'));

    // unknown panel: tool error, no toast
    const toasts = () => cdp.evaluate(`document.querySelectorAll('[data-sonner-toast]').length`);
    const toastsBefore = await toasts();
    const unknownId = call('refract_open_panel', { panelId: 'no-such-panel' });
    const unknown = await resultFor(unknownId);
    await sleep(1000);
    check(unknown.isError && unknown.body.error?.code === 'unknown_panel' && (await toasts()) === toastsBefore, 'Unknown panel returned `unknown_panel` and raised no toast.', `unknown panel: ${JSON.stringify(unknown)}, toasts ${toastsBefore}->${await toasts()}`);

    // a reply for another Session's id is refused
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
    const pidB = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const other = records().find((r) => r.frame.type === 'set_host_tools' && r.pid !== pidA);
        if (other) return other.pid;
        await sleep(200);
      }
      return null;
    })();
    await cdp.evaluate(`(() => {
      const agentTools = window.refract.agentTools;
      window.__heldReplies = [];
      window.__origResult = agentTools.result;
      agentTools.result = (sessionId, callId, reply) => { window.__heldReplies.push({ sessionId, callId, reply }); return Promise.resolve({ ok: true, value: null }); };
    })()`);
    const heldCall = call('refract_open_panel', { panelId: 'git-changes' }, pidB);
    await cdp.waitFor(`window.__heldReplies.length === 1`, { timeoutMs: 15_000, label: 'renderer reply held' });
    const held = await cdp.evaluate(`window.__heldReplies[0]`);
    const answer = (sessionId) => cdp.evaluate(`window.__origResult(${JSON.stringify(sessionId)}, ${JSON.stringify(held.callId)}, ${JSON.stringify(held.reply)})`);
    const wrong = await answer(sessionA.id);
    const wrongAccepted = wrong?.ok === true ? wrong.value?.accepted : null;
    const right = await answer(sessionB.id);
    const rightAccepted = right?.ok === true ? right.value?.accepted : null;
    check(held.callId === heldCall && held.sessionId === sessionB.id && wrongAccepted === false && rightAccepted === true, `A reply naming Session A for Session B's call was refused (accepted=false); the owning Session's reply was accepted.`, `cross-Session: wrong=${JSON.stringify(wrong)} right=${JSON.stringify(right)} held=${JSON.stringify(held)}`);
    await cdp.evaluate(`window.refract.agentTools.result = window.__origResult`);

    await switchTheme(cdp, 'dark', 'Dark');
    await cdp.screenshot(path.join(SHOTS_DIR, '1193-dark.png'));
    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, verdict }, null, 2));
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1193: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1193: FAILED:', err?.stack ?? err);
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err) }, null, 2));
    } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const name of ['app.log', 'fake-omp-invocations.log', 'host-tools.jsonl']) if (exeDir && existsSync(path.join(exeDir, name))) copyFileSync(path.join(exeDir, name), path.join(SHOTS_DIR, name));
    } catch {}
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main();
