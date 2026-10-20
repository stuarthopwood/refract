#!/usr/bin/env node
// Live CDP check for issue #1043 (Theme submenu real radio list, shared DropdownMenuRadioItem,
// ADR 0003). Grilled 2026-10-19, converged into spec 008 (Clarifications "Session 2026-10-20",
// FR-019/FR-030) 2026-10-20. Built the same way `verify-tauri-569.mjs`/`verify-741-role-chip.mjs`
// drive this app: `scripts/verify-tauri-launcher.rs`'s kill-on-close Job Object, a fresh scratch
// `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`REFRACT_IMPORT_SOURCE_DIR` per launch, the real
// rendered DOM over CDP -- never `window.refract.theme.set`/`.setThinkingLevel` as a shortcut for
// anything the UI itself should do, except the two documented exceptions below (same exceptions
// `verify-tauri-735.mjs`/`verify-564-gate2-live-check.mjs` already establish).
//
// Proves, against the real rendered DOM, in each of the 5 built-in presets:
//   - The Theme submenu is a real `DropdownMenuRadioGroup`: every row `role="menuitemradio"`,
//     exactly one `aria-checked="true"`, matching the active theme (`useThemeStore`).
//   - The leading ring-and-dot mark (`radio-group.tsx`'s `RADIO_RING_CLASS`/`RADIO_DOT_CLASS`):
//     the dot (`DropdownMenuPrimitive.ItemIndicator`) is structurally mounted on the checked row
//     ONLY, never on an unchecked one.
//   - The colour swatch is a two-colour chip (`rounded-[3px]`, never `rounded-full`) AFTER the
//     name, never confused for a second radio.
//   - Pointer selection (`switchTheme`, `verify-tauri-scratch-helpers.mjs`, fixed for #1043's new
//     `menuitemradio` rows) moves the check, once per preset (5/5 transitions exercised).
//   - Keyboard selection: ArrowRight into the submenu lands focus on the ACTIVE preset first (the
//     existing keyboard-open-focus behaviour, unregressed) -- seeded on 'Dark (high contrast)',
//     the SECOND-listed preset, not the first-listed 'Dark', so this cannot pass merely because
//     Radix's own unmodified default (focus the first item) coincidentally matches; ArrowDown +
//     Enter from there selects Obsidian, the checked radio re-read as having actually moved.
//   - The focus-bar/checked-state split (2026-10-15 decision, "the bar follows focus, never
//     selection" -- unchanged by this fix): an UNCHECKED row that has keyboard focus carries the
//     inset-shadow focus bar; the CHECKED-but-unfocused row does not.
//   - Forced-colours: WebView2's own CDP endpoint has no working `Emulation.setEmulatedMedia` for
//     `forced-colors` (the same limitation `verify-tauri-567.mjs`'s header comment already
//     records) -- a structural check confirms the ring's own
//     `forced-colors:group-data-[state=checked]/radio-item:border-[Highlight]` utility class is
//     literally present in the rendered markup, AND a `document.styleSheets` check confirms
//     Tailwind genuinely compiled a matching `@media (forced-colors: ...)` CSS rule declaring
//     `border-color: Highlight` (not just that the class name exists as rendered-DOM text);
//     real OS forced-colours rendering is reported `notExercised`, not silently skipped or
//     falsely claimed.
// Then, the shared `DropdownMenuRadioItem`'s OTHER caller:
//   - The composer's Reasoning picker (`ComposerPickers.tsx:114-120`, needed NO code change for
//     #1043): `menuitemradio` x8 (every `THINKING_LEVELS` entry), exactly one checked matching
//     the Session's real selected `lastThinkingLevel` (set through a real click/keyboard
//     selection in the UI, never a seed -- see the exception note below), the same
//     dot-on-checked-only structural proof, and a real keyboard selection through the real
//     `model.setThinkingLevel` IPC.
//
// Exceptions to "never a shortcut": `window.refract.theme.set`/`window.refract.sessions.list()`
// read-only calls (confirming a real store round trip after a UI-driven action, not driving the
// UI itself). An earlier cut of this script seeded `registry.json`'s `lastThinkingLevel`
// directly (the same approach `verify-564-gate2-live-check.mjs` established for that exact
// field) -- dropped once that seed turned out to race the real post-attach session-settle
// resync that persists `lastThinkingLevel` back onto the Session row, silently overwriting it
// before this script ever read it back. A real pointer click (then a real keyboard selection)
// has no such race, so Part B below drives both through the actual UI instead.
//
// Every launched app instance (and its CDP connection) is registered in `openHandles` the
// instant it is created and torn down in ONE top-level `finally`-equivalent, regardless of which
// step throws. A hard `process.exit(...)` at every exit path.

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
// LOW fix (#1043): this is a FIXED folder name (not a fresh mkdtempSync per run), so a previous
// run's output -- including an early "first build" attempt's own screenshots, possibly captured
// at the wrong zoom/DPI before some later fix landed -- would otherwise linger here untouched by
// any filename this run does not happen to regenerate (e.g. a run that FAILs before reaching a
// later screenshot). Cleared by exact literal filename only (`clearKnownOutputFiles`'s own
// guard, never a recursive delete of a variable-overridable folder), every name this script is
// known to ever write: the per-theme Theme-submenu shots, the keyboard/reasoning shots, both
// report files, and every retry attempt's own app log (`launchFresh`'s own 1-5 attempts x 2
// labels, 'themes'/'reasoning').
const SHOT_NAMES_1043 = [
  ...THEMES_1043.map((theme) => `${theme.id}-theme-submenu.png`),
  'keyboard-selection-obsidian.png',
  'reasoning-picker-open.png',
  'reasoning-picker-medium.png',
  'report.json',
  'report.txt',
  ...['themes', 'reasoning'].flatMap((label) => [1, 2, 3, 4, 5].map((attempt) => `app-run-${label}-attempt${attempt}.log`))
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

    // -----------------------------------------------------------------------------------------
    // Part A: the Theme submenu -- a real radio group in every preset, pointer AND keyboard
    // selection, the radio dot, the two-colour gradient chip, the focus-bar/checked-state split, and
    // the forced-colours structural check.
    // -----------------------------------------------------------------------------------------
    const repoParentA = mkdtempSync(path.join(tmpdir(), 'refract-1043-repoA-'));
    track(() => safeRmSync(repoParentA));
    const repoDirA = makeScratchRepo(path.join(repoParentA, 'repo'), 'refract-1043-repoA');
    const { cdp, teardown: teardownA } = await launchFresh('themes');
    await addRepository(cdp, repoDirA);
    checkPass('Added a scratch repository (the Theme submenu needs no Session to exist)');

    // MEDIUM fix (#1043): the app's own default/starting theme is 'dark' (THEMES_1043[0]),
    // so a loop that starts by switching TO 'dark' first would make that one iteration a no-op
    // click (ProfileMenu.tsx's `chooseTheme` returns early for `id === activeId`, calling
    // `useThemeStore.save` zero times) -- not a real transition, undercutting the "5/5
    // transitions exercised" claim below to really only 4/5. Seed a different preset first so
    // every one of the 5 iterations below, including the first (switching away from this seed
    // back to 'dark'), is a genuine pointer-driven transition.
    await switchTheme(cdp, 'cyber-amber', 'Cyber Amber');
    for (const theme of THEMES_1043) {
      await switchTheme(cdp, theme.id, theme.name);
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
    checkPass('Pointer selection moves the check: exercised once per preset above via switchTheme, genuinely 5/5 transitions (seeded on Cyber Amber beforehand, so the first iteration switching to Dark is a real transition too, not a same-theme no-op click)');

    // ---- Keyboard: open via Enter, ArrowDown x2 + ArrowRight into the submenu, confirm focus
    // lands on the ACTIVE preset first. Seeds 'Dark (high contrast)' (THEMES_1043[1]), not
    // 'Dark' (THEMES_1043[0]) -- MEDIUM fix (#1043): asserting focus lands on 'Dark' here would
    // be a VACUOUS test, since Radix's own unmodified default (focus the first `RadioItem` in
    // DOM order) would ALSO land on 'Dark' purely because it happens to be first-listed, proving
    // nothing about ProfileMenu.tsx's own `onOpenChange` focus-steering code (the exact habitual-
    // Enter-on-the-wrong-row bug that code's own doc comment describes). Asserting focus lands
    // on 'Dark (high contrast)' instead -- the SECOND-listed preset -- only passes if that
    // steering code genuinely ran; Radix's own default would leave focus on 'Dark' (the first
    // item) instead, which this assertion would then catch as a FAIL. ----
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

    // ---- Focus-bar vs checked-state: the 2026-10-15 "bar follows focus, never selection" rule. ----
    // Pointer-driven open does not reliably land focus on a row inside the submenu (the same
    // Radix quirk `navigateRadioGroupByKeyboardTo`'s own comment documents for the Reasoning
    // picker's trigger -- confirmed live here too: an ArrowDown from an unfocused SubTrigger
    // escapes to the NEXT ROOT menu item instead of moving within the submenu, closing it).
    // Focus the checked row explicitly first, so ArrowDown moves within the submenu for real.
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

    // ---- Forced-colours: structural check plus a real compiled-CSS-rule check (see header
    // comment for the WebView2 CDP media-emulation limitation this still cannot get around). ----
    const forcedColors = await ringCarriesForcedColorsOverride(cdp);
    if (forcedColors.checkedHasOverride && forcedColors.uncheckedHasOverride) {
      checkPass('Forced-colours override utility class present on the ring markup (structural proof -- see notExercised for the real-rendering caveat)', JSON.stringify(forcedColors));
    } else {
      checkFail('Forced-colours override utility class present on the ring markup', JSON.stringify(forcedColors));
    }
    // MEDIUM fix (#1043): the check above only proves the `forced-colors:...` class NAME is
    // present as rendered-DOM text -- true even if Tailwind's JIT silently failed to compile a
    // matching rule for this exact combination (a media variant wrapping a named-group variant
    // wrapping an arbitrary value), since JSX never strips an unmatched class name. Reads the
    // real built `out/tauri-web/assets/*.css` straight off disk instead of `document.styleSheets`
    // over CDP (`forcedColorsRuleCompiled`'s own comment: the CDP/CSSOM route scanned 0 rules
    // every run, a WebView2 cross-origin-style restriction on reading a `<link>`-loaded sheet's
    // rules back out, unrelated to whether the CSS itself works) -- confirms a rule genuinely
    // sitting inside an `@media (forced-colors: ...)` block whose own selector matches this
    // ring, and that its declaration actually sets `border-color: highlight`.
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

    // -----------------------------------------------------------------------------------------
    // Part B: the Reasoning picker (ComposerPickers.tsx) -- needed zero code change for #1043,
    // but is the shared DropdownMenuRadioItem's only other caller, so it is live-checked here.
    // -----------------------------------------------------------------------------------------
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

    // Pointer selection: click "Low" directly -- the real model.setThinkingLevel IPC, never a
    // UI-bypassing shortcut (and no registry seed: a fresh Session's real post-attach resync can
    // clobber a seeded lastThinkingLevel before this script ever reads it back).
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

    // Keyboard selection: navigate from WHEREVER focus actually lands (Radix does not reliably
    // refocus the checked item on a plain reopen) to "Medium", then Enter.
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
