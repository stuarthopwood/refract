#!/usr/bin/env node
// Live Win32 check for #880 (blank taskbar icon): asserts `WM_GETICON` and the window AppUserModelID of a real debug exe.
// The glyph is judged by eye; class icons are only reported because tao registers null ones.
// The packaged AUMID needs an installed build; a debug build uses `APP_USER_MODEL_ID_DEV`.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-880-taskbar-icon.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, citeScreenshots, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { waitForWindowIconState } from './verify-880-taskbar-icon-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-880';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_880_SHOTS_DIR || path.join(tmpdir(), 'refract-880-taskbar-icon-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Mirrors `APP_USER_MODEL_ID_DEV` in `src-tauri/src/shell/app_identity.rs`: any non-`--release` build picks it, and `buildAndCopyExeFresh` always builds `--debug`.
const EXPECTED_DEV_AUMID = 'com.stuarthopwood.refract.rust-preview.dev';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirty.length ? ` (DIRTY: ${dirty.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const notExercised = [
    "The taskbar BUTTON's own glyph (the literal pixels the Windows taskbar strip renders): judged by eye from this run's own window screenshot and its report, not asserted programmatically -- this script instead asserts WM_GETICON(ICON_BIG)/WM_GETICON(ICON_SMALL) both return a real, non-null icon (the actual lookup the taskbar/Alt-Tab resolution reads from, per `shell::app_identity::set_window_icons`'s own doc comment). GetClassLongPtr(GCLP_HICON/GCLP_HICONSM) is read and reported but never asserted: tao's own window class is always registered with null class icons, by design, regardless of this fix.",
    'The PACKAGED AppUserModelID actually grouping a running window with the Start Menu/Desktop shortcut the real NSIS installer creates: needs an installed build (not exercised by any live-check script in this repo); this run only proves the DEV id a debug build carries, matching `shell::app_identity::current_app_user_model_id`’s own `cfg!(debug_assertions)` routing.'
  ];

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertTruthy(actual, label) {
    const ok = Boolean(actual);
    report.push({ step: label, ok, actual });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-880-data-'));
  // An empty per-run folder, never the ambient `%APPDATA%\pinion`, so a real import has nothing real to copy.
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-880-import-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-880-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-880-launcher-'));

  let child;
  let cdp;
  try {
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      importSourceDir,
      logFile: path.join(exeDir, 'app.log')
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    // Waiting for the readiness screen is enough to prove the window painted; no fake omp or session is needed for a native-identity check.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted (window has painted real content)' });

    const screenshotPath = path.join(SHOTS_DIR, 'window.png');
    const windowState = await waitForWindowIconState(launched.targetPid, screenshotPath);
    report.push({ step: 'native window state read via Win32 (WM_GETICON/GetClassLongPtr/SHGetPropertyStoreForWindow)', ok: true, windowState });

    assertTruthy(windowState.hwnd, 'a visible top-level window exists for the launched pid');
    assertTruthy(windowState.wmGetIconBig, 'WM_GETICON(ICON_BIG) returns a non-null HICON');
    assertTruthy(windowState.wmGetIconSmall, 'WM_GETICON(ICON_SMALL) returns a non-null HICON');
    // GCLP_HICON/GCLP_HICONSM are reported only: tao's RegisterClassExW always registers null class icons (tao-0.37.1 window.rs:1434-1441), even on a fixed build.
    report.push({ step: 'GetClassLongPtr(GCLP_HICON/GCLP_HICONSM) read (informational, expected null)', ok: true, classLongHicon: windowState.classLongHicon, classLongHiconSm: windowState.classLongHiconSm });
    assertEqual(windowState.aumid, EXPECTED_DEV_AUMID, 'window AppUserModelID (SHGetPropertyStoreForWindow + PKEY_AppUserModel_ID) equals the expected dev id');

    report.push({ step: 'native window screenshot (title bar icon included)', ok: true, screenshots: citeScreenshots(SHOTS_DIR, ['window.png']) });
  } catch (err) {
    // Always one explicit `ok: false` crash entry, so `report.json` can't read a crashed run as a clean partial pass.
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ head, dirty, results: report, notExercised }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
