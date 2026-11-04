#!/usr/bin/env node
// Live CDP check for #997: refusal toasts are warnings with a close button and no auto-dismiss, notice rows use the severity tokens
// per theme preset, and short notice summaries wrap with overflow-wrap:anywhere.

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

// Severity tokens differ per preset (`globals.css`), so all five presets are checked rather than the Dark/Obsidian stand-in.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const UNKNOWN_COMMAND = '/zzznotarealcommand997';
// Waiting past sonner's 4s `TOAST_LIFETIME` proves `duration: Infinity` kept the toast alive, not a slow poll.
const PAST_DEFAULT_LIFETIME_MS = 5_500;
const TOAST_SEEN_ATTR = 'data-997-seen';

// Finds NoticeRow by its sr-only level label (Warning/Error/Info) via a two-parent climb.
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

  // `resolveCssVarColor` resolves oklch/hex/alias custom properties to the same computed rgb() a class-driven colour yields.
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
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
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

    // Fixture 997-notice-severity.jsonl scripts one turn: a short warning notice, then a short error notice.
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
      // Colour equality alone cannot tell a reinstated `text-state-needs-you` (same value, wrong name) from the fix, so check classList too.
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

    // Icon shape is theme-independent, so it is checked once rather than per preset.
    const errorIconClass = await cdp.evaluate(`(() => {
      const rows = (${noticeFinder('Error:')});
      const row = rows[rows.length - 1];
      const svg = row?.querySelector('svg');
      return svg ? svg.getAttribute('class') : null;
    })()`);
    assertTrue(errorIconClass !== null && errorIconClass.includes('lucide-octagon-alert'), 'error NoticeRow icon is OctagonAlertIcon (lucide-octagon-alert class)', {
      errorIconClass
    });

    // Every refusal gets a fresh toast id and dismisses the previous one: a fixed id could merge into sonner's ~200ms exit animation and never show.
    // Back to Dark first so the screenshot matches the other scripts.
    await switchTheme(cdp, 'dark', 'Dark');
    const toastSelector = `document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')`;
    const freshToastExpr = `Array.from(${toastSelector}).find((el) => !el.hasAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}))`;
    async function tagExistingToasts() {
      await cdp.evaluate(`Array.from(${toastSelector}).forEach((el) => el.setAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}, 'true'))`);
    }

    await tagExistingToasts();
    const messageCountBefore = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length`);
    await cdp.typeIntoByLabel('Message', UNKNOWN_COMMAND);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${freshToastExpr})`, { timeoutMs: 15_000, label: 'A fresh, untagged refusal toast mounted' });
    await sleep(400); // CSS slide-in settles before any read below.

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
    assertEqual(immediateRead.dataVisible, 'true', `unknown-command refusal toast: sonner's own data-visible="true" immediately after send`);
    assertTrue(immediateRead.hasCloseButton, 'unknown-command refusal toast: carries a close button ([data-close-button])');

    const messageCountAfter = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length`);
    assertEqual(messageCountAfter, messageCountBefore, 'unknown-command refusal: nothing was sent (no new message bubble)');

    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-warning.png'));

    // A refusal leaves the draft untouched (FR-019), so Send again resends the same text.
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`${toastSelector}.length === 1`, { timeoutMs: 5_000, label: 'unknown-command refusal sent twice: exactly ONE refusal toast settles on screen' });
    assertEqual(await cdp.evaluate(`${toastSelector}.length`), 1, 'unknown-command refusal sent twice: exactly ONE refusal toast exists (deduped via explicit dismiss-then-create), not two stacked');

    // Page Visibility, `data-expanded` and focus back up `data-mounted` so the check is not just sonner's own flag.
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

    // Real Tab presses, not `.focus()`, and `:focus-visible` rather than `:focus` (Chromium also sets `:focus` on mouse focus).
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

    // Race regression: resending immediately after dismissal used to lose the refusal inside sonner's ~200ms exit animation under the old fixed id.
    await tagExistingToasts();
    await cdp.clickByLabel('Send message');
    await sleep(600);
    const regressionRead = await cdp.evaluate(`(() => {
      const el = ${freshToastExpr};
      if (!el) return null;
      return { mounted: el.getAttribute('data-mounted'), visible: el.getAttribute('data-visible'), removed: el.getAttribute('data-removed') };
    })()`);
    assertTrue(regressionRead !== null, 'race regression check: resending immediately (no wait) right after a close-button dismissal still shows a refusal toast 600ms later');
    assertEqual(regressionRead.mounted, 'true', 'race regression check: the toast is data-mounted="true" 600ms after the immediate resend');
    assertEqual(regressionRead.visible, 'true', 'race regression check: the toast is data-visible="true" 600ms after the immediate resend');
    assertTrue(regressionRead.removed !== 'true', 'race regression check: the toast is not mid-removal 600ms after the immediate resend');

    // Typing in the draft must not dismiss the refusal; only the close button, a successful same-Session send, or a newer refusal does.
    await cdp.typeIntoByLabel('Message', 'x');
    const stillOpenAfterKeystroke = await cdp.evaluate(`(() => {
      const el = ${freshToastExpr};
      if (!el) return null;
      return { mounted: el.getAttribute('data-mounted'), removed: el.getAttribute('data-removed') };
    })()`);
    assertTrue(stillOpenAfterKeystroke !== null, 'typing a character into the refused draft: the refusal toast is STILL mounted (onChange no longer dismisses it)');
    assertEqual(stillOpenAfterKeystroke.mounted, 'true', 'typing a character into the refused draft: still data-mounted="true"');
    assertTrue(stillOpenAfterKeystroke.removed !== 'true', 'typing a character into the refused draft: not mid-removal');

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
