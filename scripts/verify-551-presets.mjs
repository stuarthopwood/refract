#!/usr/bin/env node
// Live CDP check for #551: Nordic Frost and Cyber Amber presets switch via two different real paths (Settings > Appearance, Profile
// menu), persist across a relaunch, and meet rendered-surface contrast and OKLab hue/lightness separation; Dark (high contrast) is
// also checked, including one real prompt (the script's only model spend).
// Needs a prior `pnpm tauri build --debug --no-bundle`; uses a scratch data dir, never the real Session list.

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

// Hue floor sits below the 16-17 degree candidate that failed. The swatch floor is lowered to 1.4 (#1039): no accent clears both
// 1.5:1 against `--severity-error` and error-text >=4.5:1 everywhere, and text contrast won (accessibility.md accepted departure).
const CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR = 1.4;
const CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR = 30;

const SESSION_ROW_FINDER = `document.querySelector('[data-session-open]')`;
const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;

/** Reads real rendered surfaces' computed colours and backdrops (no hidden probes) for `measuredContrastRatio`. The row title's
 * backdrop is its nearest ancestor `<div>`, since the intervening `<span>`/`<button>` paint no fill. Call once the list and composer are mounted. */
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

/** The Keyboard shortcuts dialog's background and box-shadow ring. `DialogContent` draws its edge as `ring-1 ring-foreground/10`,
 * not a CSS border, so the result is informational only, never a pass/fail gate. */
async function readRealDialogSurfaces(cdp) {
  return cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const cs = getComputedStyle(dialog);
    return { borderColor: cs.borderColor, boxShadow: cs.boxShadow, background: cs.backgroundColor };
  })()`);
}

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

/** Switches via the Settings > Appearance picker (live preview, then Save) rather than the Profile-menu route. */
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
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

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
        // A session row is on screen here, so a missed selector is a DOM-shape regression, not a notExercised absence.
        failures.push(`${theme.name}: session-list row title or sidebar background selector matched nothing, though a session row is known to be on screen at this point.`);
      } else {
        const sidebarEntry = parseComputedColorToEntry(realSurfaces.sidebarBackground);
        if (!sidebarEntry) {
          failures.push(`${theme.name}: could not parse the real sidebar background (${realSurfaces.sidebarBackground}) for alpha/colour.`);
        } else if (sidebarEntry.alpha < 1) {
          // alpha < 1: the true colour depends on whatever paints behind it, which this check never reads, so a ratio would be unreliable.
          failures.push(`${theme.name}: the real session-row backdrop (${realSurfaces.sidebarBackground}) has alpha ${sidebarEntry.alpha} (<1) -- its true rendered colour depends on whatever paints behind it, which this check cannot see.`);
        } else {
          const rowRatio = measuredContrastRatio(realSurfaces.sessionRowText, realSurfaces.sidebarBackground);
          if (rowRatio === null) failures.push(`${theme.name}: could not parse session-row text/sidebar background for a measured ratio.`);
          else if (rowRatio < 4.5) failures.push(`${theme.name}: session-row title text measures ${rowRatio.toFixed(2)}:1 on the real sidebar background, below 4.5:1.`);
          else findings.push(`${theme.name}: session-row title text measures ${rowRatio.toFixed(2)}:1 on the real sidebar background (>=4.5:1).`);
        }
      }

      // Keyboard shortcuts dialog: read-only, so no mutation risk.
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
          // The edge is a `ring-foreground/10` box-shadow, so `borderColor` renders nothing and no floor is asserted against it.
          findings.push(`${theme.name}: real Keyboard shortcuts dialog -- background ${dialogSurfaces.background}, box-shadow ${dialogSurfaces.boxShadow} (its real edge; informational only, this component has no CSS border to gate on).`);
        }
        const dialogShot = `${theme.id}-02-keyboard-shortcuts-dialog.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, dialogShot));
        shotNames.push(dialogShot);
        await pressEscape(cdp);
        await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts dialog closed (Esc)' });
      }

      // Compare real OKLab hue/lightness, not string inequality.
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

        // Cyber Amber only: accent vs error uses the lowered 1.4 swatch floor (#1039, accessibility.md "Accepted departures").
        if (theme.id === 'cyber-amber') {
          const errorRaw = await requireResolvedCssVarColor(cdp, '--severity-error', 'color');
          const swatchRatio = measuredContrastRatio(accentRaw, errorRaw);
          if (swatchRatio === null) {
            failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or --severity-error (${errorRaw}) for a measured swatch contrast ratio.`);
          } else if (swatchRatio < CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR) {
            failures.push(`${theme.name}: --accent-text (${accentRaw}) and --severity-error (${errorRaw}) measure only ${swatchRatio.toFixed(2)}:1 apart (swatch contrast) -- below the ${CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR}:1 this theme's own accepted departure established (docs/design/accessibility.md "Accepted departures").`);
          } else {
            findings.push(`${theme.name}: --accent-text and --severity-error measure ${swatchRatio.toFixed(2)}:1 apart (swatch contrast), clearing the decided ${CYBER_AMBER_ACCENT_ERROR_SWATCH_FLOOR}:1 separation.`);
          }

          // Accent-vs-warning hue distance; a 16-17 degree candidate once measured here after clipping and would now fail.
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

      // `className` read right after the CDP socket connects can race document parse and be empty; wait for non-`loading` and a non-empty class.
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

    try {
      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await sleep(200);
      const hcClass = await cdp.evaluate(`document.documentElement.className`);
      if (!hcClass.includes('theme-dark-high-contrast')) {
        failures.push(`Dark (high contrast): <html> class is "${hcClass}" after switching, expected theme-dark-high-contrast.`);
      } else {
        findings.push(`Dark (high contrast): real <html> class confirmed (${hcClass}).`);
      }

      // The hover fill is painted by `bg-sidebar-accent` on the button's parent `<div>` (SessionRow.tsx); the button's own background is
      // transparent and would parse as opaque black, so read the parent and fail if its alpha is below 1.
      // `--severity-error`/`--state-stopped`/`--pr-closed` are separate literal copies (#570) checked against the same backdrop so a value split is caught.
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

      // Spends real model tokens: the one place this script does.
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
    // "Add project" creates a Session worktree sibling to repoDir, which `worktreesDirFor` removes.
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
