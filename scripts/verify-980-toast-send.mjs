#!/usr/bin/env node
// Live CDP check for #980: toasts must not cover the composer's Send button, so the Toaster offset
// tracks the live composer clearance (resting, tall, split-pane, <=600px). No built-in light theme exists; Dark and Obsidian stand in.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
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
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-980';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_980_SHOTS_DIR || path.join(tmpdir(), 'refract-980-toast-send-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

const MARKER = '[[refract-attachments]]';
// Padding pushes the textarea past its max-h-48 cap; the marker still trips the substring check.
const TALL_MARKER_TEXT = `${'line\n'.repeat(25)}${MARKER}`;
// Sonner prepends new toasts, so DOM order can't identify the fresh one; tag old toasts instead.
const TOAST_SEEN_ATTR = 'data-980-seen';
// The outer wrapper `composerClearanceRef` measures, not the inner border box; it has no stable attribute, so match its Tailwind classes.
const COMPOSER_ROOT_SELECTOR = '.flex.shrink-0.flex-col.gap-2.border-t.border-divider.px-4.py-3';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

// One evaluate call gathering all geometry: the freshly triggered (untagged) toast against the window-controls corner,
// right rail, composer roots and session header, plus each Send button's hit-test and Sonner's live region
// (the `<section aria-live>` ancestor, not the `<ol>`, which has no aria-live).
const CHROME_CHECK_EXPR = `(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height };
  };
  const intersects = (a, b) => !!a && !!b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  const toast = document.querySelector('[data-sonner-toast][data-mounted="true"][data-visible="true"]:not([data-removed="true"]):not([${TOAST_SEEN_ATTR}="true"])');
  const sends = Array.from(document.querySelectorAll('[aria-label^="Send"]'));
  const titleBarCorner = document.querySelector('.drag-region.fixed.left-0.top-0 .no-drag-region.ml-auto.h-full');
  const railToolbar = document.querySelector('[role="toolbar"][aria-label="Panels"]');
  const railRoot = railToolbar ? railToolbar.parentElement : null;
  const sessionHeader = document.querySelector('nav[aria-label="Sessions"] .drag-region');
  const toasterRoot = document.querySelector('[data-sonner-toaster]');
  const toastRect = rectOf(toast);
  const sendHitTests = sends.map((send) => {
    const r = send.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === send || send.contains(top));
  });
  const composerRects = sends.map((send) => rectOf(send.closest('${COMPOSER_ROOT_SELECTOR}'))).filter(Boolean);
  return {
    hasToast: !!toast,
    sendCount: sends.length,
    everySendIsTopAtItsOwnCentre: sendHitTests.length > 0 && sendHitTests.every(Boolean),
    overlapsTitleBar: intersects(toastRect, rectOf(titleBarCorner)),
    overlapsRail: intersects(toastRect, rectOf(railRoot)),
    overlapsAnyComposer: composerRects.some((c) => intersects(toastRect, c)),
    overlapsSessionHeader: intersects(toastRect, rectOf(sessionHeader)),
    liveRegionPresent: !!toast && !!toast.closest('section[aria-live="polite"]'),
    dataYPosition: toasterRoot ? toasterRoot.getAttribute('data-y-position') : null,
    dataXPosition: toasterRoot ? toasterRoot.getAttribute('data-x-position') : null
  };
})()`;

