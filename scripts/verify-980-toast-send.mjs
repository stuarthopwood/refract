#!/usr/bin/env node
// Live CDP check for issue #980 (toasts covering the composer's Send button). `<Toaster />`
// (`src/renderer/components/ui/sonner.tsx`) ships `position="bottom-center"` with a bottom
// offset tracking the tallest mounted composer's own measured CLEARANCE to the viewport bottom
// (`src/renderer/features/chat/composerHeightVar.ts`, a `ResizeObserver` per `MessageInput`
// instance plus a window-resize listener), decided (Skippy, delegated by Stuart 2026-10-18,
// ui-architect-v3 ruling) over `top-right`/`bottom-right` because both of those sit adjacent to
// the permanent full-height right rail (`IconRail.tsx`) and, for `bottom-right`, directly over
// the Send button itself. Gate round 1 fix (High): the offset is DYNAMIC, not a fixed guess --
// this script proves that across a resting composer, a composer grown to its max height,
// split-pane mode (two independently-sized composers, two Send buttons), and Sonner's own
// `@media (max-width:600px)` mobile breakpoint (`mobileOffset`). Gate round 2 fix (Medium):
// clearance, not height alone -- `StatusBar.tsx` (36px) renders BELOW the whole chat workspace,
// so a composer's own bottom edge never touches the window's bottom edge; also fixed the
// ≤600px case overlapping the right rail (Sonner's own mobile CSS makes the toast viewport-wide
// minus `2 * mobileOffset.left`, so `mobileOffset` now also carries `left`/`right` insets).
//
// Modelled on `verify-926-attach-any-file.mjs`'s own session-setup flow (readiness -> Add
// repository -> New session -> composer enabled) and its own D1 toast trigger: typing the
// literal `[[refract-attachments]]` marker is a purely client-side refusal (`MessageInput.tsx`)
// with no agent round trip needed, calling a plain `toast.error(...)` with no `duration`
// override -- gate round 2 correction (Low): this toast DOES auto-dismiss on Sonner's own
// default ~4s lifetime (confirmed in `node_modules/sonner`'s own source: only SOME other
// `toast.error` call sites in this codebase pass `{duration: Infinity}`, this one does not), so
// each check below tags every toast already on screen, triggers a fresh one, and identifies it
// as the one UNTAGGED toast that is genuinely mounted, visible and not mid-removal (Sonner
// PREPENDS new toasts, `dist/index.mjs`: `return [toast, ...toasts]`, so DOM order places the
// newest FIRST, not last -- a plain count or `.pop()` could silently check a stale toast once
// more than one is mounted at once) -- never assuming the FIRST trigger's own toast is still
// the one on screen moments later. This is the EXACT toast `verify-926-attach-any-file.mjs`
// itself flagged in a DIAG comment as covering Send under the OLD `bottom-right` default
// (predating #926, filed from that finding as #980, `docs/PLAN.md` "Toast covers Send" row).
//
// STATED LIMITATION (lane gate checklist: "never claim a test that did not happen"): no built-in
// light theme exists in this app (`sonner.tsx`'s own doc comment: "every built-in Refract theme
// is dark-toned ... none is planned") -- the two-theme screenshot requirement is satisfied with
// Dark and Obsidian (the two visually distinct built-in presets), not a literal "light" theme,
// which this product does not have. The narrow-window check uses CDP's own
// `Emulation.setDeviceMetricsOverride` (the standard way to drive a different viewport through
// CDP) rather than an OS-level window resize, which this harness exposes no control for.

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

// Dark is the app's own default theme; Obsidian is the second built-in preset -- see this
// script's own header for why neither is a literal "light" theme (none exists).
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

const MARKER = '[[refract-attachments]]';
// Padded with enough blank lines to push a textarea past its `max-h-48` (192px) cap --
// `handleSend`'s own refusal is a plain `message.includes(FILE_ATTACHMENTS_MARKER)` substring
// check (`anyFileAttachments.ts`), so the marker still trips it regardless of surrounding text.
const TALL_MARKER_TEXT = `${'line\n'.repeat(25)}${MARKER}`;
// Marks a toast as "already accounted for" before each fresh trigger (gate round 2 fix, High):
// Sonner PREPENDS new toasts (`node_modules/sonner`'s own `dist/index.mjs`: `return [toast,
// ...toasts]`), so the newest one is FIRST in DOM order, not last -- this attribute, not a count
// or `.pop()`, is what identifies which exact toast each check below is about.
const TOAST_SEEN_ATTR = 'data-980-seen';
// The OUTER composer wrapper `composerClearanceRef` (MessageInput.tsx) is actually attached to --
// NOT the inner `.border-composer-border` box nested inside it, which gate round 2 (High, Test)
// found this script was wrongly measuring/overlap-checking instead. No stable attribute exists
// on this div today; matched by its own distinctive Tailwind class combination.
const COMPOSER_ROOT_SELECTOR = '.flex.shrink-0.flex-col.gap-2.border-t.border-divider.px-4.py-3';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

