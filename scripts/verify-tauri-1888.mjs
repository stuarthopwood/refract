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
    const resultFor = async (id) => {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        await sleep(50);
      }
      throw new Error(`no host_tool_result for ${id} within 40s`);
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

    await cdp.evaluate(`(() => {
      const t = (window.__trace = []);
      const at = (name) => t.push({ name, at: Date.now() });
      const a = window.refract.agentTools;
      const g = window.refract.gitChanges;
      const wrap = (obj, key, label) => {
        const orig = obj[key].bind(obj);
        obj[key] = async (...args) => { at(label + ':start'); try { return await orig(...args); } finally { at(label + ':end'); } };
      };
      wrap(a, 'started', 'started');
      wrap(a, 'result', 'result');
      wrap(g, 'list', 'gitList');
      wrap(g, 'stage', 'gitStage');
      wrap(g, 'unstage', 'gitUnstage');
    })()`);
    const approveBtns = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve')`;
    const runAction = async (label, action, file) => {
      await cdp.evaluate(`window.__trace.length = 0`);
      const sentAt = Date.now();
      const id = call('refract_invoke_panel_action', { panelId: 'git-changes', action, input: { path: file } });
      await cdp.waitFor(`${approveBtns}.length === 1`, { timeoutMs: 30_000, label: `${label} approval card` });
      const cardAt = Date.now();
      await cdp.clickByText('Approve');
      const clickedAt = Date.now();
      const res = await resultFor(id);
      const doneAt = Date.now();
      await sleep(500);
      const trace = (await cdp.evaluate(`window.__trace`)).map((e) => ({ name: e.name, ms: e.at - sentAt }));
      return { label, action, file, res, timings: { cardMs: cardAt - sentAt, approveClickMs: clickedAt - sentAt, resultSeenMs: doneAt - sentAt }, trace };
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
    writeFileSync(path.join(SHOTS_DIR, 'timings.json'), JSON.stringify(runs, null, 2));
    await cdp.screenshot(path.join(SHOTS_DIR, '01-after-actions.png'));

    await switchTheme(cdp, 'dark', 'Dark');
    await cdp.screenshot(path.join(SHOTS_DIR, '1888-dark.png'));
    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, verdict }, null, 2));
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