// Real Ctrl+click (modifiers bit 2, bracketed by Control key events) on a session row's open button, so the genuine `openInSplit` path runs.
async function ctrlClickSessionRow(cdp, sessionId) {
  const info = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]');
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!info.found) throw new Error(`ctrlClickSessionRow(${sessionId}): no [data-session-open] row found.`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1, modifiers: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
}

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

  // Uses the first Message/Send pair (same pane). Tags existing toasts before triggering, waits for the untagged one, then ~400ms for the slide-in to settle.
  async function triggerMarkerToast(cdp, { extraText = MARKER } = {}) {
    await cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-sonner-toast]')).forEach((el) => el.setAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}, 'true'))`
    );
    await cdp.evaluate(
      `(() => { const ta = document.querySelector('[aria-label="Message"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(extraText)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    );
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const el = document.querySelector('[data-sonner-toast][data-mounted="true"][data-visible="true"]:not([data-removed="true"]):not([${TOAST_SEEN_ATTR}="true"])'); return !!el && el.textContent.includes('reserved') && el.textContent.includes('marker'); })()`,
      { timeoutMs: 10_000, label: 'a fresh, untagged, mounted+visible marker-refusal toast appears' }
    );
    await sleep(400);
  }

  async function assertChromeClear(cdp, label, expectedSendCount) {
    const r = await cdp.evaluate(CHROME_CHECK_EXPR);
    assertEqual(r.hasToast, true, `${label}: a fresh marker-refusal toast is on screen`);
    assertEqual(r.sendCount, expectedSendCount, `${label}: exactly ${expectedSendCount} Send button(s) mounted`);
    assertEqual(r.everySendIsTopAtItsOwnCentre, true, `${label}: every Send button's own hit-test resolves to itself, not the toast`);
    assertEqual(r.overlapsTitleBar, false, `${label}: the toast does not overlap the title-bar window-controls corner`);
    assertEqual(r.overlapsRail, false, `${label}: the toast does not overlap the right rail`);
    assertEqual(r.overlapsAnyComposer, false, `${label}: the toast does not overlap any composer`);
    assertEqual(r.overlapsSessionHeader, false, `${label}: the toast does not overlap the Session list header`);
    assertEqual(r.liveRegionPresent, true, `${label}: the toast sits inside Sonner's own aria-live="polite" section`);
    assertEqual(r.dataYPosition, 'bottom', `${label}: Toaster renders data-y-position="bottom"`);
    assertEqual(r.dataXPosition, 'center', `${label}: Toaster renders data-x-position="center"`);
    return r;
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-980-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-980-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-980-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-980-toast-send');
  // "New session from a branch" makes a sibling worktree (#885), cleaned up explicitly in `finally`.
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
        // Unset REFRACT_FAKE_OMP_SCENARIO defaults to 'session'.
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

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
      label: 'Session A composer enabled'
    });
    const sessionsList = await cdp.evaluate(`window.refract.sessions.list()`);
    assertEqual(sessionsList?.ok, true, 'sessions.list() ok');
    assertEqual(sessionsList.value.length, 1, 'exactly one Session exists so far');
    const sessionAId = sessionsList.value[0].id;

    await triggerMarkerToast(cdp);
    const d1NothingSent = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length === 0`);
    assertEqual(d1NothingSent, true, 'nothing was sent (this is a genuine refusal toast, not a send-success one)');

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await triggerMarkerToast(cdp);
      const r = await assertChromeClear(cdp, `${theme.name} theme`, 1);
      await cdp.screenshot(path.join(SHOTS_DIR, `toast-${theme.id}.png`));
      report.push({ step: `${theme.name} theme: toast clear of every fixed chrome element`, ok: true, geometry: r });
    }

    // The refusal leaves the draft intact, so the tall text survives; the offset must follow the live clearance, not a fixed threshold.
    const clearanceExpr = `(() => {
      const send = document.querySelector('[aria-label^="Send"]');
      const composer = send ? send.closest('${COMPOSER_ROOT_SELECTOR}') : null;
      const measured = composer ? window.innerHeight - composer.getBoundingClientRect().top : null;
      const publishedRaw = getComputedStyle(document.documentElement).getPropertyValue('--refract-composer-clearance').trim();
      return { measured, published: publishedRaw ? parseFloat(publishedRaw) : null };
    })()`;
    const restingClearance = await cdp.evaluate(clearanceExpr);
    await triggerMarkerToast(cdp, { extraText: TALL_MARKER_TEXT });
    const tallResult = await assertChromeClear(cdp, 'tall composer', 1);
    const tallClearance = await cdp.evaluate(clearanceExpr);
    assertEqual(
      tallClearance.measured !== null && restingClearance.measured !== null && tallClearance.measured > restingClearance.measured + 50,
      true,
      `tall composer: clearance grew well past resting (resting ${restingClearance.measured}px, tall ${tallClearance.measured}px)`
    );
    assertEqual(
      tallClearance.published !== null && Math.abs(tallClearance.measured - tallClearance.published) <= 2,
      true,
      `tall composer: published --refract-composer-clearance (${tallClearance.published}px) matches the measured clearance (${tallClearance.measured}px) within 2px`
    );
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-tall-composer.png'));
    report.push({ step: 'tall composer: toast clear, offset tracks the live measured clearance', ok: true, geometry: tallResult, restingClearance, tallClearance });

    // Narrow window via CDP viewport override (no OS resize control): Sonner's <=600px breakpoint must carry the live clearance
    // and keep the full-width toast off the right rail via left/right insets.

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 700, deviceScaleFactor: 1, mobile: false });
    await triggerMarkerToast(cdp);
    const narrowResult = await assertChromeClear(cdp, 'narrow (<=600px) window', 1);
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-narrow.png'));
    report.push({ step: 'narrow (<=600px) window: toast clear, mobileOffset applied', ok: true, geometry: narrowResult });
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    // Session B uses the dialog flow: this harness's quick-create "+" does not create a second session.
    // Ctrl+click on Session A then reopens it beside B via the production `openInSplit` path.
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Session B: New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Session B: New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session B composer enabled'
    });
    const sessionsListAfterB = await cdp.evaluate(`window.refract.sessions.list()`);
    assertEqual(sessionsListAfterB?.ok, true, 'sessions.list() ok after creating Session B');
    assertEqual(sessionsListAfterB.value.length, 2, 'exactly two Sessions exist (A and B)');
    await ctrlClickSessionRow(cdp, sessionAId);
    await cdp.waitFor(`document.querySelectorAll('[aria-label="Message"]').length === 2`, {
      timeoutMs: 15_000,
      label: 'Split open (real Ctrl+click): two composers mounted'
    });
    await triggerMarkerToast(cdp, { extraText: TALL_MARKER_TEXT });
    const splitResult = await assertChromeClear(cdp, 'split pane, one composer tall', 2);
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-split-pane.png'));
    report.push({ step: 'split pane: both composers and both Send buttons clear, one composer tall', ok: true, geometry: splitResult });

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [
        ...THEMES.map((t) => `toast-${t.id}.png`),
        'toast-tall-composer.png',
        'toast-narrow.png',
        'toast-split-pane.png'
      ])
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
    // Remove only this exact path, never a wildcard: `rmdirSync` fails on a non-empty dir, so a concurrent run's leftovers survive (#885).
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
