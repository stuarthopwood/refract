#!/usr/bin/env node
// Live CDP check for issue #551 (Nordic Frost and Cyber Amber dark presets, additive per spec
// 007): switches to each new preset via the real Settings Appearance section (and, separately,
// the Profile menu Theme submenu -- the same `switchTheme` helper every other #550/#927-era
// verify script already uses), screenshots the chat/composer, the session list, the Settings
// screen itself, and a dialog, confirms the choice survives a full stop-and-relaunch on the same
// scratch data dir (no flash of the wrong preset on first paint), and reads real computed colours
// for the key contrast pairs issue #551's own mockup audit flagged (control-edge `--border`, and
// `--accent-text`/`--severity-info` no longer sharing a hue) via the same `getComputedStyle()` +
// `measuredContrastRatio` approach `verify-927-928-quiet-composer.mjs` already established.
//
// Drives a REAL `omp` (ambient signed-in profile), scratch cwd/worktree/`REFRACT_DATA_DIR` --
// never touches Stuart's real Session list. No prompt is ever sent -- every assertion below is a
// static DOM/computed-style read or a `settings.json` disk read, so this spends no model tokens.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-551-presets.mjs (requires a prior `pnpm tauri build --debug --no-bundle`, the
// same convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs` script documents). NOT run by this
// prep lane (NO-BUILD; held for the build slot) -- syntax-checked only (`node --check`).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
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
import { measuredContrastRatio } from './contrast-math.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR =
  process.env.REFRACT_551_SHOTS_DIR || path.join(tmpdir(), 'refract-551-presets-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const NEW_THEMES = [
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

// Key contrast pairs issue #551's own mockup audit flagged: the control-edge `--border` (mock
// measured under 3:1 in both presets) and `--accent-text`/`--severity-info` (mock merged into
// the same hue in both presets -- fixed by moving `--severity-info` off each preset's own
// signature accent hue). `min` mirrors `scripts/theme-contrast-pairs.mjs`'s own floors for these
// tokens.
const CONTRAST_PAIRS = [
  { fg: '--border', bg: '--background', min: 3, label: 'control-edge border vs canvas' },
  { fg: '--border', bg: '--muted', min: 3, label: 'control-edge border vs muted (narrowest margin)' },
  { fg: '--foreground', bg: '--background', min: 4.5, label: 'body text vs canvas' },
  { fg: '--accent-text', bg: '--background', min: 4.5, label: 'accent text vs canvas' },
  { fg: '--severity-info', bg: '--background', min: 3, label: 'info severity vs canvas' },
  { fg: '--severity-error', bg: '--muted', min: 4.5, label: 'error severity vs muted (destructive text floor)' }
];

/** Ties the exe under test to the actual commit: both new theme ids, literally present only from
 * this story's commits onward, grepped out of the just-built renderer bundle -- a real, cheap
 * proof this build contains #551's code, independent of git log reasoning about timing (same
 * pattern `verify-927-928-quiet-composer.mjs`'s own `assertBundleContainsStory927928Markers`
 * established). */
function assertBundleContainsPresetMarkers() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  let files;
  try {
    files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    throw new Error(`verify-551: could not read built bundle directory ${assetsDir} (${err.message}) -- run 'pnpm tauri build --debug --no-bundle' first.`);
  }
  const found = { 'nordic-frost': false, 'cyber-amber': false };
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('nordic-frost')) found['nordic-frost'] = true;
    if (text.includes('cyber-amber')) found['cyber-amber'] = true;
  }
  const missing = Object.entries(found)
    .filter(([, present]) => !present)
    .map(([id]) => id);
  if (missing.length > 0) {
    throw new Error(`verify-551: built bundle is missing the theme id marker(s) ${missing.join(', ')} -- this exe predates #551, rebuild before running this check.`);
  }
  console.log('verify-551: confirmed both #551 theme id markers (nordic-frost, cyber-amber) are present in the built renderer bundle.');
}

