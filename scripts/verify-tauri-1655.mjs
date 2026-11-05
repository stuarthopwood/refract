#!/usr/bin/env node
// Live CDP check for #1655: Usage ingest starts at app launch. The driver never calls `usage.start`
// and never opens the Usage view; it only reads `usage.status` and `usage.summary`, so any data
// present was ingested by the launch start. Scratch REFRACT_DATA_DIR and its own port; never
// touches %APPDATA%.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1655.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { EXPECT_BEFORE, buildFakeClis, writeSessionsFixture } from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1655';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1655-usage-launch');
const FILTERS = { range: 'all' };
const LAUNCH_LOG_LINE = 'usage: ingest started at launch';

function near(a, b) {
  return Math.abs(a - b) < 1e-6;
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

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-data-'));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-sessions-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-import-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1655-shim-'));

  let child;
  let cdp;
  const appLog = path.join(exeDir, 'app.log');
  const call = async (method, ...args) => {
    const expr = `window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
    const r = await cdp.evaluate(expr);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  try {
    buildFakeClis(shimDir);
    // The fixture is on disk BEFORE launch; the only reader is the launch-time ingest.
    writeSessionsFixture(sessionsDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: appLog,
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'window.refract.usage present' });
    check(!(await cdp.evaluate(`!!document.querySelector('section[aria-label="Usage"]')`)), 'the Usage view is not open');

    // Read-only polling: `usage.status` never starts the worker, so progress here is the launch start.
    const deadline = Date.now() + 60_000;
    let status = await call('status');
    while (!(status.sessionsSeen >= 2 && status.sessionsDone >= status.sessionsSeen && !status.running) && Date.now() < deadline) {
      await sleep(300);
      status = await call('status');
    }
    check(status.found === true && status.sessionsSeen === 2, 'status shows both fixture files seen with no usage.start call', status);

    const summary = await call('summary', FILTERS);
    const matches =
      summary.calls === EXPECT_BEFORE.calls &&
      summary.totalTokens === EXPECT_BEFORE.totalTokens &&
      summary.toolCalls === EXPECT_BEFORE.toolCalls &&
      near(summary.spendUsd, EXPECT_BEFORE.spendUsd);
    check(matches, 'summary matches the fixture sums, ingested at launch without opening Usage', summary);

    const logText = existsSync(appLog) ? readFileSync(appLog, 'utf8') : '';
    check(logText.includes(LAUNCH_LOG_LINE), `app log carries "${LAUNCH_LOG_LINE}"`, { logBytes: logText.length });

    await cdp.screenshot(path.join(SHOTS_DIR, '1-launch-ingested-no-usage-view.png'));
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
