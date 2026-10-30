#!/usr/bin/env node
// Live CDP check for spec 060 / issue #1331 (Usage view), slice 1: the ingest worker and the
// `usage.*` IPC. Drives a REAL built Tauri debug exe over CDP against a synthetic OMP sessions
// folder, a fake `omp` and a fake `gh` (both real exes first on PATH, every call logged), a scratch
// REFRACT_DATA_DIR and its own remote-debugging port. It never touches %APPDATA%\refract-tauri or
// an installed Refract.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle` on this head, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1331.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    for (const dir of [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }

  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