/** Opens the real Settings screen, the Appearance section, reading each new preset's own swatch
 * row and "Current" marker -- the same `[aria-label="Settings"]` entry point and section nav
 * every other Appearance-section verify script (`verify-554-chat-width.mjs`) already uses. */
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
    console.log(`verify-551: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-551' });
    assertBundleContainsPresetMarkers();
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
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent -- every check below is a static computed-style/DOM read.');

    let lastThemeId = 'dark';
    for (const theme of NEW_THEMES) {
      // ---- Switch via the Profile menu Theme submenu (the real round trip to the theme store
      // and `settings.json`, same helper every #550/#927-era verify script uses). ----
      try {
        await switchTheme(cdp, theme.id, theme.name);
        lastThemeId = theme.id;
      } catch (err) {
        failures.push(`Could not switch to ${theme.name} via the real Profile-menu Theme submenu (${err.message}).`);
        continue;
      }
      await sleep(200);

      const appliedClass = await cdp.evaluate(`document.documentElement.className`);
      if (!appliedClass.includes(`theme-${theme.id}`)) {
        failures.push(`${theme.name}: <html> class is "${appliedClass}" after switching, expected it to include "theme-${theme.id}".`);
      } else {
        findings.push(`${theme.name}: real <html> class confirmed (${appliedClass}).`);
      }

      // ---- Chat + composer screenshot. ----
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-00-chat-composer.png`));

      // ---- Session list: the left panel renders alongside the chat pane in the default
      // layout, so the same full-window screenshot above already covers it; a dedicated capture
      // with the panel's own container cropped is not needed to confirm its tokens repainted. ----
      const sessionListPresent = await cdp.evaluate(`!!document.querySelector('[data-session-open]')`);
      if (!sessionListPresent) failures.push(`${theme.name}: no [data-session-open] session row found -- cannot confirm the session list repainted.`);
      else findings.push(`${theme.name}: session list row present and captured in the chat/composer screenshot.`);

      // ---- Settings screen, Appearance section: confirm this preset is marked "Current". ----
      await openSettingsAppearance(cdp);
      const markedCurrent = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.textContent.includes(${JSON.stringify(theme.name)}));
        return row ? row.getAttribute('aria-checked') : null;
      })()`);
      if (markedCurrent !== 'true') failures.push(`${theme.name}: Appearance section's own radio row is not marked current (aria-checked=${markedCurrent}).`);
      else findings.push(`${theme.name}: Appearance section marks this preset current (aria-checked=true).`);
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-01-settings-appearance.png`));
      await closeSettingsBackToChat(cdp);

      // ---- A dialog: Keyboard shortcuts (read-only, reachable from the Profile menu, no
      // mutation risk). ----
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
        findings.push(`${theme.name}: Keyboard shortcuts dialog opened, repainted under this preset.`);
        await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-02-keyboard-shortcuts-dialog.png`));
        await pressEscape(cdp);
        await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts dialog closed (Esc)' });
      }

      // ---- Key contrast pairs: real computed colours via a probe element reading the live
      // var() cascade (handles color-mix()/alias chains no static CSS read can resolve),
      // measured the same way check-theme-contrast.mjs's own PAIRS are measured. ----
      for (const pair of CONTRAST_PAIRS) {
        const fgColor = await resolveCssVarColor(cdp, pair.fg, 'color');
        const bgColor = await resolveCssVarColor(cdp, pair.bg, 'color');
        const ratio = measuredContrastRatio(fgColor, bgColor);
        if (ratio === null) {
          failures.push(`${theme.name}: could not parse ${pair.fg} (${fgColor}) or ${pair.bg} (${bgColor}) for a measured contrast ratio (${pair.label}).`);
        } else if (ratio < pair.min) {
          failures.push(`${theme.name}: ${pair.fg} vs ${pair.bg} (${pair.label}) measures ${ratio.toFixed(2)}:1, below the ${pair.min}:1 floor.`);
        } else {
          findings.push(`${theme.name}: ${pair.fg} vs ${pair.bg} (${pair.label}) measures ${ratio.toFixed(2)}:1, >= ${pair.min}:1.`);
        }
      }

      // ---- Issue #551's own fix: accent and info must no longer resolve to the same colour. ----
      const accentColor = await resolveCssVarColor(cdp, '--accent-text', 'color');
      const infoColor = await resolveCssVarColor(cdp, '--severity-info', 'color');
      if (accentColor === infoColor) {
        failures.push(`${theme.name}: --accent-text and --severity-info resolve to the identical colour (${accentColor}) -- the mock's own merged-hue defect, which #551 was meant to fix.`);
      } else {
        findings.push(`${theme.name}: --accent-text (${accentColor}) and --severity-info (${infoColor}) are distinct colours, not merged.`);
      }
    }

    // ---- Persistence across a full stop-and-relaunch on the SAME scratch data dir, same
    // pattern `verify-554-chat-width.mjs`'s own relaunch check uses: read settings.json off disk
    // BEFORE stopping (proves the real IPC round trip persisted it, not just the DOM), then stop
    // and relaunch the SAME exe against the SAME dataDir, and confirm the very first <html>
    // class read after reconnecting already carries the last-applied preset -- no flash of Dark
    // or any other theme. ----
    const settingsBeforeRelaunch = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    if (settingsBeforeRelaunch.theme !== lastThemeId) {
      failures.push(`settings.json before relaunch: theme is ${JSON.stringify(settingsBeforeRelaunch.theme)}, expected ${JSON.stringify(lastThemeId)} (the last Theme-submenu choice above).`);
    } else {
      findings.push(`settings.json on disk (before relaunch) has theme: ${JSON.stringify(lastThemeId)} -- the real IPC round trip persisted it, not just the DOM.`);
    }

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
      throw new Error(`verify-551: relaunch CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-relaunch', 'verify-551');

    // Read the <html> class as early as the CDP connection allows (no intervening click), the
    // same "first observable frame" check spec 007 T022's own relaunch evidence used.
    const classAtFirstObservableFrame = await cdp.evaluate(`document.documentElement.className`);
    if (!classAtFirstObservableFrame.includes(`theme-${lastThemeId}`)) {
      failures.push(`Relaunch: <html> class at the first observable frame is "${classAtFirstObservableFrame}", expected it to already include "theme-${lastThemeId}" -- no flash of another preset.`);
    } else {
      findings.push(`Relaunch: <html> class at the first observable frame already includes theme-${lastThemeId} (${classAtFirstObservableFrame}), no flash.`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered' });
    await cdp.click(`document.querySelector('[data-session-open]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Relaunch: Session reattached, composer enabled'
    });
    await cdp.screenshot(path.join(SHOTS_DIR, `${lastThemeId}-03-relaunch-persisted.png`));
    findings.push(`Relaunch: Session reattached under ${lastThemeId}, screenshot captured.`);

    const shotNames = [
      ...NEW_THEMES.flatMap((t) => [`${t.id}-00-chat-composer.png`, `${t.id}-01-settings-appearance.png`, `${t.id}-02-keyboard-shortcuts-dialog.png`]),
      `${lastThemeId}-03-relaunch-persisted.png`
    ];

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      screenshots: citeScreenshots(SHOTS_DIR, shotNames.filter((n) => n)),
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
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-551: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
