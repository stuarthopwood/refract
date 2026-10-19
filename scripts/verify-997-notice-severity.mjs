#!/usr/bin/env node
// Live CDP check for issue #997 (notices and refusal toasts gate follow-ups from #996/#938):
//
//   1. `notify.ts`'s `unknown-command` branch (`src/renderer/state/notify.ts`): an unknown slash
//      command refuses with `toast.warning(...)` (the warning icon, `data-type="warning"`), not
//      `toast.error`, and never auto-dismisses -- asserted by sending `/zzznotarealcommand997`
//      (genuinely unknown against the fake omp's own `available_commands_update`, which lists
//      only `new`/`tools`), confirming nothing was sent, then waiting past Sonner's own 4000ms
//      `TOAST_LIFETIME` default (`node_modules/sonner/dist/index.mjs`'s own `remainingTime`/
//      `startTimer`: only `duration === Infinity` skips the close timer) and confirming the SAME
//      toast is still mounted, visible and not mid-removal.
//   2. `NoticeRow.tsx`'s `NOTICE_CLASS` now reads `text-severity-warning`/`text-severity-error`
//      (not the old `text-state-needs-you`/`text-destructive` aliases) -- asserted by rendering
//      one short warning and one short error `notice` frame (the new `997-notice-severity.jsonl`
//      fixture, deterministic, no dependence on a real model choosing to emit either), then
//      comparing each row's own summary span computed `color` against a scratch probe element
//      styled with `color: var(--severity-warning)`/`var(--severity-error)`, across EVERY one of
//      the five built-in theme presets (`src/shared/themes.ts`), not just the two-theme Dark/
//      Obsidian convention other scripts use for "light vs dark" -- these severity values
//      genuinely differ per preset (`globals.css`), so "each preset" is checked literally.
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
      return { color: style.color, overflowWrap: style.overflowWrap, text: (span.textContent ?? '').trim() };
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

      const errorProbeColor = await resolveCssVarColor(cdp, '--severity-error', 'color');
      const errorResult = await readNoticeStyle(cdp, 'Error:');
      assertTrue(errorResult !== null, `${theme.name}: error NoticeRow found`);
      assertEqual(errorResult.color, errorProbeColor, `${theme.name}: error NoticeRow colour equals --severity-error`);

      await cdp.screenshot(path.join(SHOTS_DIR, `notices-${theme.id}.png`));
      report.push({ step: `${theme.name}: screenshot`, ok: true, warningResult, warningProbeColor, errorResult, errorProbeColor });
    }

    // Unknown-command refusal toast: warning icon (data-type="warning"), does not auto-dismiss.
    // Back to Dark first (the app's own default) so the screenshot matches every other script's
    // own convention of a default-theme evidence shot for the primary assertion.
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
      return {
        dataType: el.getAttribute('data-type'),
        text: el.textContent ?? '',
        iconClass: icon ? icon.getAttribute('class') : null,
        mounted: el.getAttribute('data-mounted'),
        visible: el.getAttribute('data-visible'),
        removed: el.getAttribute('data-removed')
      };
    })()`);
    assertTrue(immediateRead !== null, 'unknown-command refusal toast: found immediately after send');
    assertEqual(immediateRead.dataType, 'warning', 'unknown-command refusal toast: data-type="warning" (not "error")');
    assertTrue(immediateRead.iconClass !== null && immediateRead.iconClass.includes('triangle-alert'), 'unknown-command refusal toast: carries the warning (triangle-alert) icon, not the error (octagon-x) one', {
      iconClass: immediateRead.iconClass
    });
    assertEqual(immediateRead.mounted, 'true', 'unknown-command refusal toast: mounted immediately after send');
    assertEqual(immediateRead.visible, 'true', 'unknown-command refusal toast: visible immediately after send');

    const messageCountAfter = await cdp.evaluate(`document.querySelectorAll('[data-slot="message"]').length`);
    assertEqual(messageCountAfter, messageCountBefore, 'unknown-command refusal: nothing was sent (no new message bubble)');

    await cdp.screenshot(path.join(SHOTS_DIR, 'toast-warning.png'));

    // Past Sonner's own 4000ms default lifetime: the SAME toast element (re-found by the
    // `TOAST_SEEN_ATTR`-absence query -- it never carries that tag, so this is unambiguously the
    // one just triggered, not a coincidentally-timed new one) is still mounted, visible and not
    // mid-removal, proving `duration: Infinity` genuinely disabled the auto-dismiss timer rather
    // than this check merely outrunning a slow removal animation.
    await sleep(PAST_DEFAULT_LIFETIME_MS);
    const pastLifetimeRead = await cdp.evaluate(`(() => {
      const el = ${freshToastExpr};
      if (!el) return null;
      return { mounted: el.getAttribute('data-mounted'), visible: el.getAttribute('data-visible'), removed: el.getAttribute('data-removed') };
    })()`);
    assertTrue(pastLifetimeRead !== null, `unknown-command refusal toast: still present ${PAST_DEFAULT_LIFETIME_MS}ms after send (past Sonner's 4000ms default lifetime)`);
    assertEqual(pastLifetimeRead.mounted, 'true', `unknown-command refusal toast: still mounted ${PAST_DEFAULT_LIFETIME_MS}ms later`);
    assertEqual(pastLifetimeRead.visible, 'true', `unknown-command refusal toast: still visible ${PAST_DEFAULT_LIFETIME_MS}ms later`);
    assertTrue(pastLifetimeRead.removed !== 'true', `unknown-command refusal toast: not mid-removal ${PAST_DEFAULT_LIFETIME_MS}ms later`);

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `notices-${t.id}.png`), 'toast-warning.png'])
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
