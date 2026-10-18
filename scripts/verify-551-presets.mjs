#!/usr/bin/env node
// Live CDP check for issue #551 (Nordic Frost and Cyber Amber dark presets, additive per spec
// 007). Switches to Nordic Frost via the real Settings > Appearance section (preview then Save)
// and to Cyber Amber via the real Profile menu Theme submenu (two different real switch paths,
// per gate round 1 item 13) -- for each, confirms persistence across a full stop-and-relaunch on
// the same scratch data dir, screenshots the chat/composer, the session list, the Settings
// screen, and a dialog, and reads REAL rendered-surface contrast (not just hidden CSS-var
// probes, gate round 1 item 11) plus real OKLab hue/lightness-distance checks: accent-vs-info in
// every theme, and (Cyber Amber only) accent-vs-warning hue distance plus accent-vs-error swatch
// contrast (gate round 1 item 12; gate round 3 item 1 added the warning floor so a 16-17-degree
// regression like round 1's own first candidate would fail here, not just be noted). Also
// includes Dark (high contrast) (gate round 1 item 14): reads its own red severity colour live
// on a real hovered session row at the theme's declared 7:1 target, sends one real prompt that
// asks for a fenced code block and a small Mermaid diagram and screenshots the rendered result
// (this pass only, not Nordic Frost/Cyber Amber -- gate round 2 item 4 corrected this wording;
// sending the turn once, under Dark high contrast, is this script's one spend of real model
// tokens, not repeated per preset), screenshots the open Profile menu Theme submenu, and ends
// by switching back to Dark and confirming it.
//
// Drives a REAL `omp` (ambient signed-in profile), scratch cwd/worktree/`REFRACT_DATA_DIR` --
// never touches Stuart's real Session list. One turn is sent per the code-block/Mermaid check
// (item 14); every other assertion is a static DOM/computed-style/disk read.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-551-presets.mjs (requires a prior `pnpm tauri build --debug --no-bundle`, the
// same convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs` script documents). NOT run by this
// prep lane (NO-BUILD; held for the build slot) -- syntax-checked only (`node --check`).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  switchTheme,
  citeScreenshots
} from './verify-tauri-scratch-helpers.mjs';
import { pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { measuredContrastRatio, parseComputedColorToEntry } from './contrast-math.mjs';
import {
  hueDistanceDegrees,
  describeHueLightness,
  requireResolvedCssVarColor,
  worktreesDirFor,
  assertBundleContainsPresetMarkers
} from './verify-551-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR =
  process.env.REFRACT_551_SHOTS_DIR || path.join(tmpdir(), 'refract-551-presets-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Item 13: two genuinely different switch paths, one per new preset.
const NEW_THEMES = [
  { id: 'nordic-frost', name: 'Nordic Frost', switchVia: 'settings' },
  { id: 'cyber-amber', name: 'Cyber Amber', switchVia: 'profile-menu' }
];

// Gate round 3 item 6: named thresholds, not magic numbers -- both decided and documented in
// globals.css's own `.theme-cyber-amber` header comment. The swatch floor is #551's own gate
// round 1 decision; the hue floor is new this round, set below round 1's own failed 16-17-degree
// first candidate with margin, so that exact regression would fail here, not pass silently.
const CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR = 1.5;
const CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR = 30;

// Items 10/12 (missing-token guard, real OKLab hue/lightness distance): `linearSrgbToOklab`/
// `oklabHueDegrees`/`hueDistanceDegrees`/`describeHueLightness`/`cssVarRawValue`/
// `requireResolvedCssVarColor` all live in `./verify-551-helpers.mjs` now (#806 ratchet --
// gate round 2's fixes pushed this file past its own 600-line soft cap; pure-logic,
// behaviour-preserving extraction, imported above).

// ---- Item 11: real rendered surfaces, not hidden probes --------------------------------------

const SESSION_ROW_FINDER = `document.querySelector('[data-session-open]')`;
const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;

/** Reads a handful of REAL, currently-rendered surfaces (never a hidden probe element) and their
 * REAL backdrops, returning raw `getComputedStyle()` colour strings for `measuredContrastRatio`
 * to parse via `contrast-math.mjs` (gate round 1, item 11; selectors corrected gate round 2,
 * item 5 -- `[data-session-row-title]`/`[data-sidebar]` never existed in the real DOM:
 * `SessionRow.tsx`'s title text is a bare `.text-sidebar-foreground` span, and its real
 * rendered backdrop is the nearest ancestor `<div>` (skipping the intervening `<span>`/
 * `<button>`, neither of which paint a fill) -- the row's own outer flex div, which carries
 * `bg-sidebar-accent`/`hover:bg-sidebar-accent`). Call only once the session list and composer
 * are known-mounted; a dialog-specific pair is read separately while that dialog is open. */
async function readRealSurfaceColours(cdp) {
  return cdp.evaluate(`(() => {
    const row = ${SESSION_ROW_FINDER};
    const rowTitle = row ? row.querySelector('.text-sidebar-foreground') : null;
    const sidebar = rowTitle ? rowTitle.closest('div') : null;
    const send = ${SEND_BUTTON_FINDER};
    return {
      sessionRowText: rowTitle ? getComputedStyle(rowTitle).color : null,
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
      sendText: send ? getComputedStyle(send).color : null,
      sendBackground: send ? getComputedStyle(send).backgroundColor : null,
      mutedText: row ? getComputedStyle(row).color : null
    };
  })()`);
}

/** The Keyboard shortcuts dialog's own real backdrop. Gate round 2 item 6 found
 * `DialogContent` (`components/ui/dialog.tsx`) draws its edge as `ring-1 ring-foreground/10` --
 * a box-shadow-based ring, not a CSS `border` -- so `border-color`/`border-style` are never
 * actually set and reading them does not correspond to anything visually rendered. Reported as
 * informational only below (never a pass/fail gate) rather than asserting a floor against a
 * property this component doesn't use. Renamed from `readRealDialogBorder` (gate round 3 item
 * 4): it never read a border, only the dialog's own background and real box-shadow ring. */
async function readRealDialogSurfaces(cdp) {
  return cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const cs = getComputedStyle(dialog);
    return { borderColor: cs.borderColor, boxShadow: cs.boxShadow, background: cs.backgroundColor };
  })()`);
}

// Gate round 3 item 5: `worktreesDirFor` and `assertBundleContainsPresetMarkers` both live in
// `./verify-551-helpers.mjs` now (#806 ratchet -- this round's own fixes pushed the main script
// back over its 600-line soft cap; pure-logic, behaviour-preserving extraction, imported above).

async function openSettingsAppearance(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.querySelector('[role="radiogroup"]')`, { timeoutMs: 10_000, label: 'Appearance section mounted (theme picker radiogroup)' });
}

