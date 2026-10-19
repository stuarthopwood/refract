#!/usr/bin/env node
// Live CDP check for issue #997 (notices and refusal toasts gate follow-ups from #996/#938):
//
//   1. `notify.ts`'s `unknown-command`/`unsupported-arguments` branches (`src/renderer/state/
//      notify.ts`): a slash-command refusal is `toast.warning(...)` (the warning icon,
//      `data-type="warning"`), not `toast.error`, carries a close button, never auto-dismisses
//      on its own timer, and dedupes to exactly one toast via a fixed `id` across repeated
//      refusals -- asserted by sending `/zzznotarealcommand997` (genuinely unknown against the
//      fake omp's own `available_commands_update`, which lists only `new`/`tools`) TWICE,
//      confirming nothing was sent, confirming exactly one toast exists after the second send,
//      then waiting past Sonner's own 4000ms `TOAST_LIFETIME` default (`node_modules/sonner/
//      dist/index.mjs`'s own `remainingTime`/`startTimer`: only `duration === Infinity` skips
//      the close timer) and confirming the SAME toast is still mounted and not mid-removal --
//      backed by THREE independently real signals (`document.visibilityState`, the toast's own
//      `data-expanded`, and focus never silently inside the toaster), not merely sonner's own
//      internal `data-visible` CSS-animation-state flag (gate round 1, Test: gate round 0 wrongly
//      equated that flag with real visibility). Gate round 1 also asserts the close button is
//      reached by a REAL bounded Tab sequence, shows a genuine `:focus-visible` ring, and that
//      Enter on it dismisses the toast; and that a fresh refusal is separately dismissed by
//      typing a character into the draft (`MessageInput.tsx`'s real onChange keystroke path).
//   2. `NoticeRow.tsx`'s `NOTICE_CLASS` now reads `text-severity-warning`/`text-severity-error`
//      (not the old `text-state-needs-you`/`text-destructive` aliases) -- asserted by rendering
//      one short warning and one short error `notice` frame (the new `997-notice-severity.jsonl`
//      fixture, deterministic, no dependence on a real model choosing to emit either), then
//      comparing each row's own summary span computed `color` against a scratch probe element
//      styled with `color: var(--severity-warning)`/`var(--severity-error)`, AND asserting the
//      span's own classList names the new token and no longer carries the old one (gate round 1,
//      Test: colour-value equality alone cannot distinguish the fix from a deliberately
//      reinstated old class that happens to alias the same value), across EVERY one of the five
//      built-in theme presets (`src/shared/themes.ts`), not just the two-theme Dark/Obsidian
//      convention other scripts use for "light vs dark" -- these severity values genuinely
//      differ per preset (`globals.css`), so "each preset" is checked literally.
//   3. `CollapsedLine.tsx`'s short-summary wrap branch now carries `[overflow-wrap:anywhere]`
//      (not `break-words`) -- asserted by a computed-style check (`overflowWrap: 'anywhere'`) on
//      the warning notice's own summary span (`summaryWrap` is always on for a short NoticeRow).
//
// Modelled on `verify-980-toast-send.mjs`'s own toast-identification pattern (tag every toast
// already on screen before triggering, then poll for the one UNTAGGED toast -- Sonner PREPENDS
// new toasts, so a stale one is never mistaken for this run's own) and
// `verify-917-advisor-command.mjs`/`verify-947-938-helpers.mjs`'s own `NoticeRow` sr-only-label
// finder (survives `react-virtuoso` windowing; the two-parent climb reaches either the plain-div
// short-notice or the `CollapsibleTrigger`-button long-notice container either way).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-997';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_997_SHOTS_DIR || path.join(tmpdir(), 'refract-997-notice-severity-shots');

