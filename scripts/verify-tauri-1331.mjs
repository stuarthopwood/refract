#!/usr/bin/env node
// Live CDP check for #1331 (Usage view): ingest worker and `usage.*` IPC, against a real debug
// exe, fake `omp`/`gh`, a scratch REFRACT_DATA_DIR and its own port; never touches %APPDATA%.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1331.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import {
  APPENDED_COST,
  APPENDED_USAGE,
  EXPECT_AFTER_APPEND,
  EXPECT_AFTER_CUT,
  EXPECT_BEFORE,
  assistantLine,
  buildFakeClis,
  cutLineRemainder,
  writeSessionsFixture
} from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1331';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1331-usage');
const FILTERS = { range: 'all' };

function near(a, b) {
  return Math.abs(a - b) < 1e-6;
}

function sameSummary(actual, expected) {
  return (
    actual &&
    actual.calls === expected.calls &&
    actual.totalTokens === expected.totalTokens &&
    actual.toolCalls === expected.toolCalls &&
    near(actual.spendUsd, expected.spendUsd)
  );
}

function callLines(logPath) {
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const failures = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-data-'));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-sessions-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-import-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-shim-'));

  let child;
  let cdp;
  let logs;
  const extraDirs = [];
  const call = async (method, ...args) => {
    const expr = `window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
    const r = await cdp.evaluate(expr);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  // The worker ingests asynchronously: poll until the summary matches, or return the last one seen.
  const awaitSummary = async (expected, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = await call('summary', FILTERS);
    while (!sameSummary(last, expected) && Date.now() < deadline) {
      await sleep(300);
      last = await call('summary', FILTERS);
    }
    return last;
  };
  const awaitStatus = async (ready, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = await call('status');
    while (!ready(last) && Date.now() < deadline) {
      await sleep(300);
      last = await call('status');
    }
    return last;
  };
  try {
    logs = buildFakeClis(shimDir);
    const mainFile = writeSessionsFixture(sessionsDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'window.refract.usage present' });

    // Slice 1, step 4: start, settle, compare the summary to the fixture sums.
    const started = await call('start');
    check(started.sessionsDir === sessionsDir || started.found === true, 'usage.start reports the scratch sessions directory', started);
    const settled = await awaitStatus((s) => s.sessionsSeen >= 2 && s.sessionsDone >= s.sessionsSeen);
    check(settled.sessionsSeen === 2 && settled.found === true, 'status settles with both fixture files seen (main + subagent)', settled);
    const summary1 = await awaitSummary(EXPECT_BEFORE);
    check(sameSummary(summary1, EXPECT_BEFORE), 'summary matches the fixture sums (cut last line not counted)', summary1);

    // A second start changes nothing.
    await call('start');
    await sleep(3000);
    const summary2 = await call('summary', FILTERS);
    check(sameSummary(summary2, EXPECT_BEFORE), 'a second usage.start leaves the summary unchanged (dedupe)', summary2);

    // Complete the cut line: counted once.
    appendFileSync(mainFile, cutLineRemainder());
    await call('start');
    const summary3 = await awaitSummary(EXPECT_AFTER_CUT);
    check(sameSummary(summary3, EXPECT_AFTER_CUT), 'the completed cut line is counted exactly once', summary3);
    await call('start');
    await sleep(3000);
    check(sameSummary(await call('summary', FILTERS), EXPECT_AFTER_CUT), 're-reading after completion does not double count');

    // Append a complete new line: it lands on the next scan.
    appendFileSync(mainFile, assistantLine('a4', APPENDED_USAGE, APPENDED_COST));
    await call('start');
    const summary4 = await awaitSummary(EXPECT_AFTER_APPEND);
    check(sameSummary(summary4, EXPECT_AFTER_APPEND), 'an appended complete line lands on the next scan', summary4);

    // Other query channels answer on the same data; bad arguments are refused.
    const mix = await call('tokenMix', FILTERS);
    check(Array.isArray(mix) && mix.length === 4, 'usage.tokenMix returns the four token kinds', mix);
    const calls = await call('calls', FILTERS, { key: 'ts', dir: 'desc' }, { index: 0, size: 100 });
    check(calls && Array.isArray(calls.rows) && calls.rows.length === EXPECT_AFTER_APPEND.calls, 'usage.calls pages every call', calls && calls.rows && calls.rows.length);
    const bad = await cdp.evaluate(`window.refract.usage.calls(${JSON.stringify(FILTERS)}, { key: 'ts', dir: 'desc' }, { index: 0, size: 100000 })`);
    check(bad && bad.ok === false, 'usage.calls refuses an out-of-bounds page size', bad);
    const badRange = await cdp.evaluate(`window.refract.usage.summary({ range: "forever" })`);
    check(badRange && badRange.ok === false, 'usage.summary refuses an unknown range', badRange);

    // Budget: one `omp usage --json` call however often it is asked (5-minute cache).
    const budget1 = await call('budget');
    await call('budget');
    check(!!budget1 && (!!budget1.copilot || (budget1.providers && budget1.providers.length > 0)), 'usage.budget answers from the fake omp report', budget1);
    const ompCalls = callLines(logs.omp);
    const usageCalls = ompCalls.filter((c) => c[0] === 'usage' && c.includes('--json'));
    check(usageCalls.length === 1, 'fake omp saw exactly one `usage --json` call', { calls: ompCalls });
    const ghCalls = callLines(logs.gh);
    check(ghCalls.length > 0 && ghCalls.some((c) => c[0] === 'auth'), 'the fake gh was used (call log shows `gh auth ...`)', { calls: ghCalls });

    await cdp.screenshot(path.join(SHOTS_DIR, '1-usage-slice1.png'));

    // The left nav only exists once a repository is added: pass readiness, add a scratch repo.
    const repoDir = mkdtempSync(path.join(tmpdir(), 'refract-1331-repo-'));
    extraDirs.push(repoDir);
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    const addScratchRepo = async () => {
      await cdp.waitFor(
        `(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
        { timeoutMs: 60_000, label: 'readiness green' }
      );
      await cdp.openLocalFolderDialog();
      await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
      await cdp.click(`document.querySelector('[role="dialog"] input')`);
      await cdp.send('Input.insertText', { text: repoDir });
      await cdp.clickByText('Add project', { inDialog: true });
      await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'repository added' });
    };
    await addScratchRepo();

    // Slice 2, step 5: open Usage from the left nav and check the populated state.
    const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '')`;
    await cdp.clickByText('Usage');
    await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"] h1')`, { label: 'Usage view with h1 landmark' });
    await cdp.waitFor(`${text('section[aria-label="Usage"]')}.includes('Tool error rate')`, { label: 'headline cards render' });
    const pageText = await cdp.evaluate(text('section[aria-label="Usage"]'));
    for (const label of ['Spend', 'AI credits', 'Model calls', 'Cache hit rate', 'Tool error rate', 'Frustration index']) {
      check(pageText.includes(label), `Usage view shows "${label}"`);
    }
    check(await cdp.evaluate(`!!document.querySelector('section[aria-label="Usage"] [role="group"]')`), 'stat cards are labelled groups');
    check(await cdp.evaluate(`document.querySelectorAll('section[aria-label="Usage"] th[aria-sort]').length > 0`), 'tables expose aria-sort on sortable headers');
    check(await cdp.evaluate(`!!document.querySelector('section[aria-label="Usage"] button[aria-pressed]')`), 'charts offer a "View as table" toggle (aria-pressed)');
    await cdp.screenshot(path.join(SHOTS_DIR, '2-usage-populated.png'));

    // Every filter persists: pick 7 days, reload, reopen, and the tab is still selected.
    await cdp.clickByText('7 days', { tag: '*' });
    await sleep(800);
    await cdp.evaluate(`location.reload()`).catch(() => {});
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
    await cdp.clickByText('Usage');
    await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"] [role="tab"][aria-selected="true"]')`, { label: 'selected range tab' });
    const tab = await cdp.evaluate(`document.querySelector('section[aria-label="Usage"] [role="tab"][aria-selected="true"]').innerText`);
    check(/7 days/i.test(tab), 'the 7 days filter persists after a reload', tab);

    // Progress: a large generated backfill shows the progress bar with value and the sins copy.
    const big = path.join(sessionsDir, '--big--');
    mkdirSync(big, { recursive: true });
    const line = readFileSync(mainFile, 'utf8').split('\n').filter(Boolean)[1];
    for (let i = 0; i < 400; i++) writeFileSync(path.join(big, `s${i}.jsonl`), `${line}\n`.repeat(200));
    await call('start');
    let sawProgress = false;
    for (let i = 0; i < 100 && !sawProgress; i++) {
      sawProgress = await cdp.evaluate(`!!document.querySelector('section[aria-label="Usage"] [role="progressbar"][aria-valuenow]')`);
      if (!sawProgress) await sleep(50);
    }
    if (sawProgress) await cdp.screenshot(path.join(SHOTS_DIR, '3-usage-progress.png'));
    check(sawProgress, 'a large backfill shows a progressbar with aria-valuenow');
    check(!sawProgress || (await cdp.evaluate(text('section[aria-label="Usage"]'))).includes('Counting your sins:'), 'progress copy reads "Counting your sins: N of M sessions"');
    await awaitStatus((s) => !s.running && s.sessionsDone >= s.sessionsSeen, 120_000);

    // Jokes off: captions and the frustration card go away, the choice persists.
    await call('setPrefs', { jokes: false });
    await cdp.evaluate(`location.reload()`).catch(() => {});
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded again' });
    await cdp.clickByText('Usage');
    await cdp.waitFor(`${text('section[aria-label="Usage"]')}.includes('Tool error rate')`, { label: 'cards render with jokes off' });
    const clean = await cdp.evaluate(text('section[aria-label="Usage"]'));
    check(!clean.includes('Frustration index'), 'jokes off hides the frustration card');
    check(!clean.includes('Counting your sins'), 'jokes off uses the plain progress copy');
    await cdp.screenshot(path.join(SHOTS_DIR, '4-usage-jokes-off.png'));

    // Empty state: relaunch against an empty sessions folder and a fresh data dir.
    cdp.close();
    await stopLauncher(child).catch(() => {});
    const emptySessions = mkdtempSync(path.join(tmpdir(), 'refract-1331-empty-'));
    const emptyData = mkdtempSync(path.join(tmpdir(), 'refract-1331-emptydata-'));
    extraDirs.push(emptySessions, emptyData);
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port: port2,
      dataDir: emptyData,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app2.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: emptySessions }
    });
    child = launched2.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port2, { timeoutMs: 60_000 }));
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'second launch ready' });
    await addScratchRepo();
    await cdp.clickByText('Usage');
    await cdp.waitFor(`${text('section[aria-label="Usage"]')}.includes(${JSON.stringify(emptySessions)})`, { label: 'empty state names the sessions folder' });
    check(true, 'the empty state names the sessions folder');
    await cdp.screenshot(path.join(SHOTS_DIR, '5-usage-empty.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, results: report }, null, 2));
      if (logs) {
        for (const name of ['omp', 'gh']) copyFileSync(logs[name], path.join(SHOTS_DIR, `fake-${name}-calls.log`));
      }
    } catch (writeErr) {
      console.error(`${LOG}: failed to write evidence: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir, ...extraDirs]) await safeRmSync(dir, LOG);
  }

  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
