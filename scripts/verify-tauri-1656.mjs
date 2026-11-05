#!/usr/bin/env node
// Live CDP check for #1656: a session file rewritten past its first 256 bytes is re-ingested.
// The fixture is ingested, then rewritten with the same head and a longer body (a row inserted early,
// one appended); the totals must carry every row exactly once. A shorter rewrite then adds nothing.
// Scratch REFRACT_DATA_DIR and sessions folder; never touches %APPDATA%.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1656.mjs

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { assistantLine, buildFakeClis, entry } from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1656';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1656-usage-rewrite');
const FILTERS = { range: 'all' };
const HEAD_BYTES = 256;
const CWD = 'C:\\Work\\verify1656proj';

const A1 = assistantLine('a1', [10, 5, 100], 0.03);
const A2 = assistantLine('a2', [20, 10, 200], 0.05);
// OMP rewrote the file: a row now sits right after the header, and a new row follows the old ones.
const B9 = assistantLine('b9', [7, 3, 0], 0.01);
const A3 = assistantLine('a3', [4, 1, 0], 0.01);
const A5 = assistantLine('a5', [3, 3, 0], 0.02);

const EXPECT_INITIAL = { calls: 2, totalTokens: 345, spendUsd: 0.08, toolCalls: 0 };
const EXPECT_REWRITTEN = { calls: 4, totalTokens: 360, spendUsd: 0.1, toolCalls: 0 };
const EXPECT_APPENDED = { calls: 5, totalTokens: 366, spendUsd: 0.12, toolCalls: 0 };

const HEADER =
  entry({ type: 'session', id: 's1', timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD }) +
  entry({ type: 'model_change', id: 'm1', timestamp: '2026-10-01T10:00:01.000Z', model: 'github-copilot/claude-sonnet' }) +
  entry({ type: 'thinking_level_change', id: 't1', timestamp: '2026-10-01T10:00:02.000Z', thinkingLevel: 'high' });

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

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-data-'));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-sessions-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-import-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1656-shim-'));

  let child;
  let cdp;
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
  try {
    buildFakeClis(shimDir);
    const folder = path.join(sessionsDir, '--C--Work-verify1656proj--');
    mkdirSync(folder, { recursive: true });
    const sessionFile = path.join(folder, '--C--Work-verify1656proj--_s1.jsonl');
    const initial = HEADER + A1 + A2;
    const rewritten = HEADER + B9 + A1 + A2 + A3;
    const initialHead = Buffer.from(initial).subarray(0, HEAD_BYTES);
    const rewrittenHead = Buffer.from(rewritten).subarray(0, HEAD_BYTES);
    if (Buffer.byteLength(HEADER) < HEAD_BYTES || !initialHead.equals(rewrittenHead)) {
      throw new Error(`${LOG}: fixture must keep its first ${HEAD_BYTES} bytes across the rewrite`);
    }
    writeFileSync(sessionFile, initial);

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

    const first = await awaitSummary(EXPECT_INITIAL);
    check(sameSummary(first, EXPECT_INITIAL), 'the fixture is ingested once at launch', first);

    // Same first 256 bytes, longer body, new rows before and after the old offset.
    writeFileSync(sessionFile, rewritten);
    await call('start');
    const second = await awaitSummary(EXPECT_REWRITTEN);
    check(sameSummary(second, EXPECT_REWRITTEN), 'a rewrite past the first 256 bytes adds every new row, none twice', second);
    await call('start');
    await sleep(3000);
    check(sameSummary(await call('summary', FILTERS), EXPECT_REWRITTEN), 'a further scan does not double count');

    // A shorter rewrite restarts from byte 0; every row dedupes and the stored history stays.
    writeFileSync(sessionFile, HEADER + A1);
    await call('start');
    await sleep(3000);
    const shorter = await call('summary', FILTERS);
    check(sameSummary(shorter, EXPECT_REWRITTEN), 'a shorter rewrite adds nothing and removes nothing', shorter);

    // Ingest still follows appends after the restarts.
    writeFileSync(sessionFile, rewritten);
    appendFileSync(sessionFile, A5);
    await call('start');
    const third = await awaitSummary(EXPECT_APPENDED);
    check(sameSummary(third, EXPECT_APPENDED), 'a row appended after the rewrites is counted once', third);

    await cdp.screenshot(path.join(SHOTS_DIR, '1-rewrite-ingested.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, results: report }, null, 2));
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
