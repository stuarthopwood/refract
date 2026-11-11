#!/usr/bin/env node
// Live CDP check for #1888 (agent-panel stage action timing out). A fake omp replays `host_tool_call` frames; the
// first agent action after launch is traced (renderer-side timestamps on agentTools.started/result and the
// gitChanges calls) to confirm or refute the cold-start cause, then a warm stage and an unstage are compared.

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
const SHOTS_DIR = process.env.REFRACT_1888_SHOTS_DIR || path.join(tmpdir(), `refract-1888-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = ['01-after-actions.png', '1888-dark.png', 'timings.json', 'report.json', 'app.log', 'fake-omp-invocations.log', 'host-tools.jsonl'];
// Longer than the router's 30 s window, with margin on both sides.
const HOLD_MS = 35_000;

const COMPOSER = `document.querySelector('[aria-label="Message"]')`;
const findings = [];
const failures = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));

async function main() {
  const dirs = [];
  let child, targetPid, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1888-shots', SHOT_NAMES);
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1888-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1888');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1888: git HEAD ${gitHeadSha}; shots ${SHOTS_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1888' });
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
    const resultFor = async (id, deadlineMs = 40_000) => {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) {
          const body = JSON.parse(hit.frame.result.content[0].text);
          return { isError: hit.frame.isError === true, body, code: body?.error?.code ?? null };
        }
        await sleep(50);
      }
      throw new Error(`no host_tool_result for ${id} within ${deadlineMs / 1000}s`);
    };
    let n = 0;
    const call = (toolName, args) => {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args })}\n`);
      return id;
    };

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    await latestSessionIdAndName(cdp, repoName, []);
    await cdp.waitFor(`!!${COMPOSER}`, { label: 'Composer mounted' });
    const norm = (p) => path.resolve(p).toLowerCase();
    const wt = spawnSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout
      .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()).find((p) => norm(p) !== norm(repoDir));
    if (!wt) throw new Error('the Session has no linked worktree');
    writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    writeFileSync(path.join(wt, 'b.txt'), 'second\n');
    const registeredDeadline = Date.now() + 30_000;
    while (Date.now() < registeredDeadline && !records().some((r) => r.frame.type === 'set_host_tools')) await sleep(200);

    // The narrowest hook: the renderer's own `window.refract.agentTools.started` / `.result` methods, which the bridge
    // reads at call time. One armed call is stalled by HOLD_MS before the real IPC goes out; Rust and the IPC are untouched.
    await cdp.evaluate(`(() => {
      const t = (window.__trace = []);
      window.__hold = {};
      window.__held = {};
      const at = (name) => t.push({ name, at: Date.now() });
      const a = window.refract.agentTools;
      const g = window.refract.gitChanges;
      const wrap = (obj, key, label) => {
        const orig = obj[key].bind(obj);
        obj[key] = async (...args) => {
          at(label + ':start');
          const ms = window.__hold[label] ?? 0;
          if (ms) {
            delete window.__hold[label];
            await new Promise((r) => setTimeout(r, ms));
          }
          let answer, error;
          try {
            answer = await orig(...args);
            return answer;
          } catch (e) {
            error = String(e);
            throw e;
          } finally {
            if (ms) window.__held[label] = { heldMs: ms, answer, error, at: Date.now() };
            at(label + ':end');
          }
        };
      };
      wrap(a, 'started', 'started');
      wrap(a, 'result', 'result');
      wrap(g, 'list', 'gitList');
      wrap(g, 'stage', 'gitStage');
      wrap(g, 'unstage', 'gitUnstage');
    })()`);
    const approveBtns = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve')`;
    const runAction = async (label, action, file, holdKey = null) => {
      await cdp.evaluate(`window.__trace.length = 0; window.__held = {}; window.__hold = ${JSON.stringify(holdKey ? { [holdKey]: HOLD_MS } : {})}`);
      const sentAt = Date.now();
      const id = call('refract_invoke_panel_action', { panelId: 'git-changes', action, input: { path: file } });
      await cdp.waitFor(`${approveBtns}.length === 1`, { timeoutMs: 30_000, label: `${label} approval card` });
      const cardAt = Date.now();
      await cdp.clickByText('Approve');
      const clickedAt = Date.now();
      const res = await resultFor(id, holdKey ? HOLD_MS + 20_000 : 40_000);
      const doneAt = Date.now();
      // A held call is released later; wait for it so the late answer and any wrongful change are observed.
      if (holdKey) await cdp.waitFor(`!!window.__held.${holdKey}`, { timeoutMs: HOLD_MS + 20_000, label: `${label} held ${holdKey} released` });
      await sleep(holdKey ? 2_500 : 500);
      const trace = (await cdp.evaluate(`window.__trace`)).map((e) => ({ name: e.name, ms: e.at - sentAt }));
      const held = holdKey ? await cdp.evaluate(`window.__held.${holdKey}`) : null;
      return { label, action, file, holdKey, held, res, timings: { cardMs: cardAt - sentAt, approveClickMs: clickedAt - sentAt, resultSeenMs: doneAt - sentAt }, trace };
    };
    const runs = [];
    runs.push(await runAction('cold-first-action', 'stage_file', 'a.txt'));
    runs.push(await runAction('warm-stage', 'stage_file', 'b.txt'));
    runs.push(await runAction('warm-unstage', 'unstage_file', 'a.txt'));
    for (const r of runs) {
      check(!r.res.isError, `${r.label}: ${r.action} ${r.file} succeeded (card ${r.timings.cardMs} ms, result seen ${r.timings.resultSeenMs} ms after the call).`, `${r.label}: ${JSON.stringify(r.res)}`);
      console.log(r.label, JSON.stringify(r.timings), JSON.stringify(r.trace));
    }
    const stagedNow = spawnSync('git', ['-C', wt, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout.trim();
    check(stagedNow === 'b.txt', 'Final index holds only b.txt (a.txt staged then unstaged).', `index after the three actions: ${JSON.stringify(stagedNow)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-after-actions.png'));

    // Does `context.open()` (agent-panel-actions.ts, before the stage) cost an extra gitChanges.list? Judged from timings:
    // a list that starts after `started` returned and before the stage IPC finished is not the changedFile() reload (that
    // precedes `started`) nor the post-stage refresh (that follows the stage).
    const listsInWindow = (trace) => {
      const from = trace.find((e) => e.name === 'started:end')?.ms;
      const to = trace.find((e) => e.name === 'gitStage:end' || e.name === 'gitUnstage:end')?.ms;
      return trace.filter((e) => e.name === 'gitList:start' && e.ms >= from && e.ms < to).map((e) => e.ms);
    };
    const extraList = { coldRun: listsInWindow(runs[0].trace), warmRuns: [listsInWindow(runs[1].trace), listsInWindow(runs[2].trace)] };
    extraList.contextOpenTriggersExtraList = extraList.coldRun.length > 0 && extraList.warmRuns.every((w) => w.length === 0);
    findings.push(`Extra gitChanges.list between started and the stage IPC: cold ${JSON.stringify(extraList.coldRun)} ms, warm ${JSON.stringify(extraList.warmRuns)} ms; context.open() triggers one: ${extraList.contextOpenTriggersExtraList}.`);

    const git = (...args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' }).stdout.trim();
    const staged = () => git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
    const scenarios = {};

    // (a) `agentTools.result` stalled past 30 s after `started`: the file changes, Rust cannot know, so outcome_unknown.
    writeFileSync(path.join(wt, 'c.txt'), 'third\n');
    const holdResult = await runAction('hold-result', 'stage_file', 'c.txt', 'result');
    check(holdResult.res.isError && holdResult.res.code === 'outcome_unknown', `hold-result: result held ${HOLD_MS / 1000} s after started, the tool result was outcome_unknown (seen ${holdResult.timings.resultSeenMs} ms after the call).`, `hold-result: expected outcome_unknown, got ${JSON.stringify(holdResult.res)}`);
    check(holdResult.timings.resultSeenMs >= 30_000, 'hold-result: the verdict arrived only after the 30 s window.', `hold-result: verdict arrived after ${holdResult.timings.resultSeenMs} ms, before 30 s`);
    check(staged().includes('c.txt'), 'hold-result: c.txt really is staged, which is why the outcome is unknown rather than a timeout.', `hold-result: c.txt is not staged: ${JSON.stringify(staged())}`);
    scenarios.holdResult = { code: holdResult.res.code, resultSeenMs: holdResult.timings.resultSeenMs, stagedAfter: staged(), lateResultIpc: holdResult.held };

    // (b) `agentTools.started` stalled past 30 s: Rust gives up with timeout, and the released started is refused.
    const stagedBefore = staged();
    writeFileSync(path.join(wt, 'd.txt'), 'fourth\n');
    const holdStarted = await runAction('hold-started', 'stage_file', 'd.txt', 'started');
    const lateStarted = holdStarted.held?.answer;
    check(holdStarted.res.isError && holdStarted.res.code === 'timeout', `hold-started: started held ${HOLD_MS / 1000} s, the tool result was timeout (seen ${holdStarted.timings.resultSeenMs} ms after the call).`, `hold-started: expected timeout, got ${JSON.stringify(holdStarted.res)}`);
    check(holdStarted.timings.resultSeenMs >= 30_000, 'hold-started: the verdict arrived only after the 30 s window.', `hold-started: verdict arrived after ${holdStarted.timings.resultSeenMs} ms, before 30 s`);
    check(lateStarted?.ok === true && lateStarted?.value?.accepted === false, 'hold-started: the released agentTools.started answered accepted: false.', `hold-started: late started answer ${JSON.stringify(holdStarted.held)}`);
    const porcelain = git('status', '--porcelain');
    check(JSON.stringify(staged()) === JSON.stringify(stagedBefore) && /^\?\? d\.txt$/m.test(porcelain), 'hold-started: nothing was staged (d.txt is still untracked, index unchanged).', `hold-started: index ${JSON.stringify(staged())} vs ${JSON.stringify(stagedBefore)}; status ${JSON.stringify(porcelain)}`);
    check(!holdStarted.trace.some((e) => e.name === 'gitStage:start'), 'hold-started: the renderer never called gitChanges.stage after the refusal.', 'hold-started: the renderer called gitChanges.stage after a refused started');
    scenarios.holdStarted = { code: holdStarted.res.code, resultSeenMs: holdStarted.timings.resultSeenMs, lateStartedAnswer: lateStarted, gitStatusPorcelain: porcelain, stagedAfter: staged() };
    for (const r of [holdResult, holdStarted]) console.log(r.label, JSON.stringify(r.timings), JSON.stringify(r.res), JSON.stringify(r.held));
    runs.push(holdResult, holdStarted);
    writeFileSync(path.join(SHOTS_DIR, 'timings.json'), JSON.stringify(runs, null, 2));

    await switchTheme(cdp, 'dark', 'Dark');
    await cdp.screenshot(path.join(SHOTS_DIR, '1888-dark.png'));
    const verdict = failures.length ? 'FAILED' : 'DONE';
    const ompHostToolTimeout = {
      checked: 'omp 18.18.3 binary (Probe520/bin/omp-windows-x64.exe), packages/coding-agent/src/modes/rpc/host-tools.ts as embedded in it, and the omp docs rpc.md. The installed omp 18.17.0 binary was not searched.',
      found: 'No timer. The host tool adapter execute() calls requestExecution(), which emits host_tool_call and waits only for host_tool_result, host_tool_cancel or the abort signal. rpc.md documents no host-tool timeout either; the only timeouts it states are the 30 s bundled-client request timeout for commands and ask-dialog timeouts.',
      belowSixtySeconds: false,
      caveat: 'Not seen: any wrapper in the agent tool loop outside host-tools.ts. The binary is bytecode-compiled, so absence there is not proven. TOOL_TIMEOUTS in the binary clamps the `timeout` argument of built-in tools and does not apply to host tools.'
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, verdict, scenarios, extraList, ompHostToolTimeout }, null, 2));
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1888: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1888: FAILED:', err?.stack ?? err);
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
