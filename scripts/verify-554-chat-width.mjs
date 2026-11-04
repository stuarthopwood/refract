#!/usr/bin/env node
// Live CDP check for #554 (Settings: chat reading width, full by default or a centred 64rem column).
// Uses ambient-profile `omp` with scratch data and sends no prompt. The exe is tied to this commit by
// rebuilding first and asserting the `max-w-[64rem]` marker in the built bundle.
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node scripts/verify-554-chat-width.mjs
// (needs a prior `pnpm tauri build --debug --no-bundle`).

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
// The group uses `aria-labelledby="chat-width-heading"` rather than a bare `aria-label`.
const CHAT_WIDTH_RADIOGROUP_FINDER = `document.querySelector('[role="radiogroup"][aria-labelledby="chat-width-heading"]')`;
const CHAT_WIDTH_READING_COLUMN_RADIO_FINDER = `(${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelector('[role="radio"][aria-checked]:nth-of-type(2)') ?? Array.from((${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelectorAll('[role="radio"]') ?? []).find((el) => el.textContent.includes('Reading column'))`;
const CHAT_WIDTH_FULL_RADIO_FINDER = `Array.from((${CHAT_WIDTH_RADIOGROUP_FINDER})?.querySelectorAll('[role="radio"]') ?? []).find((el) => el.textContent.trim().startsWith('Full'))`;

// `max-w-[64rem]` exists only from this story onward, so finding it in the just-built bundle
// proves the build contains #554's code.
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

/** Opens Settings, goes to Appearance, and waits for the Chat width radiogroup to mount. */
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

/** Tabs from the focused radio to Save and presses a real Enter. `cdp.pressEnter()` is needed
 * because a native button's Enter activation requires the `text` fields in this WebView2 build;
 * bare `pressKey` does not reliably trigger it. No click fallback, so failures stay visible. */
async function saveViaKeyboard(cdp, { findings, label }) {
  await pressTab(cdp);
  await cdp.waitFor(`document.activeElement?.textContent?.trim() === 'Save'`, { timeoutMs: 5_000, label: `Tab reached the Save button (${label})` });
  await cdp.pressEnter();
  await cdp.waitFor(`!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`, { timeoutMs: 5_000, label: `Keyboard Enter committed Save (${label}, Save disabled afterward)` });
  findings.push(`Keyboard Save committed "${label}" via a real Tab + Enter (Save disabled afterward, matching the Theme picker's own isDirty gate).`);
}