// One evaluate call computing every geometry fact this script needs, across however many
// composers/Send buttons are currently mounted (1 in single-pane, 2 in split mode): the ONE
// toast this run just triggered (identified by `TOAST_SEEN_ATTR`'s absence, genuinely mounted,
// visible and not mid-removal -- never a stale toast from an earlier check, see this script's
// own header for why Sonner's prepend order rules out a plain count or `.pop()`), its own rect
// against the title-bar window-controls corner (`App.tsx`'s top `drag-region` strip's own
// `no-drag-region` child), the permanent right rail (`IconRail.tsx`, selected via its own
// `role="toolbar"` toolbar's parent so the rail's full height counts, not just its button
// column), every composer's own OUTER root (`COMPOSER_ROOT_SELECTOR`, the actual element
// `composerClearanceRef` measures -- gate round 2 fix, not the inner `.border-composer-border`
// box), and the Session list's own merged top header row. Also re-proves every Send button's
// own hit-test (`document.elementFromPoint` at its centre resolves to itself, never an
// intercepting toast) and that Sonner's own live region (the `<section aria-live="polite">`
// ancestor Sonner itself renders around the toast list, never the inner
// `<ol data-sonner-toaster>`, which carries no aria-live attribute of its own) is intact.
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

// Real Ctrl+click (`Input.dispatchMouseEvent` modifiers bitmask: Ctrl = 2) on a Session row's own
// open button (`data-session-open`, `SessionRow.tsx`) -- the exact DOM node and modifier
// combination `onClick`'s own `event.ctrlKey` branch checks, calling the real
// `openInSplit(session.id)`, not a direct store call. A local copy of the same real technique the
// (unmerged) `feat/672-start-message` branch's own `verify-672-start-message-helpers.mjs` uses --
// that branch is not yet on `origin/main`, so its file cannot be imported from here.
async function ctrlClickSessionRow(cdp, sessionId) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`ctrlClickSessionRow(${sessionId}): no [data-session-open] row found.`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 2 });
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

  // Types `extraText` (defaults to the bare marker) into the FIRST `[aria-label="Message"]`
  // found in DOM order (pane 0 in split mode) and clicks the FIRST `[aria-label="Send message"]`
  // -- both belong to the same pane, since each ChatPane renders its own header/transcript/
  // composer fully before the next one starts. Gate round 2 fix (High): tags every toast
  // already on screen with `TOAST_SEEN_ATTR` BEFORE triggering (never a count comparison --
  // Sonner prepends new toasts, so a stale one could sit at any index once more than one is
  // mounted), then waits for the one UNTAGGED toast that is genuinely mounted, visible, not
  // mid-removal, and carries this run's own marker-refusal text, then ~400ms more for the CSS
  // slide-in transition to settle before any hit-test runs.
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
    // session (Session A), wait for the composer to enable against the fake omp's scripted tape.
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

    // Initial trigger: also proves the refusal genuinely sent nothing (D1, verify-926's own check).
    await triggerMarkerToast(cdp);
    const d1NothingSent = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length === 0`);
    assertEqual(d1NothingSent, true, 'nothing was sent (this is a genuine refusal toast, not a send-success one)');

    // Dark (the app's own default) first, then Obsidian -- resting composer height each time.
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await triggerMarkerToast(cdp);
      const r = await assertChromeClear(cdp, `${theme.name} theme`, 1);
      await cdp.screenshot(path.join(SHOTS_DIR, `toast-${theme.id}.png`));
      report.push({ step: `${theme.name} theme: toast clear of every fixed chrome element`, ok: true, geometry: r });
    }

    // Tall composer (gate round 1 fix, High): the textarea padded past its own `max-h-48` cap
    // (handleSend's refusal leaves the draft untouched, so the tall text survives the trigger),
    // proving the offset is read from the LIVE measured clearance, not the old fixed guess --
    // compares against a RESTING measurement taken just before (gate round 2 fix: a fixed
    // numeric threshold doesn't generalise across whatever sits below the composer), and that
    // the published `--refract-composer-clearance` CSS var matches what was actually measured.
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

    // Narrow (<=600px) window: CDP viewport override (see this script's own header for why not
    // an OS-level resize) crossing Sonner's own `@media (max-width:600px)` breakpoint, which
    // switches `bottom` positioning onto `--mobile-offset-bottom` -- proving `mobileOffset`
    // carries the same live clearance, not Sonner's bare 16px mobile floor, AND (gate round 2
    // fix, High) that its own `left`/`right` insets keep the now-full-width toast off the right
    // rail too (`assertChromeClear`'s `overlapsRail` check, already run for every pass).

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 700, deviceScaleFactor: 1, mobile: false });
    await triggerMarkerToast(cdp);
    const narrowResult = await assertChromeClear(cdp, 'narrow (<=600px) window', 1);
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-narrow.png'));
    report.push({ step: 'narrow (<=600px) window: toast clear, mobileOffset applied', ok: true, geometry: narrowResult });
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    // Split pane: Session B quick-created (replaces the front pane), then a real Ctrl+click on
    // Session A's own row reopens it alongside B (`openInSplit`, the same production path a
    // user's own Ctrl+click takes) -- two independently-sized composers, two Send buttons.
    await cdp.click(`document.querySelector('[data-quick-create-session]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 30_000,
      label: 'Session B composer enabled'
    });
    await ctrlClickSessionRow(cdp, sessionAId);
    await cdp.waitFor(`document.querySelectorAll('[aria-label="Message"]').length === 2`, { timeoutMs: 15_000, label: 'Split open (real Ctrl+click): two composers mounted' });
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
