#!/usr/bin/env node
// Live CDP check for issue #980 (toasts covering the composer's Send button). `<Toaster />`
// (`src/renderer/components/ui/sonner.tsx`) now ships `position="bottom-center"` with a bottom
// offset clearing the composer, decided (Skippy, delegated by Stuart 2026-10-18, ui-architect-v3
// ruling) over `top-right`/`bottom-right` because both of those sit adjacent to the permanent
// full-height right rail (`IconRail.tsx`) and, for `bottom-right`, directly over the Send button
// itself. Modelled on `verify-926-attach-any-file.mjs`'s own session-setup flow (readiness ->
// Add repository -> New session -> composer enabled) and its own D1 toast trigger: typing the
// literal `[[refract-attachments]]` marker is a purely client-side refusal (`MessageInput.tsx`)
// with no agent round trip needed, calling `toast.error(...)` -- the EXACT toast
// `verify-926-attach-any-file.mjs` itself flagged in a DIAG comment as covering Send under the
// OLD `bottom-right` default (predating #926, filed from that finding as #980, `docs/PLAN.md`
// "Toast covers Send" row). This script proves the fix: while that same real toast is on screen
// (an error toast, per `docs/design/components.md` "Errors never auto-dismiss" -- it stays up for
// every check below without re-triggering), Send's own hit-test still resolves to Send, and the
// toast's own rect overlaps none of: the title-bar window-controls corner, the right rail, the
// composer, or the Session list header.
//
// STATED LIMITATION (lane gate checklist: "never claim a test that did not happen"): no built-in
// light theme exists in this app (`sonner.tsx`'s own doc comment: "every built-in Refract theme
// is dark-toned ... none is planned") -- the two-theme screenshot requirement is satisfied with
// Dark and Obsidian (the two visually distinct built-in presets), not a literal "light" theme,
// which this product does not have. The narrow-window check uses CDP's own
// `Emulation.setDeviceMetricsOverride` (the standard way to drive a different viewport through
// CDP) rather than an OS-level window resize, which this harness exposes no control for.
//
// Usage (after a `pnpm tauri build --debug --no-bundle` on this exact head, shared target dir
// set): CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-980-toast-send.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmdirSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-980';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_980_SHOTS_DIR || path.join(tmpdir(), 'refract-980-toast-send-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Dark is the app's own default theme; Obsidian is the second built-in preset -- see this
// script's own header for why neither is a literal "light" theme (none exists).
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`${LOG}: buildOmpShim rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

// Local launch helper (not the shared `verify-tauri-scratch-helpers.mjs` one): that shared helper
// has no `pathPrepend`/`extraEnv` hooks, needed here for the fake-omp shim on PATH and its own
// `REFRACT_FAKE_OMP_*` env vars -- the same extension `verify-926-launch-helpers.mjs` and
// `verify-tauri-ask.mjs` already carry, each as their own small local copy (no shared "god
// helper" spanning every story's differing env needs).
async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

// One evaluate call computing every geometry fact this script needs: the toast's own rect
// against the title-bar window-controls corner (`App.tsx`'s top `drag-region` strip's own
// `no-drag-region` child, reserving the native caption-button cluster), the permanent right rail
// (`IconRail.tsx`, selected via its own `role="toolbar"` toolbar's parent so the rail's full
// height -- spacer included -- counts, not just its button column), the composer box (closest
// `border-composer-border` ancestor of the Message textarea), and the Session list's own merged
// top header row (`nav[aria-label="Sessions"]`'s first `.drag-region` child). Also re-proves
// Send's own hit-test (`document.elementFromPoint` at its centre resolves to Send itself, never
// an intercepting toast -- the exact DIAG check `verify-926-attach-any-file.mjs` already uses)
// and that Sonner's own live region (`[data-sonner-toaster]`'s `aria-live="polite"`) is intact.
const CHROME_CHECK_EXPR = `(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height };
  };
  const intersects = (a, b) => !!a && !!b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  const toast = document.querySelector('[data-sonner-toast]');
  const send = document.querySelector('[aria-label^="Send"]');
  const titleBarCorner = document.querySelector('.drag-region.fixed.left-0.top-0 .no-drag-region.ml-auto.h-full');
  const rail = document.querySelector('[role="toolbar"][aria-label="Panels"]');
  const railRoot = rail ? rail.parentElement : null;
  const composer = send ? send.closest('.border-composer-border') : null;
  const sessionHeader = document.querySelector('nav[aria-label="Sessions"] .drag-region');
  const toasterRoot = document.querySelector('[data-sonner-toaster]');
  const toastRect = rectOf(toast);
  const sendRect = send ? send.getBoundingClientRect() : null;
  const sendCenterTop = sendRect ? document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2) : null;
  return {
    hasToast: !!toast,
    sendIsTopAtItsOwnCentre: !!send && !!sendCenterTop && (sendCenterTop === send || send.contains(sendCenterTop)),
    overlapsTitleBar: intersects(toastRect, rectOf(titleBarCorner)),
    overlapsRail: intersects(toastRect, rectOf(railRoot)),
    overlapsComposer: intersects(toastRect, rectOf(composer)),
    overlapsSessionHeader: intersects(toastRect, rectOf(sessionHeader)),
    liveRegionPresent: !!toasterRoot && toasterRoot.getAttribute('aria-live') === 'polite',
    dataYPosition: toasterRoot ? toasterRoot.getAttribute('data-y-position') : null,
    dataXPosition: toasterRoot ? toasterRoot.getAttribute('data-x-position') : null
  };
})()`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirty.length ? ` (DIRTY: ${dirty.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const notExercised = [
    'OS-level window resize for the narrow check: this script uses CDP Emulation.setDeviceMetricsOverride (a viewport override) instead, since the launch harness exposes no OS window-resize control.',
    'A literal light theme screenshot: this product ships no light theme at all (sonner.tsx\'s own doc comment) -- Dark and Obsidian (the two built-in presets) stand in for "two themes".'
  ];

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  async function assertChromeClear(cdp, label) {
    const r = await cdp.evaluate(CHROME_CHECK_EXPR);
    assertEqual(r.hasToast, true, `${label}: the D1 marker-refusal toast is on screen`);
    assertEqual(r.sendIsTopAtItsOwnCentre, true, `${label}: Send's own hit-test resolves to Send itself, not the toast`);
    assertEqual(r.overlapsTitleBar, false, `${label}: the toast does not overlap the title-bar window-controls corner`);
    assertEqual(r.overlapsRail, false, `${label}: the toast does not overlap the right rail`);
    assertEqual(r.overlapsComposer, false, `${label}: the toast does not overlap the composer`);
    assertEqual(r.overlapsSessionHeader, false, `${label}: the toast does not overlap the Session list header`);
    assertEqual(r.liveRegionPresent, true, `${label}: Sonner's own aria-live="polite" region is intact`);
    assertEqual(r.dataYPosition, 'bottom', `${label}: Toaster renders data-y-position="bottom"`);
    assertEqual(r.dataXPosition, 'center', `${label}: Toaster renders data-x-position="center"`);
    return r;
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-980-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-980-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-980-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-980-toast-send');
  // See verify-926-attach-any-file.mjs's own comment (#885): "New session from a branch" creates
  // a SEPARATE worktree, a sibling of `repoDirBase` under `pinion-worktrees/<repoName>`, never
  // nested inside it -- cleaned up explicitly in `finally`, never a wildcard delete.
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-980-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-980-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-980-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
        // REFRACT_FAKE_OMP_SCENARIO left unset -> defaults to 'session'.
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    // Real UI flow (mirrors verify-926-attach-any-file.mjs): readiness, Add repository, New
    // session, wait for the composer to enable against the fake omp's own scripted `session` tape.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Composer enabled'
    });

    // The D1 toast (verify-926-attach-any-file.mjs): a purely client-side refusal, no agent round
    // trip, calling `toast.error(...)` -- an ERROR toast never auto-dismisses
    // (docs/design/components.md "Toasts and notices"), so it stays up for every check below.
    await cdp.evaluate(
      `(() => { const ta = document.querySelector('[aria-label="Message"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '[[refract-attachments]]'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    );
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[data-sonner-toast]')).find((el) => el.textContent.includes('reserved') && el.textContent.includes('marker'))`,
      { timeoutMs: 10_000, label: 'a real toast.error() fires for the marker refusal' }
    );
    const d1NothingSent = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length === 0`);
    assertEqual(d1NothingSent, true, 'nothing was sent (this is a genuine refusal toast, not a send-success one)');

    // Dark (the app's own default) first, then Obsidian -- same persistent error toast throughout.
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const r = await assertChromeClear(cdp, `${theme.name} theme`);
      await cdp.screenshot(path.join(SHOTS_DIR, `toast-${theme.id}.png`));
      report.push({ step: `${theme.name} theme: toast clear of every fixed chrome element`, ok: true, geometry: r });
    }

    // Narrow window (~900px): a CDP viewport override (see this script's own header for why not
    // an OS-level resize), re-proving every check still holds once the layout compresses.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    const narrowResult = await assertChromeClear(cdp, 'narrow (~900px) window');
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-narrow.png'));
    report.push({ step: 'narrow (~900px) window: toast clear of every fixed chrome element', ok: true, geometry: narrowResult });
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `toast-${t.id}.png`), 'toast-narrow.png'])
    });
  } catch (err) {
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
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    // Only this exact, already-computed literal path -- never a wildcard or derived default --
    // same guard verify-926-attach-any-file.mjs uses for the shared `%TEMP%\pinion-worktrees`
    // parent (#885): `rmdirSync` fails outright on a non-empty directory, so a concurrent or
    // crashed sibling run's own leftover subdirectory is never touched.
    try {
      const sharedWorktreesParent = path.dirname(worktreesRootForCleanup);
      if (readdirSync(sharedWorktreesParent).length === 0) rmdirSync(sharedWorktreesParent);
    } catch {
      // Already gone, never existed, or genuinely non-empty -- skip silently either way.
    }
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