async function closeSettingsBackToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings closed, back in chat' });
}

/** Item 13: switches via the Settings > Appearance picker itself -- clicks the preset's own
 * radio (a real live preview via `theme-store.ts`'s `preview()`), confirms the previewed class
 * landed, then Saves (the real IPC round trip, distinct from the Profile-menu Theme submenu's
 * own, already-exercised route). */
async function switchThemeViaSettings(cdp, themeId, themeName) {
  await openSettingsAppearance(cdp);
  const radioFinder = `document.querySelector('[role="radio"][aria-labelledby="theme-option-${themeId}-name"]')`;
  await cdp.click(radioFinder);
  await cdp.waitFor(`document.documentElement.className.includes('theme-${themeId}')`, { timeoutMs: 5_000, label: `${themeName} previewed via Settings radio` });
  await cdp.waitFor(`(${radioFinder})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: `${themeName} radio marked checked` });
  await cdp.clickByText('Save');
  await cdp.waitFor(`(${radioFinder})?.disabled !== true`, { timeoutMs: 5_000, label: 'Save completed (button re-enabled/disabled state settled)' }).catch(() => {});
  await closeSettingsBackToChat(cdp);
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = []; // Genuine skips only (timing, an optional path not reached).
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  const shotNames = [];
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-551-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-551-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-551-repo-')), 'verify-551-presets');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-551-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-551-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    let port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`verify-551: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-551: data dir ${dataDir}`);
    console.log(`verify-551: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-551' });
    assertBundleContainsPresetMarkers(REPO_ROOT);
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    let launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    let targetPid = launched.targetPid;
    let wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-551: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-551');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

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
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // ---- Per-new-preset pass: switch (item 13's two different real paths), capture real
    // surfaces (item 11), check hue/lightness separation (item 12), relaunch-persist (item 13),
    // screenshot. ----
    for (const theme of NEW_THEMES) {
      try {
        if (theme.switchVia === 'settings') {
          await switchThemeViaSettings(cdp, theme.id, theme.name);
          findings.push(`${theme.name}: switched via the real Settings > Appearance radio (preview then Save).`);
        } else {
          await switchTheme(cdp, theme.id, theme.name);
          findings.push(`${theme.name}: switched via the real Profile-menu Theme submenu.`);
        }
      } catch (err) {
        failures.push(`Could not switch to ${theme.name} via its assigned route (${theme.switchVia}) (${err.message}).`);
        continue;
      }
      await sleep(200);

      const appliedClass = await cdp.evaluate(`document.documentElement.className`);
      if (!appliedClass.includes(`theme-${theme.id}`)) {
        failures.push(`${theme.name}: <html> class is "${appliedClass}" after switching, expected it to include "theme-${theme.id}".`);
      } else {
        findings.push(`${theme.name}: real <html> class confirmed (${appliedClass}).`);
      }

      const chatShot = `${theme.id}-00-chat-composer.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
      shotNames.push(chatShot);

      // ---- Item 11: real rendered surfaces. ----
      const realSurfaces = await readRealSurfaceColours(cdp);
      if (!realSurfaces.sendText || !realSurfaces.sendBackground) {
        failures.push(`${theme.name}: Send button real colours could not be read (target missing).`);
      } else {
        const sendRatio = measuredContrastRatio(realSurfaces.sendText, realSurfaces.sendBackground);
        if (sendRatio === null) failures.push(`${theme.name}: could not parse Send button's real colour/fill (${realSurfaces.sendText} on ${realSurfaces.sendBackground}).`);
        else if (sendRatio < 3) failures.push(`${theme.name}: Send button real text/fill measures ${sendRatio.toFixed(2)}:1, below the 3:1 icon/large-text floor.`);
        else findings.push(`${theme.name}: Send button real text/fill measures ${sendRatio.toFixed(2)}:1 (>=3:1).`);
      }
      if (!realSurfaces.sessionRowText || !realSurfaces.sidebarBackground) {
        // Gate round 3 item 3: a session row is known to be on screen here -- a missed selector
        // is a real DOM-shape regression, not a legitimate absence to record as notExercised.
        failures.push(`${theme.name}: session-list row title or sidebar background selector matched nothing, though a session row is known to be on screen at this point.`);
      } else {
        const sidebarEntry = parseComputedColorToEntry(realSurfaces.sidebarBackground);
        if (!sidebarEntry) {
          failures.push(`${theme.name}: could not parse the real sidebar background (${realSurfaces.sidebarBackground}) for alpha/colour.`);
        } else if (sidebarEntry.alpha < 1) {
          // Gate round 3 item 2: alpha < 1 (not just fully transparent) means this backdrop's
          // true rendered colour depends on whatever paints behind it, which this check never
          // reads -- a contrast ratio computed directly against a semi-transparent string would
          // be unreliable, not just a 0-alpha one.
          failures.push(`${theme.name}: the real session-row backdrop (${realSurfaces.sidebarBackground}) has alpha ${sidebarEntry.alpha} (<1) -- its true rendered colour depends on whatever paints behind it, which this check cannot see.`);
        } else {
          const rowRatio = measuredContrastRatio(realSurfaces.sessionRowText, realSurfaces.sidebarBackground);
          if (rowRatio === null) failures.push(`${theme.name}: could not parse session-row text/sidebar background for a measured ratio.`);
          else if (rowRatio < 4.5) failures.push(`${theme.name}: session-row title text measures ${rowRatio.toFixed(2)}:1 on the real sidebar background, below 4.5:1.`);
          else findings.push(`${theme.name}: session-row title text measures ${rowRatio.toFixed(2)}:1 on the real sidebar background (>=4.5:1).`);
        }
      }

      // ---- A dialog: Keyboard shortcuts (read-only, no mutation risk) -- real background +
      // box-shadow ring vs real popover background (item 11's surface read; gate round 3 item 4
      // corrected this comment, which still said "real border" after gate round 2 item 6 found
      // this component has no border at all, only a `ring-foreground/10` box-shadow). ----
      await cdp.click(`document.querySelector('[data-profile-name-button]')`);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile dropdown menu open' });
      await cdp.clickByText('Keyboard shortcuts', { tag: 'div' });
      const dialogOpen = await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts dialog open' }).then(
        () => true,
        () => false
      );
      if (!dialogOpen) {
        failures.push(`${theme.name}: Keyboard shortcuts dialog did not open from the Profile menu.`);
      } else {
        const dialogSurfaces = await readRealDialogSurfaces(cdp);
        if (!dialogSurfaces) {
          failures.push(`${theme.name}: dialog background/box-shadow could not be read.`);
        } else {
          // Informational only (gate round 2 item 6): this component's real edge is a
          // box-shadow ring (`ring-foreground/10`), not a CSS border -- `borderColor` never
          // corresponds to anything rendered, so no pass/fail floor is asserted against it.
          findings.push(`${theme.name}: real Keyboard shortcuts dialog -- background ${dialogSurfaces.background}, box-shadow ${dialogSurfaces.boxShadow} (its real edge; informational only, this component has no CSS border to gate on).`);
        }
        const dialogShot = `${theme.id}-02-keyboard-shortcuts-dialog.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, dialogShot));
        shotNames.push(dialogShot);
        await pressEscape(cdp);
        await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts dialog closed (Esc)' });
      }

      // ---- Item 10/12: require the token is actually declared, then compare REAL OKLab
      // hue/lightness, not string inequality. ----
      try {
        const accentRaw = (await requireResolvedCssVarColor(cdp, '--accent-text', 'color'));
        const infoRaw = (await requireResolvedCssVarColor(cdp, '--severity-info', 'color'));
        const accentHL = describeHueLightness(accentRaw);
        const infoHL = describeHueLightness(infoRaw);
        if (!accentHL || !infoHL) {
          failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or --severity-info (${infoRaw}) for a real OKLab hue/lightness read.`);
        } else {
          const hueDist = hueDistanceDegrees(accentHL.hue, infoHL.hue);
          if (hueDist < 20) failures.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and --severity-info (hue ${infoHL.hue.toFixed(1)}) are only ${hueDist.toFixed(1)} degrees apart -- not a real distinct hue, the mock's own merged-hue defect #551 was meant to fix.`);
          else findings.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and --severity-info (hue ${infoHL.hue.toFixed(1)}) are ${hueDist.toFixed(1)} degrees apart, a real distinct hue.`);
        }

        // Cyber Amber only: accent vs error must ALSO clear the decided swatch-contrast
        // separation (gate round 1 item 6's own fix, re-verified live here; item 1 of gate
        // round 2 corrected this from an OKLab lightness-ratio gate, which the real measured
        // values -- 1.15:1 -- would have failed even though the decision itself specified
        // swatch contrast >= 1.5:1, the figure actually measured and decided on).
        if (theme.id === 'cyber-amber') {
          const errorRaw = await requireResolvedCssVarColor(cdp, '--severity-error', 'color');
          const swatchRatio = measuredContrastRatio(accentRaw, errorRaw);
          if (swatchRatio === null) {
            failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or --severity-error (${errorRaw}) for a measured swatch contrast ratio.`);
          } else if (swatchRatio < CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR) {
            failures.push(`${theme.name}: --accent-text (${accentRaw}) and --severity-error (${errorRaw}) measure only ${swatchRatio.toFixed(2)}:1 apart (swatch contrast) -- below the ${CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR}:1 the gate round 1 retune decided.`);
          } else {
            findings.push(`${theme.name}: --accent-text and --severity-error measure ${swatchRatio.toFixed(2)}:1 apart (swatch contrast), clearing the decided ${CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR}:1 separation.`);
          }

          // Gate round 3 item 1: live accent-vs-warning hue distance -- the first gate round 2
          // candidate measured only 16-17 degrees after clipping; this would now fail it.
          const warningRaw = await requireResolvedCssVarColor(cdp, '--severity-warning', 'color');
          const warningHL = describeHueLightness(warningRaw);
          if (!accentHL || !warningHL) {
            failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or --severity-warning (${warningRaw}) for a real OKLab hue read.`);
          } else {
            const warningHueDist = hueDistanceDegrees(accentHL.hue, warningHL.hue);
            if (warningHueDist < CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR) {
              failures.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and --severity-warning (hue ${warningHL.hue.toFixed(1)}) are only ${warningHueDist.toFixed(1)} degrees apart -- below the ${CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR}-degree floor (the first gate round 2 candidate measured only 16-17 degrees here, exactly the regression this check exists to catch).`);
            } else {
              findings.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and --severity-warning (hue ${warningHL.hue.toFixed(1)}) are ${warningHueDist.toFixed(1)} degrees apart (>=${CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR}).`);
            }
          }
        }
      } catch (err) {
        failures.push(`${theme.name}: ${err.message}`);
      }

      // ---- Settings screen, Appearance section: confirm this preset is marked "Current". ----
      await openSettingsAppearance(cdp);
      const markedCurrent = await cdp.evaluate(`(() => {
        const row = document.querySelector('[role="radio"][aria-labelledby="theme-option-${theme.id}-name"]');
        return row ? row.getAttribute('aria-checked') : null;
      })()`);
      if (markedCurrent !== 'true') failures.push(`${theme.name}: Appearance section's own radio row is not marked current (aria-checked=${markedCurrent}).`);
      else findings.push(`${theme.name}: Appearance section marks this preset current (aria-checked=true).`);
      const settingsShot = `${theme.id}-01-settings-appearance.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, settingsShot));
      shotNames.push(settingsShot);
      await closeSettingsBackToChat(cdp);

      // ---- Item 13: persistence across a full stop-and-relaunch, for THIS preset specifically
      // (both new presets get their own relaunch cycle, not only the last one standing). ----
      const settingsBeforeRelaunch = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
      if (settingsBeforeRelaunch.theme !== theme.id) {
        failures.push(`${theme.name}: settings.json before relaunch has theme ${JSON.stringify(settingsBeforeRelaunch.theme)}, expected ${JSON.stringify(theme.id)}.`);
      } else {
        findings.push(`${theme.name}: settings.json on disk (before relaunch) has theme: ${JSON.stringify(theme.id)}.`);
      }

      cdp.close();
      cdp = null;
      await stopLauncher(child).catch(() => {});
      child = null;
      port = await getFreePort();
      launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, `app-${theme.id}-relaunch.log`) });
      child = launched.child;
      targetPid = launched.targetPid;
      wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
      cdp = await CdpSession.connect(wsUrl);
      if (!isTargetOwningPort(port, targetPid)) {
        throw new Error(`verify-551: relaunch CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
      }
      assertExeUnchanged(exePath, exeHash, `post-relaunch-${theme.id}`, 'verify-551');

      // Gate round 2 item 3: reading `document.documentElement.className` immediately after
      // the CDP socket connects can race the document's own parse -- the class can briefly
      // read empty even when the bootstrap script has already run. Wait for the document to be
      // past `loading` AND for a non-empty class before trusting the read.
      await cdp.waitFor(`document.readyState !== 'loading' && document.documentElement.className.length > 0`, {
        timeoutMs: 15_000,
        label: 'Relaunch: document ready, <html> class non-empty'
      });
      const classAtFirstObservableFrame = await cdp.evaluate(`document.documentElement.className`);
      if (!classAtFirstObservableFrame.includes(`theme-${theme.id}`)) {
        failures.push(`${theme.name}: relaunch <html> class is "${classAtFirstObservableFrame}", expected it to already include "theme-${theme.id}" at the first observable frame -- no flash of another preset.`);
      } else {
        findings.push(`${theme.name}: relaunch <html> class already includes theme-${theme.id} at the first observable frame (${classAtFirstObservableFrame}), no flash.`);
      }

      await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered' });
      await cdp.click(`document.querySelector('[data-session-open]')`);
      await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
        timeoutMs: 90_000,
        label: 'Relaunch: Session reattached, composer enabled'
      });
      const relaunchShot = `${theme.id}-03-relaunch-persisted.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, relaunchShot));
      shotNames.push(relaunchShot);
      findings.push(`${theme.name}: Session reattached after relaunch, screenshot captured.`);
    }

    // ---- Item 14: Dark (high contrast) -- real red-on-hover at 7:1, a code-block + Mermaid
    // turn, the open Theme submenu screenshotted, then back to Dark. ----
    try {
      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await sleep(200);
      const hcClass = await cdp.evaluate(`document.documentElement.className`);
      if (!hcClass.includes('theme-dark-high-contrast')) {
        failures.push(`Dark (high contrast): <html> class is "${hcClass}" after switching, expected theme-dark-high-contrast.`);
      } else {
        findings.push(`Dark (high contrast): real <html> class confirmed (${hcClass}).`);
      }

      // Real hover: a genuine mouseMoved over the session row, then read the REAL hover fill
      // (gate round 2, item 2: `[data-session-open]` -- the button itself -- has a transparent
      // own background; the fill actually painted on hover/selected is `bg-sidebar-accent` on
      // its parent `<div>`, SessionRow.tsx:193-198. Reading the button's own background
      // silently parses as opaque black and can never fail this check -- read the parent
      // instead and fail outright if its own alpha is below 1 (gate round 3 item 2 tightened
      // this from "alpha is 0" -- a partially transparent backdrop has the same underlying
      // problem, just milder), rather than let a non-opaque read through as if it were opaque.
      // `--severity-error`/`--state-stopped`/`--pr-closed` are three separate literal duplicates
      // in this theme (#570's own "literal copies, not var aliases" rule) that happened to share
      // one value before this story's own fix -- all three are checked against the SAME real
      // backdrop here so a future value split would be caught, not just the one this story
      // directly retuned.
      const rowRect = await cdp.evaluate(`(() => {
        const row = ${SESSION_ROW_FINDER};
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!rowRect) {
        notExercised.push('Dark (high contrast): no session row found to hover for the real red-on-hover read.');
      } else {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
        await sleep(150);
        const hoverBackground = await cdp.evaluate(`(() => {
          const row = ${SESSION_ROW_FINDER};
          const backdrop = row ? row.parentElement : null;
          return backdrop ? getComputedStyle(backdrop).backgroundColor : null;
        })()`);
        const backdropEntry = hoverBackground ? parseComputedColorToEntry(hoverBackground) : null;
        if (!hoverBackground || !backdropEntry) {
          failures.push(`Dark (high contrast): could not read the real hovered row's parent backdrop (${hoverBackground}).`);
        } else if (backdropEntry.alpha < 1) {
          failures.push(`Dark (high contrast): the real hovered row backdrop (${hoverBackground}) has alpha ${backdropEntry.alpha} (<1) -- its true rendered colour depends on whatever paints behind it, which this check cannot see, so a contrast ratio computed directly against it would be unreliable.`);
        } else {
          for (const [label, varName] of [['--severity-error', '--severity-error'], ['--state-stopped', '--state-stopped'], ['--pr-closed', '--pr-closed']]) {
            const redRaw = await requireResolvedCssVarColor(cdp, varName, 'color');
            const redOnHoverRatio = measuredContrastRatio(redRaw, hoverBackground);
            if (redOnHoverRatio === null) {
              failures.push(`Dark (high contrast): could not parse ${label} (${redRaw}) against the real hovered row backdrop (${hoverBackground}) for a measured ratio.`);
            } else if (redOnHoverRatio < 7) {
              failures.push(`Dark (high contrast): ${label} on the real hovered row backdrop measures ${redOnHoverRatio.toFixed(2)}:1, below this theme's own declared 7:1 high-contrast target.`);
            } else {
              findings.push(`Dark (high contrast): ${label} on the real hovered row backdrop measures ${redOnHoverRatio.toFixed(2)}:1 (>=7:1).`);
            }
          }
        }
      }

      // One real turn: asks for a fenced code block and a tiny Mermaid diagram, so the code
      // block/diagram screenshot shows this theme's REAL syntax/diagram colours, not a static
      // mock. Spends real model tokens -- the one place this script does.
      await cdp.click(`document.querySelector('[aria-label="Message"]')`);
      await cdp.send('Input.insertText', {
        text: 'Reply with exactly: a 5-line Python fenced code block (any simple function), then a tiny mermaid flowchart fenced block with 3 nodes (A-->B-->C). No other text before or after.'
      });
      await cdp.click(SEND_BUTTON_FINDER);
      const codeRendered = await cdp
        .waitFor(`!!document.querySelector('pre code, .shiki, .hljs')`, { timeoutMs: 120_000, label: 'Code block rendered in the transcript' })
        .then(() => true, () => false);
      if (!codeRendered) {
        notExercised.push('Dark (high contrast): the requested code block/Mermaid turn did not render within the timeout -- real `omp` turn latency, not a static check.');
      } else {
        await sleep(500);
        const codeShot = 'dark-high-contrast-04-code-and-mermaid.png';
        await cdp.screenshot(path.join(SHOTS_DIR, codeShot));
        shotNames.push(codeShot);
        findings.push('Dark (high contrast): code block (and Mermaid diagram, if the model included one) screenshot captured after a real turn.');
      }

      // Screenshot the OPEN Theme submenu itself (not just the already-closed picker).
      await cdp.click(`document.querySelector('[data-profile-name-button]')`);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile dropdown menu open' });
      const themeTriggerFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Theme'))`;
      await cdp.click(themeTriggerFinder);
      const submenuOpen = await cdp.waitFor(`!!document.querySelector('[role="menu"] [role="menu"]')`, { timeoutMs: 10_000, label: 'Theme submenu open' }).then(
        () => true,
        () => false
      );
      if (!submenuOpen) {
        failures.push('Theme submenu did not open from the Profile menu.');
      } else {
        const submenuShot = 'profile-menu-05-theme-submenu-open.png';
        await cdp.screenshot(path.join(SHOTS_DIR, submenuShot));
        shotNames.push(submenuShot);
        findings.push('Open Theme submenu screenshot captured.');
      }
      await pressEscape(cdp);
      await pressEscape(cdp);
      await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu closed' }).catch(() => {});

      // ---- Back to Dark, confirmed. ----
      await switchTheme(cdp, 'dark', 'Dark');
      await sleep(200);
      const finalClass = await cdp.evaluate(`document.documentElement.className`);
      if (!finalClass.includes('theme-dark') || finalClass.includes('theme-dark-high-contrast')) {
        failures.push(`Final switch-back: <html> class is "${finalClass}", expected plain theme-dark.`);
      } else {
        findings.push(`Final switch-back to Dark confirmed (${finalClass}).`);
      }
    } catch (err) {
      failures.push(`Dark (high contrast) pass: ${err.message}`);
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      screenshots: citeScreenshots(SHOTS_DIR, shotNames),
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-551: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-551: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-551: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-551: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-551: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    // Gate round 3 item 5: "Add repository" above creates a real Session worktree sibling to
    // repoDir, the same convention every other verify-5xx/9xx script's `worktreesDirFor` removes.
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-551: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
