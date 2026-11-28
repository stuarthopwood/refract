#!/usr/bin/env node
// Gate probe for spec 144 (research R-1, T012/T013): drives a DEBUG build of the app, hands the renderer a
// Tauri `Channel` handle as an argument of `refract_request('terminal.probe', ...)`, and prints the bytes that
// arrive. Pass: an 8-byte frame and a 4096-byte frame arrive byte-identical to `i % 251`, with the committed
// capabilities and CSP unchanged. The 4096-byte frame is the one that must take Tauri's fetch path.
// All data is scratch (REFRACT_DATA_DIR); the real %APPDATA%\refract-tauri is never touched.
//
// Run from a build slot, never from Stuart's running instance: node scripts/verify-terminal-probe.mjs

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged, launchBuiltExe } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TASK_DIR = process.env.REFRACT_TERMINAL_PROBE_DIR || path.join(tmpdir(), 'scratch', 'terminal-probe');
const LOG = 'verify-terminal-probe';
const EXPECTED_SIZES = [8, 4096];

/** The same bytes the Rust probe sends: byte i is i % 251. */
const expectedFrame = (len) => Array.from({ length: len }, (_, i) => i % 251);

/** Runs in the page: builds a channel the way `@tauri-apps/api` does, calls the probe, collects ordered frames. */
const PROBE_IN_PAGE = `(async () => {
  const frames = new Map();
  const id = window.__TAURI_INTERNALS__.transformCallback((raw) => {
    if ('end' in raw) return;
    frames.set(raw.index, raw.message);
  });
  const reply = await window.__TAURI_INTERNALS__.invoke('refract_request', { channel: 'terminal.probe', args: ['__CHANNEL__:' + id] });
  const deadline = Date.now() + 15000;
  while (frames.size < ${EXPECTED_SIZES.length} && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const ordered = [...frames.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  return {
    reply,
    frames: ordered.map((m) => ({
      kind: m instanceof ArrayBuffer ? 'ArrayBuffer' : ArrayBuffer.isView(m) ? 'TypedArray' : Array.isArray(m) ? 'Array' : typeof m,
      bytes: Array.from(m instanceof ArrayBuffer ? new Uint8Array(m) : Array.isArray(m) ? m : new Uint8Array(m.buffer ?? []))
    }))
  };
})()`;

async function main() {
  const failures = [];
  const check = (condition, message) => {
    if (condition) console.log(`${LOG}: PASS: ${message}`);
    else {
      failures.push(message);
      console.error(`${LOG}: FAIL: ${message}`);
    }
  };
  const realRegistry = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
  let child, targetPid, cdp, exePath, exeHash, runDir;
  try {
    mkdirSync(TASK_DIR, { recursive: true });
    runDir = mkdtempSync(path.join(TASK_DIR, 'run-'));
    const dirs = Object.fromEntries(['data', 'import', 'exe', 'launcher'].map((n) => [n, path.join(runDir, n)]));
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    const launcherExe = buildLauncher(dirs.launcher);
    // `terminal.probe` is registered under `debug_assertions` only, so this must be the debug build.
    const built = buildAndCopyExeFresh(dirs.exe, requireSharedCargoTarget(REPO_ROOT), REPO_ROOT, { label: LOG });
    exePath = built.dest;
    exeHash = built.hash;
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      logFile: path.join(dirs.exe, 'app.log')
    });
    child = launched.child;
    targetPid = launched.targetPid;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, targetPid)) throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${targetPid}`);
    await cdp.waitFor(`!!window.__TAURI_INTERNALS__?.invoke`, { timeoutMs: 60_000, label: 'Tauri internals present' });

    const result = await cdp.evaluate(PROBE_IN_PAGE);
    console.log(`${LOG}: reply ${JSON.stringify(result.reply)}`);
    check(result.reply?.ok === true, 'terminal.probe replied ok');
    check(result.frames.length === EXPECTED_SIZES.length, `received ${EXPECTED_SIZES.length} frames (got ${result.frames.length})`);
    EXPECTED_SIZES.forEach((size, i) => {
      const frame = result.frames[i];
      console.log(`${LOG}: frame ${i}: ${frame?.kind}, ${frame?.bytes.length} bytes, head ${JSON.stringify(frame?.bytes.slice(0, 16))}`);
      check(frame !== undefined && JSON.stringify(frame.bytes) === JSON.stringify(expectedFrame(size)), `frame ${i} is ${size} bytes, byte-identical to i % 251`);
    });
    assertExeUnchanged(exePath, exeHash, 'end of run', LOG);
  } catch (err) {
    failures.push(`run aborted: ${err?.stack ?? err}`);
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null && getProcessExecutablePath(targetPid)) failures.push(`target pid ${targetPid} still running after stopLauncher`);
    }
    const realAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
    if (realBefore !== realAfter) failures.push('the real %APPDATA%\\refract-tauri\\registry.json mtime changed during the run');
    try {
      writeFileSync(path.join(TASK_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), exeSha256: exeHash ?? null, failures }, null, 2));
    } catch (err) {
      console.warn(`${LOG}: could not write report.json: ${err.message}`);
    }
    if (runDir) await safeRmSync(runDir, LOG);
    console.log(`${LOG}: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
