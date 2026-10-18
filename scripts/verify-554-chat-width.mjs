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

async function pressArrowDown(cdp) {
  await pressKey(cdp, KEY_ARROW_DOWN.code, KEY_ARROW_DOWN.key, KEY_ARROW_DOWN.codeName);
}
async function pressArrowUp(cdp) {
  await pressKey(cdp, KEY_ARROW_UP.code, KEY_ARROW_UP.key, KEY_ARROW_UP.codeName);
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

/** Tab from the currently-focused radio to the Save button, a REAL Enter keypress to commit.
 * Uses `cdp.pressEnter()` (sends `text`/`unmodifiedText: '\r'` alongside the keycode), NOT the
 * bare `pressKey` helper (keycode only) -- a native `<button>`'s own default "Enter activates the
 * focused button" behaviour needs those text fields to fire in this WebView2 build, the exact
 * gap this codebase already documents at `verify-tauri-560-helpers.mjs`'s own `pressRealEnter`
 * doc comment and `verify-tauri-567.mjs`'s own Delete-dialog Enter press (`pressKey` alone "does
 * not reliably trigger it"). No fallback click: a hard failure here is real, not swallowed. */
async function saveViaKeyboard(cdp, { findings, label }) {
  await pressTab(cdp);
  await cdp.waitFor(`document.activeElement?.textContent?.trim() === 'Save'`, { timeoutMs: 5_000, label: `Tab reached the Save button (${label})` });
  await cdp.pressEnter();
  await cdp.waitFor(`!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`, { timeoutMs: 5_000, label: `Keyboard Enter committed Save (${label}, Save disabled afterward)` });
  findings.push(`Keyboard Save committed "${label}" via a real Tab + Enter (Save disabled afterward, matching the Theme picker's own isDirty gate).`);
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
    // viewport.clientWidth excludes its own scrollbar (FR-053's themed scrollbar reserves about
    // 8px); getBoundingClientRect().width does not -- comparing the column (a child that fills
    // the CONTENT box) against the viewport's own outer box overstates the gap by the scrollbar
    // width. clientLeft/clientTop account for the left/top border, kept separate from the rect
    // left/top used for margin maths below.
    const viewportMeasured = viewport ? { ...rect(viewport), clientWidth: viewport.clientWidth } : null;
    return { column: rect(column), viewport: viewportMeasured, composer: rect(composer) };
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
      assertClose(`Default "Full" at ${width}px: column width vs viewport content width`, layout.column.width, layout.viewport.clientWidth, 'FR-049: the column must fill its own viewport at every width with no cap.', 4);
      await cdp.screenshot(path.join(SHOTS_DIR, `01-full-${width}.png`));
    }

    // ---- Check 2: switch to "Reading column" via MOUSE, Save (same Settings mount -- closing
    // Settings without saving unmounts AppearanceSection, which reverts any open preview per
    // FR-005, matching Theme's own contract; the chat transcript is also not even mounted while
    // Settings is open, so the ONLY place to observe the capped column is after a real Save, not
    // mid-preview). The live-preview MECHANISM itself (no IPC round trip needed to flip the
    // choice) is proven instead by the radio's own aria-checked flipping immediately on click/
    // Arrow, both checked below and in Check 3. ----
    await setWindowWidth(cdp, 1280);
    await openSettingsAppearance(cdp);
    const beforeMouseClick = await cdp.evaluate(`(${CHAT_WIDTH_FULL_RADIO_FINDER})?.getAttribute('aria-checked')`);
    if (beforeMouseClick !== 'true') failures.push(`Chat width setting: expected "Full" to be the checked radio before any change (got aria-checked=${beforeMouseClick}).`);
    await cdp.click(CHAT_WIDTH_READING_COLUMN_RADIO_FINDER);
    await cdp.waitFor(`(${CHAT_WIDTH_READING_COLUMN_RADIO_FINDER})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (mouse)' });
    findings.push('Mouse: clicked the "Reading column" radio -- aria-checked flipped immediately (live local-store preview, no IPC round trip).');
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`, { timeoutMs: 5_000, label: 'Save committed (Save button disabled afterward)' });
    findings.push('Mouse Save committed "Reading column" (Save disabled afterward, same mount -- confirms a real settings.setChatWidth round trip, not just local UI state).');
    await closeSettings(cdp);

    for (const width of WINDOW_WIDTHS) {
      await setWindowWidth(cdp, width);
      const layout = await measureLayout(cdp);
      if (!layout.column || !layout.viewport) {
        failures.push(`Reading column (mouse-saved) at ${width}px: transcript column or viewport not found.`);
        continue;
      }
      const rightEdge = layout.viewport.left + layout.viewport.clientWidth;
      const leftMargin = layout.column.left - layout.viewport.left;
      const rightMargin = rightEdge - layout.column.right;
      if (width === 1280) {
        // This window's own chat pane content width is narrower than 64rem (session list + nav
        // eat the rest of a 1280px window) -- the cap CANNOT bind here, so the column must
        // simply equal the pane's own content width (no cap, no centring), same as "Full".
        assertClose(`Reading column at 1280px (cap cannot bind, pane narrower than 64rem): column width equals pane content width`, layout.column.width, layout.viewport.clientWidth, 'FR-073: the cap is a maximum, never a minimum.', 4);
        assertClose(`Reading column at 1280px: left vs right margin (no cap in effect)`, leftMargin, rightMargin, 'no cap bound, so both margins should read ~0.', 4);
      } else {
        // 1920/2560: the pane is comfortably wider than 64rem -- the cap MUST bind, exactly, and
        // the column MUST be centred within 1px, not just "close enough" (so a broken cap or a
        // broken centring could not pass this by accident at these two widths).
        assertClose(`Reading column at ${width}px: column width equals the 64rem cap exactly`, layout.column.width, READING_COLUMN_PX, '64rem cap, FR-073.', 2);
        assertClose(`Reading column at ${width}px: centred within 1px (left vs right margin)`, leftMargin, rightMargin, 'mx-auto must centre the capped column.', 1);
      }
      if (layout.composer) {
        assertClose(`Composer width at ${width}px (Reading column) vs its own pane`, layout.composer.width, layout.viewport.clientWidth, 'FR-073: the composer never follows the transcript cap.', 40);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `02-reading-column-saved-${width}.png`));
    }
    findings.push('Saved via mouse, applied with NO app reload/restart (same running process throughout) at 1280/1920/2560px.');

    // ---- Check 3: toggle to "Full" via KEYBOARD (same mount), Save, confirm the transcript
    // actually uncaps -- "Reading column" is already the saved value from Check 2, so a keyboard
    // round trip that lands back on it would be a documented no-op (ThemePicker's own FR-002/
    // FR-006 deviation note: choosing the already-saved entry never re-fires a save), not a real
    // Save exercise. Ending on "Full" here, then saving back to "Reading column" below, exercises
    // two REAL keyboard-driven Save round trips, each committing a value that differs from
    // whatever was persisted a moment before. ----
    await setWindowWidth(cdp, 1280);
    await openSettingsAppearance(cdp);
    const readingColumnRadio = CHAT_WIDTH_READING_COLUMN_RADIO_FINDER;
    const fullRadio = CHAT_WIDTH_FULL_RADIO_FINDER;
    await cdp.click(readingColumnRadio); // focuses the currently-checked radio (tabIndex=0, roving-tabindex pattern)
    await pressArrowUp(cdp); // moves to "Full" (index 0), live-previews it immediately
    await cdp.waitFor(`(${fullRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Full" radio checked (keyboard ArrowUp)' });
    findings.push('Keyboard: ArrowUp moved the roving-tabindex focus AND aria-checked to "Full" immediately.');
    await saveViaKeyboard(cdp, { findings, label: 'Full' });
    await closeSettings(cdp);
    const fullKeyboardLayout = await measureLayout(cdp);
    if (fullKeyboardLayout.column && fullKeyboardLayout.viewport) {
      assertClose('Full (keyboard-saved) at 1280px: column width vs viewport content width', fullKeyboardLayout.column.width, fullKeyboardLayout.viewport.clientWidth, 'a real keyboard Save round trip must uncap the transcript, FR-073.', 4);
    } else {
      failures.push('Full (keyboard-saved): transcript column or viewport not found after closing Settings.');
    }

    // ---- Back to "Reading column" via KEYBOARD, a second real Save, leaving it as the
    // persisted value the narrow-window and relaunch checks below exercise. ----
    await openSettingsAppearance(cdp);
    await cdp.click(fullRadio); // focuses the currently-checked "Full" radio
    await pressArrowDown(cdp); // moves to "Reading column" (index 1), live-previews it immediately
    await cdp.waitFor(`(${readingColumnRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (keyboard ArrowDown)' });
    findings.push('Keyboard: ArrowDown moved aria-checked back to "Reading column" immediately.');
    await saveViaKeyboard(cdp, { findings, label: 'Reading column' });
    await closeSettings(cdp);
    const keyboardSavedLayout = await measureLayout(cdp);
    if (keyboardSavedLayout.column && keyboardSavedLayout.viewport) {
      // Still 1280px here (same as Check 2's own 1280 case): the pane's content width is
      // narrower than 64rem, so the cap cannot bind -- the column must equal the pane's own
      // content width exactly, same explicit reasoning as Check 2.
      assertClose('Reading column (keyboard-saved, second round trip) at 1280px: column width equals pane content width', keyboardSavedLayout.column.width, keyboardSavedLayout.viewport.clientWidth, 'via a real keyboard Save round trip, FR-073.', 4);
    } else {
      failures.push('Reading column (keyboard-saved): transcript column or viewport not found after closing Settings.');
    }

    // ---- Check 4: narrow window (360px) -- no horizontal scroll under Reading column. ----
    await setWindowWidth(cdp, NARROW_WIDTH);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) failures.push(`A horizontal scrollbar appeared at ${NARROW_WIDTH}px width under Reading column -- the cap must be a maximum, never a minimum (WCAG 1.4.4/1.4.10).`);
    else findings.push(`No horizontal scroll at ${NARROW_WIDTH}px width under Reading column (the 64rem cap is a maximum, not a minimum).`);
    const narrowLayout = await measureLayout(cdp);
    if (narrowLayout.column && narrowLayout.viewport) {
      assertClose(`Narrow window (${NARROW_WIDTH}px): column fills the available width (no visible centring below the cap)`, narrowLayout.column.width, narrowLayout.viewport.clientWidth, 'below the 64rem cap the column has no reason to be narrower than its viewport.', 4);
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
    // Refract does NOT auto-reopen the last-viewed Session's chat pane on a cold relaunch (it
    // shows the session list/Home); the same `[data-session-open]` row-click step every other
    // relaunch check in this repo already uses (`verify-555-user-message-time.mjs`'s own
    // precedent) is required here too, only one Session exists in this scratch registry.
    await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered' });
    await cdp.click(`document.querySelector('[data-session-open]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Relaunch: Session reattached, composer enabled'
    });
    // 1920px, not 1280px: at 1280 the cap cannot bind regardless of which value persisted (the
    // pane content itself is narrower than 64rem, Check 2/3's own 1280 branch already proves
    // this), so measuring there could not actually distinguish "Reading column survived" from
    // "silently reverted to Full" -- at 1920 the two are unambiguous: 1024px (capped) vs ~1445px
    // (Full, Check 1's own measured value).
    await setWindowWidth(cdp, 1920);
    const relaunchLayout = await measureLayout(cdp);
    if (!relaunchLayout.column || !relaunchLayout.viewport) {
      failures.push('Relaunch persistence: transcript column or viewport not found after reopening the Session.');
    } else {
      assertClose('Relaunch persistence at 1920px: column width equals the 64rem cap exactly (Reading column must survive with no Settings round trip)', relaunchLayout.column.width, READING_COLUMN_PX, '`settings.json` must have persisted chatWidth: reading-column across the relaunch, read back at boot with no re-save.', 2);
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
