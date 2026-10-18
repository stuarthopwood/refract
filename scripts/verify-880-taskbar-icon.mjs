#!/usr/bin/env node
// Live check for issue #880 ("Bug: Tauri build's taskbar button shows a generic blank icon, not
// the Refract logo (window icon never set)"). Builds and launches a REAL Tauri debug exe (never
// a mock), then inspects its own real OS-level window state via native Win32 calls (never a DOM
// read): `WM_GETICON`/`GetClassLongPtr` (the two places Windows' own taskbar/Alt-Tab icon
// resolution reads an icon from) and the window's `System.AppUserModel.ID` property via
// `SHGetPropertyStoreForWindow` (the same property `shell::app_identity.rs`'s own doc comment
// cites Tauri's NSIS installer as writing onto the Start Menu/Desktop shortcut it creates,
// confirmed there against `tauri-bundler`'s own source). Also captures a native (title-bar
// included) screenshot of the window via `PrintWindow`.
//
// STATED LIMITATIONS (lane gate checklist: "never claim a test that did not happen"):
//   - The taskbar BUTTON's own glyph is judged by eye from the screenshot/report, not asserted
//     programmatically -- this script proves the window itself carries a real, non-null icon at
//     both OS lookup points taskbar/Alt-Tab icon resolution reads from (which is what actually
//     controls the glyph), and that the running identity is exactly the expected dev AUMID; it
//     does not additionally screenshot the live Windows taskbar strip itself.
//   - The PACKAGED id's shortcut grouping (`APP_USER_MODEL_ID_PACKAGED` matching the real NSIS
//     installer's own shortcut `PKEY_AppUserModel_ID`) needs an installed build to verify end to
//     end; this script runs a debug (unpackaged) build, which `shell::app_identity::
//     current_app_user_model_id` deliberately routes to `APP_USER_MODEL_ID_DEV` instead (see that
//     module's own doc comment) -- asserted here as the one its own build run must carry.
//
// Usage (after `pnpm install` on this exact head): CARGO_TARGET_DIR=<shared target dir>
// CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node scripts/verify-880-taskbar-icon.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, citeScreenshots, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { readWindowIconState } from './verify-880-taskbar-icon-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-880';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_880_SHOTS_DIR || path.join(tmpdir(), 'refract-880-taskbar-icon-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Mirrors `src-tauri/src/shell/app_identity.rs`'s own `APP_USER_MODEL_ID_DEV` constant (that
// module's own doc comment: `cfg!(debug_assertions)` picks this id for any non-`--release` build,
// and `buildAndCopyExeFresh` below always runs `pnpm tauri build --debug --no-bundle`).
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
    "The taskbar BUTTON's own glyph (the literal pixels the Windows taskbar strip renders): judged by eye from this run's own window screenshot and its report, not asserted programmatically -- this script instead asserts the two real OS lookup points (WM_GETICON, GetClassLongPtr) that control what the taskbar draws both carry a real, non-null icon.",
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
  // Gate-pattern from #926 round 2 (Code2 Low): an explicit, empty, per-run scratch folder --
  // never the caller's own ambient `%APPDATA%\pinion` -- so a real import attempt has nothing
  // real to copy from (this script never touches the data a real import would produce anyway).
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

    // Real UI flow: just enough to prove the window has actually painted real content before the
    // native inspection/screenshot below runs (mirrors `verify-926-attach-any-file.mjs`'s own
    // readiness-mount wait) -- no fake omp shim, no session creation: this issue is about the
    // native window/taskbar identity, not anything the renderer itself renders, so the readiness
    // screen mounting (regardless of whether a real omp happens to be on PATH) is sufficient.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted (window has painted real content)' });

    const screenshotPath = path.join(SHOTS_DIR, 'window.png');
    const windowState = readWindowIconState(launched.targetPid, screenshotPath);
    report.push({ step: 'native window state read via Win32 (WM_GETICON/GetClassLongPtr/SHGetPropertyStoreForWindow)', ok: true, windowState });

    assertTruthy(windowState.hwnd, 'a visible top-level window exists for the launched pid');
    assertTruthy(windowState.wmGetIconBig, 'WM_GETICON(ICON_BIG) returns a non-null HICON');
    assertTruthy(windowState.wmGetIconSmall, 'WM_GETICON(ICON_SMALL) returns a non-null HICON');
    assertTruthy(windowState.classLongHicon, 'GetClassLongPtr(GCLP_HICON) returns a non-null HICON');
    assertTruthy(windowState.classLongHiconSm, 'GetClassLongPtr(GCLP_HICONSM) returns a non-null HICON');
    assertEqual(windowState.aumid, EXPECTED_DEV_AUMID, 'window AppUserModelID (SHGetPropertyStoreForWindow + PKEY_AppUserModel_ID) equals the expected dev id');

    report.push({ step: 'native window screenshot (title bar icon included)', ok: true, screenshots: citeScreenshots(SHOTS_DIR, ['window.png']) });
  } catch (err) {
    // Gate-pattern (#926 round 4, Test4 Medium): one explicit `ok: false` crash entry, always, so
    // `report.json` alone can never misread a genuinely crashed run as a clean partial pass.
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