/** Reads the transcript, pane viewport and composer rects in one round trip so they describe the
 * same render (separate `evaluate()` calls could straddle a re-render). */
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

    // Launch 1: through readiness, add the scratch repo, create a Session.
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
    await cdp.openLocalFolderDialog();
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
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent -- every check below is a static computed-style read.');

    // Check 1: default "Full" at 1280 and 1920, no cap, column fills its viewport.
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

    // Check 2: switch to "Reading column" by mouse and Save. The transcript is not mounted while
    // Settings is open and closing without saving reverts the preview, so the capped column is
    // observable only after a real Save; the preview itself is proven by aria-checked flipping.
    await setWindowWidth(cdp, 1280);
    await openSettingsAppearance(cdp);
    const beforeMouseClick = await cdp.evaluate(`(${CHAT_WIDTH_FULL_RADIO_FINDER})?.getAttribute('aria-checked')`);
    if (beforeMouseClick !== 'true') failures.push(`Chat width setting: expected "Full" to be the checked radio before any change (got aria-checked=${beforeMouseClick}).`);
    const previewBarsWidthFull = await cdp.evaluate(`document.querySelector('[data-chat-width-preview-bars]')?.getBoundingClientRect().width`);
    await cdp.click(CHAT_WIDTH_READING_COLUMN_RADIO_FINDER);
    await cdp.waitFor(`(${CHAT_WIDTH_READING_COLUMN_RADIO_FINDER})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (mouse)' });
    findings.push('Mouse: clicked the "Reading column" radio -- aria-checked flipped immediately (live local-store preview, no IPC round trip).');
    // The preview tile narrows before Save, proving it tracks the preview store.
    const previewBarsWidthReadingColumn = await cdp.evaluate(`document.querySelector('[data-chat-width-preview-bars]')?.getBoundingClientRect().width`);
    if (previewBarsWidthFull == null || previewBarsWidthReadingColumn == null) {
      failures.push('Chat width preview tile: `[data-chat-width-preview-bars]` not found before/after selecting "Reading column" -- cannot confirm the H2 preview tile tracks the live choice.');
    } else if (!(previewBarsWidthReadingColumn < previewBarsWidthFull - 4)) {
      failures.push(`Chat width preview tile: expected the bars to narrow once "Reading column" is previewed (Full: ${previewBarsWidthFull}px, Reading column: ${previewBarsWidthReadingColumn}px).`);
    } else {
      findings.push(`Chat width preview tile narrowed live from ${previewBarsWidthFull}px (Full) to ${previewBarsWidthReadingColumn}px (Reading column, before Save) -- H2 gate fix confirmed.`);
    }
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
        // The pane is narrower than 64rem at 1280px, so the cap cannot bind: the column equals
        // the pane's content width.
        assertClose(`Reading column at 1280px (cap cannot bind, pane narrower than 64rem): column width equals pane content width`, layout.column.width, layout.viewport.clientWidth, 'FR-073: the cap is a maximum, never a minimum.', 4);
        assertClose(`Reading column at 1280px: left vs right margin (no cap in effect)`, leftMargin, rightMargin, 'no cap bound, so both margins should read ~0.', 4);
      } else {
        // 1920/2560: the cap must bind exactly and centre within 1px, so a broken cap or
        // centring cannot pass by accident.
        assertClose(`Reading column at ${width}px: column width equals the 64rem cap exactly`, layout.column.width, READING_COLUMN_PX, '64rem cap, FR-073.', 2);
        assertClose(`Reading column at ${width}px: centred within 1px (left vs right margin)`, leftMargin, rightMargin, 'mx-auto must centre the capped column.', 1);
      }
      if (layout.composer) {
        assertClose(`Composer width at ${width}px (Reading column) vs its own pane`, layout.composer.width, layout.viewport.clientWidth, 'FR-073: the composer never follows the transcript cap.', 40);
      } else {
        failures.push(`Composer at ${width}px (Reading column): \`[aria-label="Message"]\`'s \`.bg-composer-background\` ancestor was not found -- cannot confirm the composer stayed unaffected by the transcript cap.`);
      }
      if (width === 1920) {
        // The padding ladder uses container queries keyed off the pane, not the window; confirm
        // the top breakpoint applies at a pane wider than 64rem.
        const paddingLeft = await cdp.evaluate(`getComputedStyle(${TRANSCRIPT_COLUMN_FINDER}).paddingLeft`);
        if (paddingLeft !== '64px') {
          failures.push(`Reading column at 1920px: computed padding-left is ${paddingLeft}, expected 64px (\`@min-[64rem]:px-16\`, M1 gate fix).`);
        } else {
          findings.push('Reading column at 1920px: computed padding-left is 64px, confirming the @min-[64rem]:px-16 container-query breakpoint applies against the pane, not the window.');
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `02-reading-column-saved-${width}.png`));
    }
    findings.push('Saved via mouse, applied with NO app reload/restart (same running process throughout) at 1280/1920/2560px.');

    // Check 3: toggle to "Full" by keyboard, Save, confirm the transcript uncaps. Reading column
    // is already saved, so landing back on it would be a no-op (choosing the saved entry never
    // re-fires a save). Measured at 1920px: at 1280 the cap cannot bind, so a wrong saved value
    // would measure the same.
    await setWindowWidth(cdp, 1920);
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
      assertClose('Full (keyboard-saved) at 1920px: column width vs viewport content width', fullKeyboardLayout.column.width, fullKeyboardLayout.viewport.clientWidth, 'a real keyboard Save round trip must uncap the transcript, FR-073.', 4);
    } else {
      failures.push('Full (keyboard-saved): transcript column or viewport not found after closing Settings.');
    }

    // Back to "Reading column" by keyboard: a second real Save, left persisted for later checks.
    await openSettingsAppearance(cdp);
    await cdp.click(fullRadio); // focuses the currently-checked "Full" radio
    await pressArrowDown(cdp); // moves to "Reading column" (index 1), live-previews it immediately
    await cdp.waitFor(`(${readingColumnRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Reading column" radio checked (keyboard ArrowDown)' });
    findings.push('Keyboard: ArrowDown moved aria-checked back to "Reading column" immediately.');
    await saveViaKeyboard(cdp, { findings, label: 'Reading column' });
    await closeSettings(cdp);
    const keyboardSavedLayout = await measureLayout(cdp);
    if (keyboardSavedLayout.column && keyboardSavedLayout.viewport) {
      // At 1920px the cap must bind if the keyboard Save persisted "Reading column"; 1280 could
      // not tell a correct save from a wrong one.
      assertClose('Reading column (keyboard-saved, second round trip) at 1920px: column width equals the 64rem cap exactly', keyboardSavedLayout.column.width, READING_COLUMN_PX, 'via a real keyboard Save round trip, FR-073.', 2);
    } else {
      failures.push('Reading column (keyboard-saved): transcript column or viewport not found after closing Settings.');
    }

    // Check 3b: Escape must discard an unsaved "Full" preview, not persist it. The radiogroup
    // reverts to "Reading column", Save is disabled, the transcript stays capped, and focus stays
    // on the checked radio (Escape never moved it).
    await openSettingsAppearance(cdp);
    await cdp.click(readingColumnRadio); // focuses the currently-checked radio
    await pressArrowUp(cdp); // previews "Full" again, without saving
    await cdp.waitFor(`(${fullRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Full" previewed again (keyboard, before Escape)' });
    await pressKey(cdp, 27, 'Escape', 'Escape');
    await cdp.waitFor(`(${readingColumnRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: 'Escape reverted the radiogroup to the saved "Reading column" value' });
    const focusAfterEscape = await cdp.evaluate(`(() => { const el = document.activeElement; return el && el.getAttribute ? { role: el.getAttribute('role'), checked: el.getAttribute('aria-checked') } : null; })()`);
    if (!focusAfterEscape || focusAfterEscape.role !== 'radio' || focusAfterEscape.checked !== 'true') {
      failures.push(`Escape: H1's "already on a radio, leave it" guard expected focus to stay on the checked radio, got ${JSON.stringify(focusAfterEscape)}.`);
    } else {
      findings.push('Escape left focus exactly where it was (on the now-checked "Reading column" radio, never yanked away) -- H1\'s "already on a radio, leave it" guard confirmed.');
    }
    const saveDisabledAfterEscape = await cdp.evaluate(`!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    if (!saveDisabledAfterEscape) {
      failures.push('Escape: Save stayed enabled after reverting the preview -- a cancelled preview should leave nothing dirty to save.');
    } else {
      findings.push('Escape cancelled an in-progress "Full" preview, reverting the radiogroup to "Reading column" (the saved value) with Save disabled again.');
    }
    await closeSettings(cdp);
    const afterEscapeLayout = await measureLayout(cdp);
    if (afterEscapeLayout.column && afterEscapeLayout.viewport) {
      assertClose('After Escape-cancelled preview at 1920px: column still equals the 64rem cap (the discarded "Full" preview never persisted)', afterEscapeLayout.column.width, READING_COLUMN_PX, 'Escape must discard, not save, FR-005.', 2);
    } else {
      failures.push('After Escape: transcript column or viewport not found.');
    }

    // Check 3c: the Cancel button must also discard. Clicking it moves focus onto the button, so
    // focus must be routed back to the checked radio of the previewed group (Chat width, not Theme).
    await openSettingsAppearance(cdp);
    await cdp.click(readingColumnRadio); // focuses the currently-checked radio
    await pressArrowUp(cdp); // previews "Full" again, without saving
    await cdp.waitFor(`(${fullRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: '"Full" previewed again (keyboard, before Cancel button)' });
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Cancel' && !el.disabled)`);
    await cdp.waitFor(`(${readingColumnRadio})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: 'Cancel button reverted the radiogroup to the saved "Reading column" value' });
    const focusAfterCancelClick = await cdp.evaluate(`(() => { const el = document.activeElement; return el && el.getAttribute ? { role: el.getAttribute('role'), checked: el.getAttribute('aria-checked'), labelledBy: el.getAttribute('aria-labelledby') } : null; })()`);
    if (!focusAfterCancelClick || focusAfterCancelClick.role !== 'radio' || focusAfterCancelClick.checked !== 'true' || focusAfterCancelClick.labelledBy !== 'chat-width-option-reading-column-name') {
      failures.push(`Cancel button: H1's \`lastDirtyGroupRef\` focus-restoration expected to land on the checked "Reading column" radio (Chat width group, not Theme's), got ${JSON.stringify(focusAfterCancelClick)}.`);
    } else {
      findings.push('Cancel button reverted the preview and H1 correctly moved focus onto the now-checked "Reading column" radio (the Chat width group that was actually dirty, not Theme\'s).');
    }
    const saveDisabledAfterCancelClick = await cdp.evaluate(`!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Save' && !el.disabled)`);
    if (!saveDisabledAfterCancelClick) failures.push('Cancel button: Save stayed enabled after reverting the preview.');
    await closeSettings(cdp);
    const afterCancelClickLayout = await measureLayout(cdp);
    if (afterCancelClickLayout.column && afterCancelClickLayout.viewport) {
      assertClose('After Cancel-button-discarded preview at 1920px: column still equals the 64rem cap (the discarded "Full" preview never persisted)', afterCancelClickLayout.column.width, READING_COLUMN_PX, 'Cancel must discard, not save, FR-005.', 2);
    } else {
      failures.push('After Cancel button: transcript column or viewport not found.');
    }

    // Check 4: narrow window (360px), no horizontal scroll under Reading column.
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

    // Read `settings.json` off disk before relaunch to prove the IPC round trip persisted
    // `chatWidth: "reading-column"`, independent of the later visual check.
    const settingsBeforeRelaunch = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    if (settingsBeforeRelaunch.chatWidth !== 'reading-column') {
      failures.push(`settings.json before relaunch: chatWidth is ${JSON.stringify(settingsBeforeRelaunch.chatWidth)}, expected "reading-column" (the last keyboard Save above).`);
    } else {
      findings.push('settings.json on disk (before relaunch) has chatWidth: "reading-column" -- the real IPC round trip persisted it, not just the DOM.');
    }

    // Stop the app and relaunch the same exe against the same dataDir to check persistence.
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
    // A cold relaunch shows the session list, not the last chat, so click the session row
    // (only one Session exists in this scratch registry).
    await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered' });
    await cdp.click(`document.querySelector('[data-session-open]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Relaunch: Session reattached, composer enabled'
    });
    // 1920px, not 1280: the cap cannot bind at 1280, so it could not distinguish a persisted
    // Reading column (1024px) from a silent revert to Full (~1445px).
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
