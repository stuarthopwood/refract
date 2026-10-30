#!/usr/bin/env node
// Live CDP check for #1043: the Theme submenu is a real radio list (shared DropdownMenuRadioItem) in
// every preset, plus the Reasoning picker (its other caller). Drives the real DOM over CDP; the only
// non-UI calls are read-only `window.refract.theme.set`/`sessions.list()` round-trip confirmations.
// A registry.json `lastThinkingLevel` seed was dropped: the post-attach session resync overwrites it.
// Forced-colours rendering can't be emulated over WebView2 CDP, so it is checked structurally (class
// present plus compiled `@media (forced-colors)` rule on disk) and the real OS render is `notExercised`.
// Every launched app and CDP connection is registered in `openHandles` and torn down in one `finally`.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, makeScratchRepo, switchTheme, requireSharedCargoTarget, clearKnownOutputFiles } from './verify-tauri-scratch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';
import {
  THEMES_1043,
  THINKING_LEVELS_1043,
  THINKING_LEVEL_LABEL_1043,
  pressArrow,
  pressEnterKey,
  openThemeSubmenu,
  closeAllMenus,
  readRadioRows,
  openReasoningPicker,
  navigateRadioGroupByKeyboardTo,
  ringCarriesForcedColorsOverride,
  forcedColorsRuleCompiled,
  readDotRenderState,
  dotIsVisuallyVisible,
  readSwatchGradient,
  hexToRgbTuple
} from './verify-1043-theme-radio-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1043_SHOTS_DIR || path.join(tmpdir(), 'refract-1043-shots');
// Fixed folder (not mkdtemp per run): cleared by exact literal filename so stale shots from earlier
// runs can't linger, never by a recursive delete of an overridable path. The `*-zoom.png`,
// `*-theme-submenu-zoom2.png` and `*-reopen-*.log` names are stale leftovers from an older cut.
const SHOT_NAMES_1043 = [
  ...THEMES_1043.map((theme) => `${theme.id}-theme-submenu.png`),
  ...THEMES_1043.map((theme) => `${theme.id}-theme-submenu-zoom2.png`),
  ...THEMES_1043.map((theme) => `${theme.id}-zoom.png`),
  'keyboard-selection-obsidian.png',
  'reasoning-picker-open.png',
  'reasoning-picker-medium.png',
  'report.json',
  'report.txt',
  ...['themes', 'reasoning'].flatMap((label) => [1, 2, 3, 4, 5].map((attempt) => `app-run-${label}-attempt${attempt}.log`)),
  ...['themes', 'reasoning'].flatMap((label) => [1, 2, 3, 4, 5].map((attempt) => `app-run-${label}-reopen-attempt${attempt}.log`))
];

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}
function gitDirty(repoRoot) {
  const result = spawnSync_('git', ['-C', repoRoot, 'status', '--porcelain']);
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

const openHandles = [];
function track(teardownFn) {
  openHandles.push(teardownFn);
}
async function teardownAll(log) {
  while (openHandles.length > 0) {
    const fn = openHandles.pop();
    try {
      await fn();
    } catch (err) {
      log?.(`teardownAll: a cleanup step itself failed (continuing): ${err.message}`);
    }
  }
}

async function connectCdp(port, targetPid, label) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`${label}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

async function main() {
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1043-shots', SHOT_NAMES_1043);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const report = { gitHead: gitHead(REPO_ROOT), dirty: gitDirty(REPO_ROOT), checks: [], failures: [], notExercised: [] };
  log(`verify-1043-theme-radio: git HEAD under test: ${report.gitHead} (dirty: ${report.dirty})`);

  function checkPass(name, detail) {
    report.checks.push({ name, status: 'PASS', detail });
    log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function checkFail(name, detail) {
    report.checks.push({ name, status: 'FAIL', detail });
    report.failures.push(name);
    log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function notExercised(name, reason) {
    report.notExercised.push({ name, reason });
    log(`NOT EXERCISED: ${name} -- ${reason}`);
  }

  let exePath, exeHash, launcherExe;

  async function launchFresh(label, { reuseDataDir } = {}) {
    const dataDir = reuseDataDir ?? mkdtempSync(path.join(tmpdir(), `refract-1043-${label}-data-`));
    if (!reuseDataDir) track(() => safeRmSync(dataDir));
    const importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-1043-${label}-import-`));
    track(() => safeRmSync(importSourceDir));

    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const launchExeDir = mkdtempSync(path.join(tmpdir(), `refract-1043-${label}-exe${attempt}-`));
      track(() => safeRmSync(launchExeDir));
      const launchExePath = path.join(launchExeDir, 'refract-tauri.exe');
      copyFileSync(exePath, launchExePath);
      const port = await getFreePort();
      const launched = await launchBuiltExe(launcherExe, launchExePath, { port, dataDir, importSourceDir, logFile: path.join(SHOTS_DIR, `app-run-${label}-attempt${attempt}.log`) });
      try {
        const cdp = await connectCdp(port, launched.targetPid, `verify-1043-theme-radio (${label})`);
        assertExeMatchesProcess(launched.targetPid, launchExePath, exeHash);
        await cdp.waitFor(
          `!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`,
          { timeoutMs: 45_000, label: `app ready (${label})` }
        );
        let tornDown = false;
        async function teardown() {
          if (tornDown) return;
          tornDown = true;
          await cdp.close();
          await stopLauncher(launched.child);
        }
        return { cdp, dataDir, teardown };
      } catch (err) {
        lastErr = err;
        log(`verify-1043-theme-radio (${label}): attempt ${attempt}/5 failed (${err.message}); killing this attempt's process and retrying with a fresh port and exe copy.`);
        await stopLauncher(launched.child);
        await sleep(1000);
      }
    }
    throw lastErr;
  }

  try {
    const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1043-launcher-'));
    const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1043-exe-'));
    track(() => safeRmSync(shimDir));
    track(() => safeRmSync(exeDir));
    launcherExe = buildLauncher(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1043-theme-radio' });
    exePath = built.dest;
    exeHash = built.hash;
    log(`verify-1043-theme-radio: exe sha256 ${exeHash} copied to ${exePath}`);

    // ---- Part A: Theme submenu in every preset ----
    const repoParentA = mkdtempSync(path.join(tmpdir(), 'refract-1043-repoA-'));
    track(() => safeRmSync(repoParentA));
    const repoDirA = makeScratchRepo(path.join(repoParentA, 'repo'), 'refract-1043-repoA');
    const { cdp, teardown: teardownA } = await launchFresh('themes');
    await addRepository(cdp, repoDirA);
    checkPass('Added a scratch repository (the Theme submenu needs no Session to exist)');

    // Seed a non-default preset first: switching to the starting 'dark' theme is a no-op
    // (`chooseTheme` returns early for the active id), so the first iteration wouldn't be a real transition.
    await switchTheme(cdp, 'cyber-amber', 'Cyber Amber');
    let realTransitions = 0;
    for (const theme of THEMES_1043) {
      const alreadyActive = await cdp.evaluate(`document.documentElement.classList.contains(${JSON.stringify(`theme-${theme.id}`)})`);
      await switchTheme(cdp, theme.id, theme.name);
      if (!alreadyActive) realTransitions += 1;
      await openThemeSubmenu(cdp);
      const rows = await readRadioRows(cdp);
      const checkedRows = rows.filter((r) => r.ariaChecked === 'true');
      const everyRoleCorrect = rows.length === THEMES_1043.length;
      const exactlyOneChecked = checkedRows.length === 1 && checkedRows[0].label === theme.name;
      if (everyRoleCorrect && exactlyOneChecked) {
        checkPass(`${theme.name}: Theme submenu is menuitemradio x${rows.length}, exactly one aria-checked=true matching the active preset`, JSON.stringify(rows.map((r) => ({ label: r.label, ariaChecked: r.ariaChecked }))));
      } else {
        checkFail(`${theme.name}: Theme submenu is menuitemradio x${rows.length}, exactly one aria-checked=true matching the active preset`, JSON.stringify(rows));
      }

      const dotState = await readDotRenderState(cdp);
      const dotCheck = dotIsVisuallyVisible(dotState);
      if (dotCheck.visible) checkPass(`${theme.name}: the checked row's dot is PIXEL-VISIBLE (width ${dotState.checked.width}px, contrast ${dotCheck.ratio.toFixed(2)}:1 vs popover)`, JSON.stringify(dotState));
      else checkFail(`${theme.name}: the checked row's dot is PIXEL-VISIBLE`, JSON.stringify({ dotState, reason: dotCheck.reason }));
      const uncheckedIsBlank = !dotState.unchecked?.present;
      if (uncheckedIsBlank) checkPass(`${theme.name}: an unchecked row's dot is not mounted at all (no fill to be invisible or visible)`);
      else checkFail(`${theme.name}: an unchecked row's dot is not mounted at all`, JSON.stringify(dotState.unchecked));

      const swatchGradient = await readSwatchGradient(cdp, theme.name);
      const expectedBg = hexToRgbTuple(theme.swatch);
      const expectedPrimary = hexToRgbTuple(theme.swatchPrimary);
      const swatchOk = swatchGradient.present && swatchGradient.backgroundImage.includes('linear-gradient') && swatchGradient.backgroundImage.includes(expectedBg) && swatchGradient.backgroundImage.includes(expectedPrimary);
      if (swatchOk) checkPass(`${theme.name}: swatch chip's computed background-image is a linear-gradient containing both --background and --primary`, JSON.stringify(swatchGradient));
      else checkFail(`${theme.name}: swatch chip's computed background-image is a linear-gradient containing both --background and --primary`, JSON.stringify({ swatchGradient, expectedBg, expectedPrimary }));

      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-theme-submenu.png`));
      await closeAllMenus(cdp);
    }
    if (realTransitions === THEMES_1043.length) checkPass(`Pointer selection moves the check: ${realTransitions}/${THEMES_1043.length} switchTheme calls changed the active theme (seeded on Cyber Amber beforehand, so the first iteration switching to Dark is a real transition too, not a same-theme no-op click)`);
    else checkFail(`Pointer selection moves the check: every switchTheme call changes the active theme`, `${realTransitions}/${THEMES_1043.length} real transitions`);

    // ---- Keyboard: focus must land on the ACTIVE preset first. Seeds 'Dark (high contrast)', not the
    // first-listed 'Dark', or Radix's default (focus the first item) would pass without ProfileMenu's
    // `onOpenChange` focus-steering ever running. ----
    await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await cdp.evaluate(`document.querySelector('[data-profile-name-button]').focus()`);
    await pressEnterKey(cdp);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu opened via Enter' });
    await sleep(250);
    await pressArrow(cdp, 'Down');
    await sleep(150);
    await pressArrow(cdp, 'Down');
    await sleep(150);
    const onThemeTrigger = (await getActiveElementAccessibleName(cdp)).name?.startsWith('Theme') ?? false;
    await pressArrow(cdp, 'Right');
    await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= 5`, { timeoutMs: 10_000, label: 'Theme submenu opened via ArrowRight' });
    await sleep(300);
    const focusedOnOpen = await getActiveElementAccessibleName(cdp);
    const openedFocusOnActive = focusedOnOpen.name === 'Dark (high contrast)' && focusedOnOpen.role === 'menuitemradio';
    if (onThemeTrigger && openedFocusOnActive) checkPass('Keyboard open: ArrowRight into the Theme submenu lands focus on the ACTIVE preset (Dark (high contrast), the SECOND-listed preset -- not the vacuously-passing first-listed "Dark")', JSON.stringify(focusedOnOpen));
    else checkFail('Keyboard open: ArrowRight into the Theme submenu lands focus on the ACTIVE preset (Dark (high contrast), the SECOND-listed preset -- not the vacuously-passing first-listed "Dark")', JSON.stringify({ onThemeTrigger, focusedOnOpen }));

    await pressArrow(cdp, 'Down'); // Obsidian
    await sleep(100);
    const beforeEnter = await getActiveElementAccessibleName(cdp);
    await pressEnterKey(cdp);
    await cdp.waitFor(`document.documentElement.classList.contains('theme-obsidian')`, { timeoutMs: 10_000, label: 'Keyboard Enter applies Obsidian' });
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Menu closes after keyboard selection' });
    if (beforeEnter.name === 'Obsidian') checkPass('Keyboard: ArrowDown + Enter from Dark (high contrast) selects Obsidian, <html> class applies, menu closes', JSON.stringify(beforeEnter));
    else checkFail('Keyboard: ArrowDown + Enter from Dark (high contrast) selects Obsidian, <html> class applies, menu closes', JSON.stringify(beforeEnter));

    await openThemeSubmenu(cdp);
    const rowsAfterKeyboard = await readRadioRows(cdp);
    const checkedAfterKeyboard = rowsAfterKeyboard.find((r) => r.ariaChecked === 'true');
    if (checkedAfterKeyboard?.label === 'Obsidian') checkPass('Keyboard selection moved the checked radio to Obsidian (re-opened and re-read)');
    else checkFail('Keyboard selection moved the checked radio to Obsidian (re-opened and re-read)', JSON.stringify(rowsAfterKeyboard));
    await cdp.screenshot(path.join(SHOTS_DIR, 'keyboard-selection-obsidian.png'));

    // ---- Focus bar follows focus, never selection ----
    // Pointer-driven open doesn't reliably focus a submenu row (ArrowDown from an unfocused SubTrigger
    // escapes to the next ROOT item and closes it), so focus the checked row explicitly first.
    const onThemeRow = await cdp.evaluate(`document.activeElement?.getAttribute('role') === 'menuitemradio'`);
    if (!onThemeRow) {
      await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim() === 'Obsidian')?.focus()`);
      await sleep(100);
    }
    await pressArrow(cdp, 'Down'); // off Obsidian onto Nordic Frost
    await sleep(150);
    const focusBarState = await cdp.evaluate(`
      (() => {
        const active = document.activeElement;
        const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
        const checkedRow = rows.find((r) => r.getAttribute('aria-checked') === 'true');
        return {
          focusedLabel: active?.children?.[1]?.textContent?.trim() ?? active?.textContent?.trim() ?? null,
          focusedIsChecked: active?.getAttribute('aria-checked') === 'true',
          focusedShadow: active ? getComputedStyle(active).boxShadow : null,
          checkedLabel: checkedRow ? (checkedRow.children[1]?.textContent?.trim() ?? null) : null,
          checkedShadowWhenNotFocused: checkedRow && checkedRow !== active ? getComputedStyle(checkedRow).boxShadow : null
        };
      })()
    `);
    const focusBarOk = focusBarState.focusedLabel === 'Nordic Frost' && !focusBarState.focusedIsChecked && focusBarState.focusedShadow && focusBarState.focusedShadow !== 'none' &&
      (focusBarState.checkedShadowWhenNotFocused === 'none' || focusBarState.checkedShadowWhenNotFocused == null);
    if (focusBarOk) checkPass('Focus-bar follows focus, never selection: an UNCHECKED focused row carries the inset shadow, the checked-but-unfocused row does not', JSON.stringify(focusBarState));
    else checkFail('Focus-bar follows focus, never selection: an UNCHECKED focused row carries the inset shadow, the checked-but-unfocused row does not', JSON.stringify(focusBarState));

    // ---- Forced-colours: structural check plus a compiled-CSS-rule check ----
    const forcedColors = await ringCarriesForcedColorsOverride(cdp);
    if (forcedColors.checkedHasOverride && forcedColors.uncheckedHasOverride) {
      checkPass('Forced-colours override utility class present on the ring markup (structural proof -- see notExercised for the real-rendering caveat)', JSON.stringify(forcedColors));
    } else {
      checkFail('Forced-colours override utility class present on the ring markup', JSON.stringify(forcedColors));
    }
    // The class name alone proves little (JSX never strips an unmatched class, and Tailwind may not
    // compile a media+named-group+arbitrary-value variant). Reads the built CSS off disk because the
    // CDP/CSSOM route scans 0 rules (WebView2 blocks reading `<link>` sheet rules).
    const forcedColorsRule = forcedColorsRuleCompiled(REPO_ROOT);
    if (forcedColorsRule.selectorFound && forcedColorsRule.insideForcedColorsMedia && forcedColorsRule.declaresHighlightBorder) {
      checkPass('Forced-colours: a REAL compiled CSS rule exists inside @media (forced-colors: ...) matching the ring, declaring border-color: highlight (read from the built CSS bundle, not just the className string)', JSON.stringify(forcedColorsRule));
    } else {
      checkFail('Forced-colours: a REAL compiled CSS rule exists inside @media (forced-colors: ...) matching the ring, declaring border-color: highlight', JSON.stringify(forcedColorsRule));
    }
    notExercised(
      'Real OS forced-colours (Windows High Contrast) rendering of the checked vs unchecked ring',
      "WebView2's own CDP endpoint has no working Emulation.setEmulatedMedia for forced-colors (same limitation verify-tauri-567.mjs/verify-439-history-truncate.mjs already record); the two checks above confirm the forced-colors:group-data-[state=checked]/radio-item:border-[Highlight] utility class is literally present on every ring AND that Tailwind genuinely compiled a matching @media (forced-colors: ...) CSS rule declaring border-color: highlight for it, which is as far as this harness can prove it."
    );

    await closeAllMenus(cdp);
    await switchTheme(cdp, 'dark', 'Dark');
    await teardownA();

    // ---- Part B: Reasoning picker (the shared DropdownMenuRadioItem's other caller) ----
    const repoParentB = mkdtempSync(path.join(tmpdir(), 'refract-1043-repoB-'));
    track(() => safeRmSync(repoParentB));
    const repoDirB = makeScratchRepo(path.join(repoParentB, 'repo'), 'refract-1043-repoB');
    const { cdp: cdpB, teardown: teardownB } = await launchFresh('reasoning');
    await addRepository(cdpB, repoDirB);
    await createSessionViaQuickCreate(cdpB, 'refract-1043-repoB');
    const list = await cdpB.evaluate('window.refract.sessions.list()');
    if (!list.ok || list.value.length !== 1) throw new Error(`Part B: expected exactly 1 Session, got ${JSON.stringify(list)}`);
    const sessionId = list.value[0].id;
    await cdpB.waitFor(
      `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.status === 'idle')`,
      { timeoutMs: 60_000, label: 'Session reached idle (Reasoning picker enabled)' }
    );

    const REASONING_LABELS = THINKING_LEVELS_1043.map((level) => THINKING_LEVEL_LABEL_1043[level]);

    // Click "Low" via the real IPC; no registry seed (the post-attach resync can clobber it).
    await openReasoningPicker(cdpB);
    await cdpB.click(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim() === 'Low')`);
    await cdpB.waitFor(
      `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.lastThinkingLevel === 'low')`,
      { timeoutMs: 15_000, label: 'Pointer selection (click "Low") calls the real model.setThinkingLevel IPC' }
    );
    checkPass('Reasoning picker: pointer selection (click "Low") calls the real model.setThinkingLevel IPC');

    await openReasoningPicker(cdpB);
    const reasoningRows = await readRadioRows(cdpB);
    const reasoningChecked = reasoningRows.filter((r) => r.ariaChecked === 'true');
    const reasoningOk = reasoningRows.length === THINKING_LEVELS_1043.length && reasoningChecked.length === 1 && reasoningChecked[0].label === 'Low';
    if (reasoningOk) checkPass('Reasoning picker: menuitemradio x8 (every THINKING_LEVELS entry), exactly one aria-checked=true matching the selected level (Low)', JSON.stringify(reasoningRows.map((r) => ({ label: r.label, ariaChecked: r.ariaChecked }))));
    else checkFail('Reasoning picker: menuitemradio x8, exactly one aria-checked=true matching the selected level (Low)', JSON.stringify(reasoningRows));
    const reasoningDotState = await readDotRenderState(cdpB);
    const reasoningDotCheck = dotIsVisuallyVisible(reasoningDotState);
    if (reasoningDotCheck.visible) checkPass(`Reasoning picker: the checked row's dot is PIXEL-VISIBLE (contrast ${reasoningDotCheck.ratio.toFixed(2)}:1 vs popover)`, JSON.stringify(reasoningDotState));
    else checkFail(`Reasoning picker: the checked row's dot is PIXEL-VISIBLE`, JSON.stringify({ reasoningDotState, reason: reasoningDotCheck.reason }));
    await cdpB.screenshot(path.join(SHOTS_DIR, 'reasoning-picker-open.png'));

    // Navigate from wherever focus lands: Radix doesn't reliably refocus the checked item on reopen.
    await navigateRadioGroupByKeyboardTo(cdpB, REASONING_LABELS, 'Medium');
    await cdpB.waitFor(
      `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.lastThinkingLevel === 'medium')`,
      { timeoutMs: 15_000, label: 'Keyboard selection calls the real setThinkingLevel IPC (level becomes "medium")' }
    );
    checkPass('Reasoning picker: keyboard navigation + Enter selects Medium via the real model.setThinkingLevel IPC');
    await openReasoningPicker(cdpB);
    const reasoningRowsAfter = await readRadioRows(cdpB);
    const checkedAfter = reasoningRowsAfter.find((r) => r.ariaChecked === 'true');
    if (checkedAfter?.label === 'Medium') checkPass('Reasoning picker: the checked radio moved to Medium after the keyboard selection');
    else checkFail('Reasoning picker: the checked radio moved to Medium after the keyboard selection', JSON.stringify(reasoningRowsAfter));
    await cdpB.screenshot(path.join(SHOTS_DIR, 'reasoning-picker-medium.png'));
    await closeAllMenus(cdpB);
    await teardownB();

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-1043-theme-radio: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      await teardownAll(log);
      process.exit(1);
    } else {
      log(`verify-1043-theme-radio: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
      await teardownAll(log);
      process.exit(0);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.error('verify-1043-theme-radio: FAIL');
    console.error(err);
    await teardownAll(log);
    process.exit(1);
  }
}

main();
