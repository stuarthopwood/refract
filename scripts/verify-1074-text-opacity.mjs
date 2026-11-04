#!/usr/bin/env node
// Live CDP check for #1074: in every built-in theme, header/chat/muted text render at the softened
// alpha (0.9/0.78/0.6 over `--background`; solid in Dark high contrast and on coloured fills), the
// painted pixels really composite, and Mermaid Journey labels stay solid.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 node
// scripts/verify-1074-text-opacity.mjs (requires a prior `pnpm tauri build --debug --no-bundle`).

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';
import { PILL, clearAndType } from './verify-1050-command-pill-helpers.mjs';
import { requireResolvedCssVarColor } from './verify-551-helpers.mjs';
import { parseComputedColorToEntry, compositeOverLinear, resolvedLinear, relativeLuminance, srgbGammaEncode } from './contrast-math.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';
import {
  SEND_BUTTON_FINDER,
  HEADER_FINDER,
  CHAT_PROSE_FINDER,
  BADGE_FINDER,
  readRealColours,
  readBadgeColour,
  openSettingsAppearance,
  closeSettingsBackToChat,
  capturePngBase64,
  decodePixelRegion,
  brightestPixel,
  scrollTranscriptToShow,
  assertJourneyLabelsSolid
} from './verify-1074-text-opacity-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1074';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1074_SHOTS_DIR || path.join(tmpdir(), 'refract-1074-text-opacity-shots');

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];
const SOLID_THEME_IDS = new Set(['dark-high-contrast']);
// The badge (`secondary`) aliases `--foreground`, so it shares the header tier.
const EXPECTED_ALPHA = { header: 0.9, badge: 0.9, chat: 0.78, muted: 0.6 };
const ALPHA_EPSILON = 0.01;
// Tight: the prediction composites over the real `bg-accent/50` bubble fill, so only antialiasing slack remains.
const PIXEL_TOLERANCE = 4; // per sRGB byte channel, 0-255.
function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = [
    // Genuine skips this check cannot exercise.
    'Windows Forced Colors mode (forced-colors: active): every opacity-softened token above is overridden by the OS high-contrast palette in that mode -- never exercised here (this run always has it off).',
    'Emoji glyph rendering: emoji in chat prose paint via the font/platform\'s own colour (COLR/CBDT) layer, bypassing `color`/`--chat-foreground` entirely -- the pixel-compositing check below samples the brightest pixel in the rect, which could be an emoji glyph rather than text; not isolated or verified separately here.',
    'High-DPI rendering (devicePixelRatio != 1): the pixel-compositing check below now REFUSES to run unless devicePixelRatio === 1 (a correctness fix, not a workaround -- sampling a captured PNG\'s device pixels against a CSS-pixel rect only lines up 1:1 at DPR 1), so icon-stroke/text-opacity overlap at a scaled DPR is never exercised by this script.',
    'The "Focused" session badge (`ChatHeader.tsx`, `--active-indicator-foreground`, gate round 3 fix): only renders when a SECOND Session is open in a split pane (`isSplit`) -- this script\'s single-pane flow never opens a split, so the badge\'s real rendered colour is never read live here. Static: the token is a plain solid white in every theme (`globals.css`), clearing 4.5:1 trivially against any of this badge\'s own tinted fills.',
    'Mermaid `titleColor` (gate round 3 fix): governs flowchart `.cluster text` (subgraph titles); the fixture\'s own flowchart fence (`flowchart TD\\n A[Start] --> B[End]`) has no subgraph, so this token is never actually painted by either mermaid fence in this fixture -- fixed statically (same 0.9-tier formula as `primaryTextColor`), not live-verified.'
  ]; // Genuine skips only.
  const shotNames = [];

  const gitHeadSha = gitHead(REPO_ROOT);
  const gitStatusResult = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
  const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
  const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${gitHeadSha}${dirty === true ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

  clearKnownOutputFiles(
    SHOTS_DIR,
    'refract-1074-text-opacity-shots',
    [...THEMES.flatMap((t) => [`${t.id}-00-chat.png`, `${t.id}-01-manage-sessions.png`, `${t.id}-02-settings-appearance.png`, `${t.id}-03-popover-menu.png`, `${t.id}-04-selected-text.png`, `${t.id}-05-settings-appearance.png`, `${t.id}-06-switch-off.png`, `${t.id}-07-composer-selection.png`, `${t.id}-08-journey-diagram.png`]), 'report.json', 'app.log', 'fake-omp-invocations.log']
  );

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1074-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1074-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1074-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1074-text-opacity');
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1074-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1074-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1074-shim-'));

  let child;
  let cdp;
  let exeHash = null;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const port = await getFreePort();
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', LOG);

    if (!existsSync(debugLogPath)) {
      throw new Error(`${LOG}: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`${LOG}: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup marker; got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

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
    findings.push('Session created; fake-omp process attached (997-notice-severity scenario, reused per AGENTS.md "no new fixtures").');

    await cdp.typeIntoByLabel('Message', 'trigger the scripted notices');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${CHAT_PROSE_FINDER})`, { timeoutMs: 30_000, label: 'Echoed user message rendered (.text-chat-foreground)' });
    await sleep(300);

    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
        await sleep(250);
        const appliedClass = await cdp.evaluate(`document.documentElement.className`);
        if (!appliedClass.includes(`theme-${theme.id}`)) {
          failures.push(`${theme.name}: <html> class is "${appliedClass}" after switching, expected it to include "theme-${theme.id}".`);
          continue;
        }
        findings.push(`${theme.name}: real <html> class confirmed (${appliedClass}).`);

        const real = await readRealColours(cdp);
        const missing = Object.entries(real).filter(([, v]) => v === null).map(([k]) => k);
        if (missing.length > 0) {
          failures.push(`${theme.name}: these real elements/colours could not be read (selector matched nothing): ${missing.join(', ')}.`);
        }

        const assertions = [
          ['header (ChatHeader session name, inherits text-foreground)', real.header, await requireResolvedCssVarColor(cdp, '--foreground', 'color')],
          ['chat prose (echoed user message)', real.chat, await requireResolvedCssVarColor(cdp, '--chat-foreground', 'color')],
          ['muted text (StatusBar footer)', real.muted, await requireResolvedCssVarColor(cdp, '--muted-foreground', 'color')],
          ['Send button fill (a coloured, non-neutral fill)', real.sendBackground, await requireResolvedCssVarColor(cdp, '--send', 'background-color')],
          ['Send button label (a primary button on a coloured fill)', real.sendForeground, await requireResolvedCssVarColor(cdp, '--send-foreground', 'color')]
        ];
        for (const [label, actual, expected] of assertions) {
          if (actual === null) continue; // already reported in `missing` above
          if (actual !== expected) {
            failures.push(`${theme.name}: ${label} measures ${actual}, expected it to equal its own token (${expected}).`);
          } else {
            findings.push(`${theme.name}: ${label} (${actual}) matches its own token.`);
          }
        }

        // The badge proves the `var(--foreground)` alias cascade resolves live in a second component.
        await cdp.click(`document.querySelector('[data-profile-name-button]')`);
        await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
          timeoutMs: 10_000,
          label: `${theme.name}: Profile dropdown menu open`
        });
        await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: `${theme.name}: Manage sessions screen opened` });
        await sleep(200);
        const badgeColour = await readBadgeColour(cdp);
        const badgeExpected = await requireResolvedCssVarColor(cdp, '--secondary-foreground', 'color');
        if (badgeColour === null) {
          failures.push(`${theme.name}: badge label (Manage sessions session-count Badge) could not be read -- selector matched nothing.`);
        } else if (badgeColour !== badgeExpected) {
          failures.push(`${theme.name}: badge label measures ${badgeColour}, expected it to equal --secondary-foreground (${badgeExpected}).`);
        } else {
          findings.push(`${theme.name}: badge label (${badgeColour}) matches --secondary-foreground.`);
        }
        await settleForScreenshot(cdp);
        const manageShot = `${theme.id}-01-manage-sessions.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, manageShot));
        shotNames.push(manageShot);
        await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
        await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: `${theme.name}: Manage sessions closed, back in chat` });

        // The Send label stays solid in every theme (coloured fill).
        const solid = SOLID_THEME_IDS.has(theme.id);
        const alphaChecks = [
          ['header', real.header, solid ? 1 : EXPECTED_ALPHA.header],
          ['chat prose', real.chat, solid ? 1 : EXPECTED_ALPHA.chat],
          ['muted text', real.muted, solid ? 1 : EXPECTED_ALPHA.muted],
          ['badge label', badgeColour, solid ? 1 : EXPECTED_ALPHA.badge],
          ['Send button label', real.sendForeground, 1]
        ];
        for (const [label, raw, expectedAlpha] of alphaChecks) {
          if (raw === null) continue;
          const entry = parseComputedColorToEntry(raw);
          if (!entry) {
            failures.push(`${theme.name}: ${label} (${raw}) could not be parsed for a real alpha read.`);
            continue;
          }
          if (Math.abs(entry.alpha - expectedAlpha) > ALPHA_EPSILON) {
            failures.push(`${theme.name}: ${label} measures alpha ${entry.alpha.toFixed(3)}, expected ${expectedAlpha} (${solid || label === 'Send button label' ? 'solid' : 'FR-023 alpha tier'}).`);
          } else {
            findings.push(`${theme.name}: ${label} alpha ${entry.alpha.toFixed(3)} matches the expected ${expectedAlpha}.`);
          }
        }

        // The message sits above the scrolled-to-bottom view; a negative rect `y` would be clamped
        // by `samplePixelRegion` and sample unrelated chrome, so scroll it into view with real wheel events.
        const scrolled = await scrollTranscriptToShow(cdp, CHAT_PROSE_FINDER);
        if (!scrolled) {
          failures.push(`${theme.name}: chat-prose element has no scrollable ancestor to scroll it into view.`);
          continue;
        }
        // Screenshot first, then measure the rect, so it can't go stale. Sampling maps CSS px to
        // device px 1:1 only at devicePixelRatio 1.
        const pngData = await capturePngBase64(cdp);
        const chatRect = await cdp.evaluate(`(() => { const el = ${CHAT_PROSE_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio }; })()`);
        if (
          !chatRect ||
          chatRect.width < 1 ||
          chatRect.height < 1 ||
          chatRect.x < 0 ||
          chatRect.x + chatRect.width > chatRect.viewportWidth ||
          chatRect.y < 0 ||
          chatRect.y + chatRect.height > chatRect.viewportHeight
        ) {
          failures.push(`${theme.name}: chat-prose element has no real, fully-in-viewport paintable rect to sample after scrolling (${JSON.stringify(chatRect)}).`);
        } else if (chatRect.devicePixelRatio !== 1) {
          failures.push(`${theme.name}: devicePixelRatio is ${chatRect.devicePixelRatio}, not 1 -- the captured screenshot's device pixels would not line up 1:1 with this CSS-pixel rect.`);
        } else {
          // Predict over the real `bg-accent/50` user-bubble fill, not flat `--background`.
          const bgRaw = await requireResolvedCssVarColor(cdp, '--background', 'background-color');
          const accentRaw = await requireResolvedCssVarColor(cdp, '--accent', 'background-color');
          const fgEntry = parseComputedColorToEntry(real.chat);
          const bgEntry = parseComputedColorToEntry(bgRaw);
          const accentEntry = parseComputedColorToEntry(accentRaw);
          if (!fgEntry || !bgEntry || !accentEntry) {
            failures.push(`${theme.name}: could not parse --chat-foreground (${real.chat}), --background (${bgRaw}) or --accent (${accentRaw}) for the real pixel-compositing check.`);
          } else {
            const bubbleLinear = resolvedLinear({ raw: 'accent/50', alpha: 0.5, linear: accentEntry.linear }, bgEntry);
            const bubbleEntry = { raw: 'bubble', alpha: 1, linear: bubbleLinear };
            const expectedLinear = resolvedLinear(fgEntry, bubbleEntry);
            const expectedRgb = expectedLinear.map((c) => Math.round(srgbGammaEncode(c) * 255));
            const pixels = await decodePixelRegion(cdp, pngData, chatRect);
            const ink = brightestPixel(pixels);
            if (!ink) {
              failures.push(`${theme.name}: no pixels sampled from the chat-prose rect (${JSON.stringify(chatRect)}).`);
            } else {
              const diffs = [Math.abs(ink.r - expectedRgb[0]), Math.abs(ink.g - expectedRgb[1]), Math.abs(ink.b - expectedRgb[2])];
              const maxDiff = Math.max(...diffs);
              if (maxDiff > PIXEL_TOLERANCE) {
                failures.push(`${theme.name}: brightest real painted chat-prose pixel is rgb(${ink.r},${ink.g},${ink.b}), expected close to the gamma-composited --chat-foreground-over-user-bubble prediction rgb(${expectedRgb.join(',')}) (max channel diff ${maxDiff}, tolerance ${PIXEL_TOLERANCE}).`);
              } else {
                findings.push(`${theme.name}: real painted chat-prose ink rgb(${ink.r},${ink.g},${ink.b}) is within ${maxDiff} of the predicted composited rgb(${expectedRgb.join(',')}) -- the opacity genuinely composites on screen.`);
              }
            }
          }
        }

        // Journey task/section labels sit on coloured fills and must not inherit the softened textColor.
        await assertJourneyLabelsSolid(cdp, theme, findings, failures);

        // Capture the Journey diagram as visible evidence for the solid labels.
        await cdp.evaluate(`(() => { const imgs = document.querySelectorAll('img[role="img"]'); const el = imgs[1]; if (el) el.scrollIntoView({ block: 'center' }); })()`);
        await settleForScreenshot(cdp);
        const journeyShot = `${theme.id}-08-journey-diagram.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, journeyShot));
        shotNames.push(journeyShot);
        // The selected-text step below recomputes the chat-prose rect, so restore its scroll position.
        await cdp.evaluate(`(() => { const el = ${CHAT_PROSE_FINDER}; if (el) el.scrollIntoView({ block: 'center' }); })()`);
        await settleForScreenshot(cdp);

        // `settleForScreenshot` runs before every shot and throws if a tooltip/hover card is open.
        await settleForScreenshot(cdp);
        const chatShot = `${theme.id}-00-chat.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
        shotNames.push(chatShot);

        // The popover items use `--popover-foreground` (aliases `--foreground`).
        await cdp.click(`document.querySelector('[data-profile-name-button]')`);
        await cdp.waitFor(`!!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 10_000, label: `${theme.name}: Profile dropdown menu open` });
        await sleep(150);
        const popoverShot = `${theme.id}-03-popover-menu.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, popoverShot));
        shotNames.push(popoverShot);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await cdp.waitFor(`!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 5_000, label: `${theme.name}: Profile dropdown menu closed` });

        // A real double-click selection (not a synthetic Range) under the browser's default highlight.
        await settleForScreenshot(cdp);
        const chatProseCentre = await cdp.evaluate(`(() => { const el = ${CHAT_PROSE_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (!chatProseCentre) {
          notExercised.push(`${theme.name}: selected-text screenshot skipped -- chat-prose element not found at screenshot time.`);
        } else {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chatProseCentre.x, y: chatProseCentre.y, button: 'left', clickCount: 2 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chatProseCentre.x, y: chatProseCentre.y, button: 'left', clickCount: 2 });
          await cdp.waitFor(`(window.getSelection()?.toString().length ?? 0) > 0`, { timeoutMs: 3_000, label: `${theme.name}: chat-prose word selected` });
          const selectedTextShot = `${theme.id}-04-selected-text.png`;
          await cdp.screenshot(path.join(SHOTS_DIR, selectedTextShot));
          shotNames.push(selectedTextShot);
          await cdp.evaluate(`window.getSelection()?.removeAllRanges()`);
        }

        // Visual only. `settleForScreenshot` blurs and presses Escape, which would clear the
        // selection, so it must run before Ctrl+A and nothing may run between Ctrl+A and the shot.
        await settleForScreenshot(cdp);
        await clearAndType(cdp, pressKey, '/btw hi');
        await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: `${theme.name}: command pill appears` });
        await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, pill included
        const composerSelectionShot = `${theme.id}-07-composer-selection.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, composerSelectionShot));
        shotNames.push(composerSelectionShot);
        await clearAndType(cdp, pressKey, ''); // restore the composer to empty before Settings

        await settleForScreenshot(cdp);
        await openSettingsAppearance(cdp);
        await sleep(200);
        await settleForScreenshot(cdp);
        const settingsShot = `${theme.id}-05-settings-appearance.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, settingsShot));
        shotNames.push(settingsShot);

        // Toggle off then restore, so reruns and later themes see the default.
        await cdp.click(`document.querySelector('#watermark-toggle')`);
        await cdp.waitFor(`document.querySelector('#watermark-toggle')?.getAttribute('aria-checked') === 'false'`, { timeoutMs: 5_000, label: `${theme.name}: watermark toggle switched off` });
        await settleForScreenshot(cdp);
        const switchOffShot = `${theme.id}-06-switch-off.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, switchOffShot));
        shotNames.push(switchOffShot);
        await cdp.click(`document.querySelector('#watermark-toggle')`);
        await cdp.waitFor(`document.querySelector('#watermark-toggle')?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: `${theme.name}: watermark toggle restored on` });

        await closeSettingsBackToChat(cdp);

        findings.push(`${theme.name}: screenshots captured (chat, popover menu, selected text, composer-selection pill, Manage sessions, Settings Appearance, Off switch, Journey diagram).`);
      } catch (err) {
        failures.push(`${theme.name}: ${err.message}`);
      }
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
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${LOG}: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
    await safeRmSync(shimDir);
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
