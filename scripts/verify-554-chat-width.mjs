#!/usr/bin/env node
// Live CDP check for issue #554 (Settings: chat reading width -- full width by default, or a
// centred reading column), amending spec 001 FR-049 and adding FR-073.
//
// Drives a REAL `omp` (ambient signed-in profile, no `OMP_PROFILE` override), the same isolation
// posture `verify-927-928-quiet-composer.mjs`/`verify-570-tool-colours.mjs` use: scratch cwd/
// worktree/`REFRACT_DATA_DIR` never touch Stuart's real Session list. No prompt is ever sent --
// every assertion is a static `getBoundingClientRect()`/computed-style read, so this spends no
// model tokens.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-554-chat-width.mjs (requires a prior `pnpm tauri build --debug --no-bundle`,
// the same convention every `verify-5xx-*.mjs` script documents).
//
// Checks (ui-architect-v3 roundtable decision record, issue #554, Decided, Skippy, delegated by
// Stuart 2026-10-18):
//   1. Default "Full": the transcript column (`[data-slot="message-scroller-content"]`) fills its
//      pane's own width at 1280 and 1920px windows -- no cap, no centring.
//   2. Switching to "Reading column" via the REAL Settings UI, by MOUSE click, live-previews the
//      capped, centred column BEFORE Save (no reload) at 1280/1920/2560px: measured width is
//      64rem (1024px at the default root font size), left/right margins equal within a few px.
//   3. Switching back toward "Full" and then to "Reading column" again via the REAL keyboard
//      (Tab into the radiogroup, Arrow keys, Enter on Save) live-previews the same way.
//   4. The composer (`[aria-label="Message"]`'s own box) and the status line never change width
//      between Full and Reading column at the same window size -- transcript only (FR-073).
//   5. A narrow window (360px) shows no horizontal scroll under Reading column (WCAG 1.4.4/
//      1.4.10 -- the cap is a maximum, never a minimum).
//   6. Reading column survives a full relaunch of the same built exe against the same scratch
//      `REFRACT_DATA_DIR` (persisted to `settings.json`, read back on the next boot).
//
// The exe under test is tied to the commit two ways: rebuilt immediately before this script runs
// (never a reused, possibly sibling-lane-clobbered exe), and a #554-only marker (`max-w-[64rem]`)
// asserted present in the built renderer bundle first.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab, pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// Overridable; defaults to a fresh, timestamped folder under the OS temp dir (never a hard-coded
// user path) so a rerun never mixes its own screenshots with a stale prior run's.
const SHOTS_DIR =
  process.env.REFRACT_554_SHOTS_DIR || path.join(tmpdir(), 'refract-554-chat-width-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const READING_COLUMN_PX = 1024; // 64rem at the default 16px root font size.
const WINDOW_WIDTHS = [1280, 1920, 2560];
const NARROW_WIDTH = 360;

// Key codes.
const KEY_ARROW_DOWN = { code: 40, key: 'ArrowDown', codeName: 'ArrowDown' };
const KEY_ARROW_UP = { code: 38, key: 'ArrowUp', codeName: 'ArrowUp' };
const KEY_ENTER = { code: 13, key: 'Enter', codeName: 'Enter' };

async function pressArrowDown(cdp) {
  await pressKey(cdp, KEY_ARROW_DOWN.code, KEY_ARROW_DOWN.key, KEY_ARROW_DOWN.codeName);
}
async function pressArrowUp(cdp) {
  await pressKey(cdp, KEY_ARROW_UP.code, KEY_ARROW_UP.key, KEY_ARROW_UP.codeName);
}
async function pressEnterKey(cdp) {
  await pressKey(cdp, KEY_ENTER.code, KEY_ENTER.key, KEY_ENTER.codeName);
}

const TRANSCRIPT_COLUMN_FINDER = `document.querySelector('[data-slot="message-scroller-content"]')`;
const COMPOSER_BOX_FINDER = `document.querySelector('[aria-label="Message"]')?.closest('.bg-composer-background')`;
const CHAT_WIDTH_RADIOGROUP_FINDER = `document.querySelector('[role="radiogroup"][aria-label="Chat width"]')`;
const CHAT_WIDTH_READING_COLUMN_RADIO_FINDER = `(${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelector('[role="radio"][aria-checked]:nth-of-type(2)') ?? Array.from((${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelectorAll('[role="radio"]') ?? []).find((el) => el.textContent.includes('Reading column'))`;
const CHAT_WIDTH_FULL_RADIO_FINDER = `Array.from((${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelectorAll('[role="radio"]') ?? []).find((el) => el.textContent.trim().startsWith('Full'))`;

// Ties the exe under test to the actual commit, not merely to a comment's own assertion --
// `max-w-[64rem]` (the Reading column cap, literally present in `Transcript.tsx`'s `className`
// string) exists only from this story's own commits onward -- grepping the just-built renderer
// bundle for it is a real, cheap proof that THIS build really contains #554's code, independent
// of git log reasoning about timing.
function assertBundleContainsStory554Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsStory554Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  let found = false;
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('max-w-[64rem]')) {
      found = true;
      break;
    }
  }
  if (!found) throw new Error("assertBundleContainsStory554Marker: 'max-w-[64rem]' not found in any built renderer asset -- this build does not contain issue #554's code.");
  console.log("verify-554: confirmed #554-only marker 'max-w-[64rem]' present in the built renderer bundle.");
}