// Every built-in preset (`src/shared/themes.ts`): the severity tokens genuinely differ per
// preset (`globals.css`'s own `.theme-*` blocks), so this check is NOT the Dark/Obsidian
// "light vs dark" stand-in convention other scripts use -- it covers all five literally.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const UNKNOWN_COMMAND = '/zzznotarealcommand997';
// Sonner's own documented ~4s auto-dismiss (`node_modules/sonner/dist/index.mjs`'s own
// `TOAST_LIFETIME = 4000`); waiting comfortably past it is what actually proves
// `duration: Infinity` (not a lucky slow poll) kept this one toast alive.
const PAST_DEFAULT_LIFETIME_MS = 5_500;
const TOAST_SEEN_ATTR = 'data-997-seen';

// Same two-parent-climb `NoticeRow` finder `verify-917-advisor-command.mjs`/
// `verify-947-938-helpers.mjs`/`verify-938-slash-rest.mjs` all use, parameterised on the sr-only
// level label so it can find a Warning or an Error row, not only Info.
function noticeFinder(levelLabel) {
  return `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === ${JSON.stringify(levelLabel)}).map((el) => el.parentElement?.parentElement).filter(Boolean)`;
}

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-997-notice-severity-shots', [
    ...THEMES.map((t) => `notices-${t.id}.png`),
    'toast-warning.png',
    'toast-close-button.png',
    'report.json'
  ]);

  const report = [];
  const notExercised = [];

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertTrue(actual, label, extra) {
    const ok = actual === true;
    report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  // Each severity's own summary span's computed `color`, read alongside `overflowWrap` in one
  // evaluate call, then compared against `resolveCssVarColor`'s own probe (`verify-tauri-cdp.mjs`
  // -- already the established way other scripts, e.g. `verify-927-928-quiet-composer.mjs`,
  // resolve a CSS custom property that is `oklch(...)` in some presets and a hex literal or
  // `var(--state-*)` alias in others to the SAME computed `rgb(...)` string a class-driven
  // colour resolves to).
  async function readNoticeStyle(cdp, levelLabel) {
    return cdp.evaluate(`(() => {
      const rows = (${noticeFinder(levelLabel)});
      const row = rows[rows.length - 1];
      const span = row?.querySelector(':scope > span.min-w-0.flex-1');
      if (!span) return null;
      const style = getComputedStyle(span);
      return { color: style.color, overflowWrap: style.overflowWrap, className: span.className, text: (span.textContent ?? '').trim() };
    })()`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-997-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-997-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-997-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-997-notice-severity');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-997-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-997-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-997-shim-'));

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
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    // Real UI flow (mirrors verify-980-toast-send.mjs/verify-938-slash-rest.mjs): readiness, Add
    // repository, New session, wait for the composer against the fake omp's scripted tape.
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
      label: 'Session composer enabled'
    });

    // Drives the fixture's own one scripted turn (997-notice-severity.jsonl): a short warning
    // notice followed by a short error notice, both deterministic.
    await cdp.typeIntoByLabel('Message', 'trigger the scripted notices');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(${noticeFinder('Warning:')}).length > 0`, { timeoutMs: 30_000, label: 'Warning notice rendered' });
    await cdp.waitFor(`(${noticeFinder('Error:')}).length > 0`, { timeoutMs: 15_000, label: 'Error notice rendered' });

    // Per-preset NoticeRow colour + overflow-wrap check, screenshotted every theme.
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const warningProbeColor = await resolveCssVarColor(cdp, '--severity-warning', 'color');
      const warningResult = await readNoticeStyle(cdp, 'Warning:');
      assertTrue(warningResult !== null, `${theme.name}: warning NoticeRow found`);
      assertEqual(warningResult.color, warningProbeColor, `${theme.name}: warning NoticeRow colour equals --severity-warning`);
      assertEqual(warningResult.overflowWrap, 'anywhere', `${theme.name}: warning NoticeRow summary carries overflow-wrap: anywhere`);
      // Gate round 1 (#997, Medium, Test): colour equality alone cannot tell a deliberately
      // reinstated `text-state-needs-you` (same VALUE, wrong NAME, see NoticeRow.tsx's own
      // comment) from the real fix -- the classList itself must name the new token and must
      // NOT still carry the old one.
      assertTrue(warningResult.className.split(' ').includes('text-severity-warning'), `${theme.name}: warning NoticeRow classList contains text-severity-warning`, {
        className: warningResult.className
      });
      assertTrue(!warningResult.className.split(' ').includes('text-state-needs-you'), `${theme.name}: warning NoticeRow classList does not contain the old text-state-needs-you`, {
        className: warningResult.className
      });

      const errorProbeColor = await resolveCssVarColor(cdp, '--severity-error', 'color');
      const errorResult = await readNoticeStyle(cdp, 'Error:');
      assertTrue(errorResult !== null, `${theme.name}: error NoticeRow found`);
      assertEqual(errorResult.color, errorProbeColor, `${theme.name}: error NoticeRow colour equals --severity-error`);
      assertTrue(errorResult.className.split(' ').includes('text-severity-error'), `${theme.name}: error NoticeRow classList contains text-severity-error`, {
        className: errorResult.className
      });
      assertTrue(!errorResult.className.split(' ').includes('text-destructive'), `${theme.name}: error NoticeRow classList does not contain the old text-destructive`, {
        className: errorResult.className
      });

      await cdp.screenshot(path.join(SHOTS_DIR, `notices-${theme.id}.png`));
      report.push({ step: `${theme.name}: screenshot`, ok: true, warningResult, warningProbeColor, errorResult, errorProbeColor });
    }

    // Unknown-command refusal toast: warning icon (data-type="warning"), a close button
    // (`closeButton: true`), does not auto-dismiss on its own timer, dedupes to exactly one
    // toast via its fixed `id` across repeated refusals (`notify.ts`'s
    // `SLASH_COMMAND_REFUSAL_TOAST_ID`), and is dismissed by a successful send or by continuing
    // to type (`MessageInput.tsx`'s `dismissSlashCommandRefusalToast()` call sites). Back to
    // Dark first (the app's own default) so the screenshot matches every other script's own
    // convention of a default-theme evidence shot for the primary assertion.
    await switchTheme(cdp, 'dark', 'Dark');
    const toastSelector = `document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')`;
    await cdp.evaluate(`Array.from(${toastSelector}).forEach((el) => el.setAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}, 'true'))`);
    const messageCountBefore = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length`);
    await cdp.typeIntoByLabel('Message', UNKNOWN_COMMAND);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `!!Array.from(${toastSelector}).find((el) => !el.hasAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}))`,
      { timeoutMs: 15_000, label: 'A fresh, untagged refusal toast mounted' }
    );
    await sleep(400); // CSS slide-in settles before any read below.

    const freshToastExpr = `Array.from(${toastSelector}).find((el) => !el.hasAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}))`;
    const immediateRead = await cdp.evaluate(`(() => {
      const el = ${freshToastExpr};
      if (!el) return null;
      const icon = el.querySelector('[data-icon] svg');
      const closeButton = el.querySelector('[data-close-button]');
      return {
        dataType: el.getAttribute('data-type'),
        text: el.textContent ?? '',
        iconClass: icon ? icon.getAttribute('class') : null,
        mounted: el.getAttribute('data-mounted'),
        dataVisible: el.getAttribute('data-visible'),
        removed: el.getAttribute('data-removed'),
        hasCloseButton: !!closeButton
      };
    })()`);
    assertTrue(immediateRead !== null, 'unknown-command refusal toast: found immediately after send');
    assertEqual(immediateRead.dataType, 'warning', 'unknown-command refusal toast: data-type="warning" (not "error")');
    assertTrue(immediateRead.iconClass !== null && immediateRead.iconClass.includes('triangle-alert'), 'unknown-command refusal toast: carries the warning (triangle-alert) icon, not the error (octagon-x) one', {
      iconClass: immediateRead.iconClass
    });
    assertEqual(immediateRead.mounted, 'true', 'unknown-command refusal toast: data-mounted="true" immediately after send');
    // Gate round 1 (#997, Medium, Test): renamed from "visible" -- `data-visible` is sonner's
    // own internal CSS-animation-state flag (false only mid-exit-transition), not the page's
    // real visibility; the genuinely independent signals (document.visibilityState, focus,
    // data-expanded) are checked separately below, past the default lifetime.
    assertEqual(immediateRead.dataVisible, 'true', `unknown-command refusal toast: sonner's own data-visible="true" immediately after send`);
    assertTrue(immediateRead.hasCloseButton, 'unknown-command refusal toast: carries a close button ([data-close-button])');

    const messageCountAfter = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length`);
    assertEqual(messageCountAfter, messageCountBefore, 'unknown-command refusal: nothing was sent (no new message bubble)');

    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-warning.png'));

    // Gate round 1 (#997, Medium): a SECOND refusal while the first toast is still open must
    // not stack a duplicate -- `notify.ts`'s fixed `id` replaces the one open toast in place
    // (sonner's own in-place-update semantics, the same pattern `ProfileMenu.tsx`'s
    // `UpdateMenuItem` already relies on). A refusal leaves the draft untouched (FR-019), so
    // clicking Send again resends the SAME text with no retyping needed.
    await cdp.clickByLabel('Send message');
    await sleep(400);
    const toastCountAfterSecondSend = await cdp.evaluate(`${toastSelector}.length`);
    assertEqual(toastCountAfterSecondSend, 1, 'unknown-command refusal sent twice: exactly ONE refusal toast exists (deduped by its fixed id), not two stacked');

    // Past Sonner's own 4000ms default lifetime: the SAME toast element (re-found by the
    // `TOAST_SEEN_ATTR`-absence query -- it never carries that tag, so this is unambiguously the
    // one just triggered, not a coincidentally-timed new one) is still mounted and not mid-
    // removal, proving `duration: Infinity` genuinely disabled the auto-dismiss timer rather
    // than this check merely outrunning a slow removal animation. Three independently real
    // signals back `data-mounted` up here: `document.visibilityState` (the actual Page
    // Visibility API, not sonner's own flag), the toast's own `data-expanded` (sonner's hover/
    // stack-expand state -- "visible" must not secretly depend on the mouse hovering the
    // stack), and that focus never silently landed inside the toaster (nothing in this flow has
    // focused it yet).
    await sleep(PAST_DEFAULT_LIFETIME_MS);
    const pastLifetimeRead = await cdp.evaluate(`(() => {
      const el = ${freshToastExpr};
      if (!el) return null;
      return {
        mounted: el.getAttribute('data-mounted'),
        dataVisible: el.getAttribute('data-visible'),
        removed: el.getAttribute('data-removed'),
        dataExpanded: el.getAttribute('data-expanded'),
        pageVisibilityState: document.visibilityState,
        focusInsideToaster: !!(document.activeElement && document.activeElement.closest('[data-sonner-toaster]'))
      };
    })()`);
    assertTrue(pastLifetimeRead !== null, `unknown-command refusal toast: still present ${PAST_DEFAULT_LIFETIME_MS}ms after send (past Sonner's 4000ms default lifetime)`);
    assertEqual(pastLifetimeRead.mounted, 'true', `unknown-command refusal toast: still data-mounted="true" ${PAST_DEFAULT_LIFETIME_MS}ms later`);
    assertEqual(pastLifetimeRead.dataVisible, 'true', `unknown-command refusal toast: still sonner's own data-visible="true" ${PAST_DEFAULT_LIFETIME_MS}ms later`);
    assertTrue(pastLifetimeRead.removed !== 'true', `unknown-command refusal toast: not mid-removal ${PAST_DEFAULT_LIFETIME_MS}ms later`);
    assertEqual(pastLifetimeRead.pageVisibilityState, 'visible', `unknown-command refusal toast: the real page document.visibilityState is "visible" ${PAST_DEFAULT_LIFETIME_MS}ms later (not merely sonner's own internal flag)`);
    assertTrue(pastLifetimeRead.dataExpanded !== 'true', `unknown-command refusal toast: data-expanded is not "true" ${PAST_DEFAULT_LIFETIME_MS}ms later (genuinely still on screen, not an artifact of the hover-expanded stack state)`);
    assertTrue(!pastLifetimeRead.focusInsideToaster, `unknown-command refusal toast: focus has not silently landed inside the toaster ${PAST_DEFAULT_LIFETIME_MS}ms later`);

    // Gate round 1 (#997, Medium, Test): Tab to the close button with REAL Tab presses (bounded,
    // never a direct `.focus()` call, which would prove nothing about the real keyboard route),
    // assert a genuine `:focus-visible` ring (not merely `:focus`, which Chromium also sets on a
    // mouse-driven focus), press Enter, and assert the toast is actually gone.
    const closeButtonExpr = `(${freshToastExpr})?.querySelector('[data-close-button]')`;
    await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.focus()`);
    let reachedCloseButton = false;
    const CLOSE_BUTTON_TAB_CAP = 10;
    for (let i = 0; i < CLOSE_BUTTON_TAB_CAP && !reachedCloseButton; i++) {
      await pressTab(cdp);
      reachedCloseButton = await cdp.evaluate(`document.activeElement === (${closeButtonExpr})`);
    }
    assertTrue(reachedCloseButton, `unknown-command refusal toast: a real Tab sequence (bounded at ${CLOSE_BUTTON_TAB_CAP}) reaches the close button`);
    const closeButtonFocusVisible = await cdp.evaluate(`(${closeButtonExpr})?.matches(':focus-visible') ?? false`);
    assertTrue(closeButtonFocusVisible, 'unknown-command refusal toast: the close button shows a real :focus-visible ring via real keyboard Tab');
    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-close-button.png'));
    await cdp.pressEnter();
    await cdp.waitFor(`${toastSelector}.length === 0`, { timeoutMs: 10_000, label: 'Enter on the focused close button dismisses the toast' });
    // Falsified live (first run): sending again right after this `waitFor` raced sonner's own
    // internals -- `deleteToast()` sets `data-removed="true"` (what the `waitFor` above checks)
    // IMMEDIATELY on click, but the real `ToastState.dismiss(id)` call that registers this id as
    // genuinely closed (so a same-id `create()` takes the fresh-toast branch, confirmed by
    // reading `node_modules/sonner/dist/index.mjs`'s own `create`/`dismiss`/`removeToast`) only
    // fires `TIME_BEFORE_UNMOUNT` (200ms) later, from `removeToast`'s own `setTimeout`. Resending
    // inside that window hits the `alreadyExists` update branch, not a fresh mount. Waiting
    // comfortably past 200ms (not a guess -- the exact constant this library documents and uses
    // for its own exit-animation timer) avoids the race without touching any production code.
    await sleep(400);
    // Gate round 1 (#997, Medium, Test): a fresh refusal, then typing a single character into
    // the draft (the real onChange keystroke path, `MessageInput.tsx`) dismisses it -- `notify.
    // ts`'s dismiss helper is a no-op when nothing is open, so this also proves it costs nothing
    // extra to call on every keystroke.
    await cdp.evaluate(`Array.from(${toastSelector}).forEach((el) => el.setAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}, 'true'))`);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `!!Array.from(${toastSelector}).find((el) => !el.hasAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}))`,
      { timeoutMs: 15_000, label: 'A fresh refusal toast mounted again (third send)' }
    );
    await sleep(400);
    await cdp.typeIntoByLabel('Message', 'x');
    await cdp.waitFor(`${toastSelector}.length === 0`, { timeoutMs: 10_000, label: 'Typing a character into the draft dismisses the open refusal toast' });

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `notices-${t.id}.png`), 'toast-warning.png', 'toast-close-button.png'])
    });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2)
      );
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
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