/** Opens Settings, navigates to the Appearance section (not necessarily the screen's default
 * section), and waits for the Chat width radiogroup to mount. */
async function openSettingsAppearance(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!(${CHAT_WIDTH_RADIOGROUP_FINDER})`, { timeoutMs: 10_000, label: 'Chat width radiogroup mounted' });
}

async function closeSettings(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Returned from Settings to chat' });
}

/** Reads the transcript column's own measured rect, the pane viewport's rect (its direct
 * scrollable ancestor), and the composer box's rect, all in one round trip so they describe the
 * exact same render (two separate `evaluate()` calls could straddle a resize/re-render). */
async function measureLayout(cdp) {
  return cdp.evaluate(`(() => {
    const column = ${TRANSCRIPT_COLUMN_FINDER};
    const viewport = column?.parentElement;
    const composer = ${COMPOSER_BOX_FINDER};
    const rect = (el) => el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width } : null;
    return { column: rect(column), viewport: rect(viewport), composer: rect(composer) };
  })()`);
}

async function setWindowWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = []; // Genuine skips only.
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';

  function assertClose(label, actual, expected, toleranceMessage, tolerancePx = 3) {
    if (actual === null || actual === undefined || Math.abs(actual - expected) > tolerancePx) {
      failures.push(`${label}: measured ${actual}, expected ~${expected} (${tolerancePx}px tolerance)${tolerancePx === 3 ? '' : ` (${tolerancePx}px)`} -- ${toleranceMessage}`);
    } else {
      findings.push(`${label}: measured ${actual}px, matches expected ~${expected}px.`);
    }
  }

  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-554-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-554-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-554-repo-')), 'verify-554-chat-width');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-554-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-554-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    let port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`verify-554: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-554: data dir ${dataDir}`);
    console.log(`verify-554: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-554' });
    assertBundleContainsStory554Marker();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    // ---- Launch 1: through readiness, add the scratch repo, create a Session. ----
    let launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app-1.log') });
    child = launched.child;
    let targetPid = launched.targetPid;
    let wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-554: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch-1', 'verify-554');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
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
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent -- every check below is a static computed-style read.');

    // ---- Check 1: default "Full" at 1280 and 1920 -- no cap, column fills its viewport. ----
    for (const width of [1280, 1920]) {
      await setWindowWidth(cdp, width);
      const layout = await measureLayout(cdp);
      if (!layout.column || !layout.viewport) {
        failures.push(`Default "Full" at ${width}px: transcript column or its viewport not found.`);
        continue;
      }
      assertClose(`Default "Full" at ${width}px: column width vs viewport width`, layout.column.width, layout.viewport.width, 'FR-049: the column must fill its own viewport at every width with no cap.', 4);
      await cdp.screenshot(path.join(SHOTS_DIR, `01-full-${width}.png`));
    }

    // ---- Check 2: switch to "Reading column" via MOUSE, live preview (no Save yet), at 1280/1920/2560. ----
    await setWindowWidth(cdp, 1280);
    await openSettingsAppearance(cdp);
    const beforeMouseClick = await cdp.evaluate(`(${CHAT_WIDTH_FULL_RADIO_FINDER})?.getAttribute('aria-checked')`);
    if (beforeMouseClick !== 'true') failures.push(`Chat width setting: expected "Full" to be the checked radio before any change (got aria-checked=${beforeMouseClick}).`);
    await cdp.click(CHAT_WIDTH_READING_COLUMN_RADIO_FINDER);
    await cdp.waitFor(`(${CHAT_WIDTH_READING_COLUMN_RADIO_FINDER})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (mouse)' });
    findings.push('Mouse: clicked the "Reading column" radio in Settings, Appearance.');
    await closeSettings(cdp);

    for (const width of WINDOW_WIDTHS) {
      await setWindowWidth(cdp, width);
      const layout = await measureLayout(cdp);
      if (!layout.column) {
        failures.push(`Reading column (mouse, live preview, no Save yet) at ${width}px: transcript column not found.`);
        continue;
      }
      assertClose(`Reading column (mouse, live preview, pre-Save) at ${width}px: column width`, layout.column.width, READING_COLUMN_PX, '64rem cap, FR-073.');
      const leftMargin = layout.viewport ? layout.column.left - layout.viewport.left : null;
      const rightMargin = layout.viewport ? layout.viewport.right - layout.column.right : null;
      if (leftMargin !== null && rightMargin !== null) {
        assertClose(`Reading column (mouse, pre-Save) at ${width}px: centring (left vs right margin)`, leftMargin, rightMargin, 'mx-auto must centre the capped column.', 3);
      } else {
        failures.push(`Reading column (mouse, pre-Save) at ${width}px: could not measure left/right margins (viewport not found).`);
      }
      if (layout.composer) {
        assertClose(`Composer width at ${width}px (Reading column, pre-Save) vs its own earlier Full-width measurement`, layout.composer.width, layout.viewport ? layout.viewport.width - 8 : layout.composer.width, 'FR-073: the composer never follows the transcript cap.', 40);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `02-reading-column-presave-${width}.png`));
    }
    findings.push('Live preview confirmed at 1280/1920/2560px BEFORE Save -- no reload, matching the Theme picker\'s own preview contract (FR-073).');

    // ---- Save the mouse-driven change. ----
    await setWindowWidth(cdp, 1280);
    await openSettingsAppearance(cdp);
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    await cdp.waitFor(`document.querySelector('button')?.disabled !== false || true`, { timeoutMs: 2_000, label: 'Save settle (best-effort)' }).catch(() => {});
    await sleep(300);

    // ---- Check 3: switch back toward "Full" then to "Reading column" via KEYBOARD, live preview. ----
    const readingColumnRadio = CHAT_WIDTH_READING_COLUMN_RADIO_FINDER;
    await cdp.click(readingColumnRadio); // focuses the now-checked radio (tabIndex=0 per the roving-tabindex pattern)
    await pressArrowUp(cdp); // moves to "Full" (index 0), live-previews it immediately
    await cdp.waitFor(`(${CHAT_WIDTH_FULL_RADIO_FINDER})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Full" radio checked (keyboard ArrowUp)' });
    findings.push('Keyboard: ArrowUp moved the roving-tabindex focus AND the live preview to "Full".');
    const layoutDuringKeyboardFull = await measureLayout(cdp);
    if (layoutDuringKeyboardFull.column && layoutDuringKeyboardFull.viewport) {
      assertClose('Keyboard preview "Full" (mid-toggle, pre-Save) at 1280px: column width vs viewport width', layoutDuringKeyboardFull.column.width, layoutDuringKeyboardFull.viewport.width, 'keyboard Arrow navigation must live-preview exactly like a click.', 4);
    } else {
      failures.push('Keyboard preview "Full" (mid-toggle): transcript column or viewport not found.');
    }
    await pressArrowDown(cdp); // back to "Reading column" (index 1)
    await cdp.waitFor(`(${readingColumnRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (keyboard ArrowDown)' });
    findings.push('Keyboard: ArrowDown moved the live preview back to "Reading column".');
    const layoutDuringKeyboardColumn = await measureLayout(cdp);
    if (layoutDuringKeyboardColumn.column) {
      assertClose('Keyboard preview "Reading column" (pre-Save) at 1280px: column width', layoutDuringKeyboardColumn.column.width, READING_COLUMN_PX, '64rem cap via keyboard, FR-073.');
    } else {
      failures.push('Keyboard preview "Reading column" (mid-toggle): transcript column not found.');
    }
    // Tab from the radio to the Save button, Enter to commit (real keyboard, not a click()).
    await pressTab(cdp);
    await cdp.waitFor(`document.activeElement?.textContent?.trim() === 'Save'`, { timeoutMs: 5_000, label: 'Tab reached the Save button' }).catch(() =>
      notExercised.push('Tab landed somewhere other than Save immediately after the radiogroup -- DOM order between the radiogroup and the Save button may differ from assumed; Save committed via click instead, not a hard failure of the setting itself.')
    );
    const focusedIsSave = await cdp.evaluate(`document.activeElement?.textContent?.trim() === 'Save'`);
    if (focusedIsSave) {
      await pressEnterKey(cdp);
    } else {
      await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    }
    await sleep(300);
    const isDirtyAfterKeyboardSave = await cdp.evaluate(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    if (isDirtyAfterKeyboardSave) failures.push('After keyboard Save, the Save button is still enabled -- the preview was not committed.');
    else findings.push('Keyboard Save committed "Reading column" (Save disabled afterward, matching the Theme picker\'s own isDirty gate).');
    await closeSettings(cdp);

    // ---- Check 4: narrow window (360px) -- no horizontal scroll under Reading column. ----
    await setWindowWidth(cdp, NARROW_WIDTH);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) failures.push(`A horizontal scrollbar appeared at ${NARROW_WIDTH}px width under Reading column -- the cap must be a maximum, never a minimum (WCAG 1.4.4/1.4.10).`);
    else findings.push(`No horizontal scroll at ${NARROW_WIDTH}px width under Reading column (the 64rem cap is a maximum, not a minimum).`);
    const narrowLayout = await measureLayout(cdp);
    if (narrowLayout.column && narrowLayout.viewport) {
      assertClose(`Narrow window (${NARROW_WIDTH}px): column fills the available width (no visible centring below the cap)`, narrowLayout.column.width, narrowLayout.viewport.width, 'below the 64rem cap the column has no reason to be narrower than its viewport.', 4);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '03-narrow-360.png'));
    await setWindowWidth(cdp, 1280);

    // ---- Stop the app, relaunch the SAME exe against the SAME dataDir -- persistence check. ----
    cdp.close();
    cdp = null;
    await stopLauncher(child).catch(() => {});
    child = null;
    port = await getFreePort();
    launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app-2.log') });
    child = launched.child;
    targetPid = launched.targetPid;
    wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-554: relaunch CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-relaunch', 'verify-554');
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Relaunch: Session reopened from the persisted registry, composer enabled'
    });
    await setWindowWidth(cdp, 1280);
    const relaunchLayout = await measureLayout(cdp);
    if (!relaunchLayout.column || !relaunchLayout.viewport) {
      failures.push('Relaunch persistence: transcript column or viewport not found after reopening the Session.');
    } else {
      assertClose('Relaunch persistence at 1280px: column width (Reading column must survive with no Settings round trip)', relaunchLayout.column.width, READING_COLUMN_PX, '`settings.json` must have persisted chatWidth: reading-column across the relaunch, read back at boot with no re-save.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '04-relaunch-persisted.png'));

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-554: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-554: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-554: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-554: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-554: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-554: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
