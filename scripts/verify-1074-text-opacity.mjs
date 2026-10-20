#!/usr/bin/env node
// Live CDP check for issue #1074 (app-wide softer text via alpha): `--foreground`
// (headers/UI), `--chat-foreground` (body/chat prose) and `--muted-foreground` (low emphasis)
// move to white at 90%/78%/60% alpha, composited over each theme's own `--background`, in
// `dark`, `obsidian`, `nordic-frost` and `cyber-amber`; `dark-high-contrast` stays solid at its
// existing 7:1 text target (#552). Aliasing tokens (`card-foreground`, `popover-foreground`,
// `secondary-foreground`, `accent-foreground`, `sidebar-foreground`, `sidebar-accent-foreground`)
// resolve through `var(--foreground)` and so inherit the same alpha; foregrounds that sit on a
// coloured fill (`primary-foreground`, `send-foreground`, `destructive-foreground`,
// `sidebar-primary-foreground`, the `state-*-foreground`/`pr-*-foreground` tokens) stay solid.
//
// Reuses the existing, committed `997-notice-severity.jsonl` fixture (AGENTS.md: no new
// fixtures while prototyping; EXTENDING an existing tape, the same precedent #1039 set, is
// allowed) via `REFRACT_FAKE_OMP_SCENARIO=997-notice-severity`: one turn gives a real session, a
// real echoed user message (`.text-chat-foreground` Markdown), a real Manage sessions/Settings
// Appearance route, the same flow `verify-1039-amber-retune.mjs` already exercises, AND (gate
// round 3, Main's follow-up) a second rendered Mermaid diagram -- a Journey, appended this round
// -- whose task/section labels are asserted below.
//
// For each of the 5 built-in themes, switches via the real Profile-menu Theme submenu
// (`switchTheme`), then reads FIVE real rendered elements and asserts each equals its own CSS
// custom property's resolved colour (`requireResolvedCssVarColor`, never a hidden probe alone):
//   - a HEADER (`ChatHeader.tsx`'s session-name span, inherits `body`'s `text-foreground`) vs
//     `--foreground`.
//   - CHAT PROSE (the echoed user message's own `.text-chat-foreground` root) vs
//     `--chat-foreground`.
//   - MUTED TEXT (`StatusBar.tsx`'s own `<footer>`) vs `--muted-foreground`.
//   - a PRIMARY BUTTON LABEL (the real Send button, `bg-send text-send-foreground`) vs
//     `--send-foreground` -- FR-023's own named "stays solid on a coloured fill" case.
//   - a BADGE LABEL (`ManageSessionsScreen.tsx`'s own `<Badge variant="secondary">` session
//     count) vs `--secondary-foreground` -- proves the ALIAS cascade (`var(--foreground)`)
//     actually resolves live, in a second independent component, not only in CSS source.
// Then asserts each reading's real parsed alpha (`parseComputedColorToEntry`) matches what
// FR-023 requires: 0.9/0.78/0.6/0.9 (header/chat/muted/badge) in the four non-HC themes, 1
// (fully solid) in Dark (high contrast) and for the Send button's own label in EVERY theme.
// Finally samples the REAL PAINTED pixels of the chat-prose paragraph (a `Page.captureScreenshot`
// decoded via an offscreen `<canvas>`, the same dependency-free technique
// `verify-1050-command-pill-helpers.mjs`'s own `capturePixelRegion` uses) and asserts its
// brightest (most-inked) pixel is close to the colour this script's own gamma-space compositing
// math (`contrast-math.mjs`'s `compositeOverLinear`, the same primitive `check-theme-
// contrast.mjs` uses) predicts for `--chat-foreground` alpha-blended over `--background` -- so
// the opacity is proven to really composite on screen, not only in computed style.
// Also (gate round 3, Main's follow-up, item 1): decodes the second rendered Mermaid diagram's
// (the new Journey fence's) own SVG and asserts it contains this theme's solid `taskTextColor`
// literal -- Journey's task/section labels sit on Mermaid's own coloured `fillType0-7` fills
// and, left unfixed, would inherit the SOFTENED `textColor` instead (`mermaidTheme.ts`'s own
// comment on this fix has the full citation).
//
// Screenshots per theme: chat (chat prose plus the header and Send button all visible), a
// popover menu (the Profile dropdown), selected chat-prose text, a composer-selection shot (a
// real `/btw` command pill, Ctrl+A-selected -- round 3, Main's follow-up: proves
// `--composer-selection-fg` stays legible under a real native selection highlight in every
// preset, not only Dark), Manage sessions (the full Session list), Settings Appearance, and an
// Off switch (the Appearance section's own watermark
// toggle, clicked off then restored -- gate round 1, Low item 7). Every shot is preceded by
// `settleForScreenshot` (`verify-700-todo-pin-helpers.mjs`): moves the pointer, blurs, presses
// Escape, and THROWS if a stray tooltip/hover card is still open.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 node
// scripts/verify-1074-text-opacity.mjs (requires a prior `pnpm tauri build --debug --no-bundle`,
// the convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs`/`verify-10xx-*.mjs` script
// documents).

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
  scrollTranscriptToShow
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
// FR-023's own alpha tiers. `secondary` (the badge) aliases `--foreground` (headers/UI), not a
// fourth independent tier.
const EXPECTED_ALPHA = { header: 0.9, badge: 0.9, chat: 0.78, muted: 0.6 };
const ALPHA_EPSILON = 0.01;
// Gate-fix (Code/Test Medium): was 20, loose enough to hide a wrong prediction baseline (the
// old code predicted over flat `--background`, not the real `bg-accent/50` user-bubble fill the
// chat prose actually sits inside -- `userBubbleContrastRows`' own bubble math, below). Now that
// the prediction composites over that real bubble fill, 4 is font antialiasing/hinting slack only.
const PIXEL_TOLERANCE = 4; // per sRGB byte channel, 0-255.
// `taskTextColor` per theme (`src/shared/mermaidThemeData.ts`) -- Journey/Gantt's own "solid on
// a coloured task-bar fill" FR-023 exception token. Hardcoded here, not imported, the same way
// verify-1039-amber-retune.mjs's own `MERMAID_NODE_TEXT` is (no cross-file TS import from a
// plain .mjs script). Gate round 3 fix (Main, #1074 follow-up, item 1): the real check below is
// case-insensitive, since Mermaid embeds this file's own CSS string verbatim into the rendered
// SVG's `<style>` block, preserving whatever case each theme's own literal happens to use.
const JOURNEY_TASK_TEXT_COLOUR = {
  dark: '#fafafa',
  'dark-high-contrast': '#ffffff',
  obsidian: '#F8FAFC',
  'nordic-frost': '#eff7fb',
  'cyber-amber': '#fafafa'
};

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = [
    // Gate round 1 (Low item 7): honest, genuine skips -- none of these can be exercised by
    // this live check as written, not fixed glossed-over gaps.
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
    [...THEMES.flatMap((t) => [`${t.id}-00-chat.png`, `${t.id}-01-manage-sessions.png`, `${t.id}-02-settings-appearance.png`, `${t.id}-03-popover-menu.png`, `${t.id}-04-selected-text.png`, `${t.id}-05-settings-appearance.png`, `${t.id}-06-switch-off.png`, `${t.id}-07-composer-selection.png`]), 'report.json', 'app.log', 'fake-omp-invocations.log']
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

        // ---- Every real rendered colour matches its token's own resolved value. ----
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

        // ---- A badge label (ManageSessionsScreen's secondary-variant Badge): proves the
        // card/popover/secondary/accent/sidebar `var(--foreground)` alias cascade actually
        // resolves live, in a second independent component, not only in CSS source. ----
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

        // ---- FR-023's own alpha tiers: 0.9/0.78/0.6/0.9 (header/chat/muted/badge) in the four
        // non-HC themes, fully solid (alpha 1) in Dark (high contrast); the Send button's own
        // label stays solid in EVERY theme (a coloured, non-neutral fill). ----
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

        // ---- Real painted pixel luminance of the chat-prose paragraph: proves the opacity
        // genuinely composites on screen, not only in computed style. Gate-fix (caught live
        // 2026-10-20): the echoed user message (DOM-first `.text-chat-foreground`) sits ABOVE
        // the scrolled-to-bottom transcript view (the fixture's own Mermaid diagram pushes it
        // off-screen), so its raw `getBoundingClientRect()` has a NEGATIVE `y`;
        // `samplePixelRegion`'s `Math.max(0, ...)` clamp then silently sampled whatever real
        // chrome sat at the TOP of the viewport instead (sidebar/header text) -- a false
        // failure for Dark specifically (first theme iterated) and a false PASS for every other
        // theme only because that unrelated chrome text also happened to read bright.
        // `scrollTranscriptToShow` (real trusted wheel events -- see its own header comment for
        // why a plain `scrollTop`/`scrollIntoView` write does not stick here) scrolls the
        // transcript up for real, then a fresh `getBoundingClientRect()` confirms it -- and the
        // check below now fails loudly (not silently mis-samples) if it is ever not fully
        // inside the viewport afterwards.
        const scrolled = await scrollTranscriptToShow(cdp, CHAT_PROSE_FINDER);
        if (!scrolled) {
          failures.push(`${theme.name}: chat-prose element has no scrollable ancestor to scroll it into view.`);
          continue;
        }
        // Gate-fix (Code/Test Medium): captures the screenshot FIRST, then measures the
        // chat-prose element's own `getBoundingClientRect()` -- not the reverse (the old order),
        // which left a window for the rect to go stale relative to what was actually painted.
        // Also guards `x` (not only `y`) against being scrolled/clipped out of the viewport, and
        // asserts `devicePixelRatio === 1`: `decodePixelRegion` below samples the captured PNG's
        // own device pixels at this rect's CSS-pixel coordinates verbatim, which only lines up
        // 1:1 when the page has no device scaling.
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
          // Gate-fix (Code/Test Medium): predicts over the REAL fill the chat prose actually
          // sits inside -- the user-message bubble's own translucent `bg-accent/50`
          // (`UserMessageRow.tsx`'s `MessageContent`), composited over `--background`, THEN
          // `--chat-foreground`'s own alpha composited a second time on top of THAT -- not flat
          // `--background` directly (the old, wrong baseline `userBubbleContrastRows` in
          // `theme-contrast-pairs.mjs` already predicts the same way for its own WCAG check).
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

        // ---- Journey diagram labels stay solid (gate round 3 fix, Main's follow-up, item 1):
        // the fixture's second mermaid fence (`997-notice-severity.jsonl`, extended this round)
        // renders a Journey diagram; its task/section labels render via Mermaid's own default
        // foreignObject path (confirmed by reading node_modules/mermaid's own journeyDiagram
        // source directly -- see mermaidTheme.ts's own comment on the fix), so the embedded
        // `<style>` block this file's getMermaidThemeCSS generates is what actually governs
        // them. Asserts the real rendered SVG's own decoded text contains this theme's solid
        // `taskTextColor` literal, proving the override genuinely reached the page, not only
        // the CSS source. ----
        const mermaidImgs = await cdp.evaluate(`Array.from(document.querySelectorAll('img[role="img"]')).map((el) => el.getAttribute('src'))`);
        if (!Array.isArray(mermaidImgs) || mermaidImgs.length < 2 || !mermaidImgs[1]) {
          failures.push(`${theme.name}: expected 2 real rendered Mermaid diagrams (flowchart then journey), found ${Array.isArray(mermaidImgs) ? mermaidImgs.length : 0}.`);
        } else {
          const journeySrc = mermaidImgs[1];
          if (!journeySrc.startsWith('data:image/svg+xml')) {
            failures.push(`${theme.name}: second Mermaid diagram (journey) has no real data: URI src (got ${JSON.stringify(journeySrc)}).`);
          } else {
            const journeySvgText = decodeURIComponent(journeySrc.slice(journeySrc.indexOf(',') + 1));
            const expectedTaskText = JOURNEY_TASK_TEXT_COLOUR[theme.id];
            if (!journeySvgText.toLowerCase().includes(expectedTaskText.toLowerCase())) {
              failures.push(`${theme.name}: real rendered Journey SVG is missing the solid taskTextColor literal ${expectedTaskText} -- labels may still be using the softened textColor.`);
            } else {
              findings.push(`${theme.name}: real rendered Journey SVG contains the solid taskTextColor literal ${expectedTaskText} -- task/section labels stay solid on their coloured fillType fill.`);
            }
          }
        }

        // ---- Screenshots: chat (header, chat prose and Send button all visible), a popover
        // menu, selected chat-prose text, Settings Appearance (Manage sessions already shot
        // above) and an Off switch (gate round 1, Low item 7). `settleForScreenshot` runs
        // before EVERY shot -- moves the pointer, blurs, presses Escape, and THROWS if a stray
        // tooltip/hover card is still open. ----
        await settleForScreenshot(cdp);
        const chatShot = `${theme.id}-00-chat.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
        shotNames.push(chatShot);

        // Popover menu (gate round 1, Low item 7): the Profile dropdown's own `--popover`
        // surface, real rendered menu items whose text is `--popover-foreground` (aliases
        // `--foreground`, so this screenshot doubles as visual evidence for the alias cascade).
        await cdp.click(`document.querySelector('[data-profile-name-button]')`);
        await cdp.waitFor(`!!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 10_000, label: `${theme.name}: Profile dropdown menu open` });
        await sleep(150);
        const popoverShot = `${theme.id}-03-popover-menu.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, popoverShot));
        shotNames.push(popoverShot);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await cdp.waitFor(`!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 5_000, label: `${theme.name}: Profile dropdown menu closed` });

        // Selected chat-prose text (gate round 1, Low item 7): a real double-click word
        // selection, not a synthetic `Range` -- demonstrates the softened `--chat-foreground`
        // stays legible under the browser's own (unstyled, no `::selection` override) highlight.
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

        // Composer-selection text (round 3, Main's follow-up): the composer's own command-pill
        // foreground (`--composer-selection-fg`, FR-023 DECIDED solid per the coloured-fill
        // rule) under a REAL native selection highlight -- the same evidence
        // `assertSelectionHighlightVisible` already captures for #1050, reused here per-theme so
        // every preset's own pill-under-selection composite gets its own screenshot, not just
        // Dark's (the #1050 script only ever runs against Dark).
        await settleForScreenshot(cdp);
        await clearAndType(cdp, pressKey, '/btw hi');
        await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: `${theme.name}: command pill appears` });
        await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, pill included
        await settleForScreenshot(cdp);
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

        // Off switch (gate round 1, Low item 7): the Appearance section's own watermark toggle,
        // clicked off then restored on (never leaves the toggle in a different state than it
        // started, so a later theme iteration or a rerun sees the same default every time).
        await cdp.click(`document.querySelector('#watermark-toggle')`);
        await cdp.waitFor(`document.querySelector('#watermark-toggle')?.getAttribute('aria-checked') === 'false'`, { timeoutMs: 5_000, label: `${theme.name}: watermark toggle switched off` });
        await settleForScreenshot(cdp);
        const switchOffShot = `${theme.id}-06-switch-off.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, switchOffShot));
        shotNames.push(switchOffShot);
        await cdp.click(`document.querySelector('#watermark-toggle')`);
        await cdp.waitFor(`document.querySelector('#watermark-toggle')?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 5_000, label: `${theme.name}: watermark toggle restored on` });

        await closeSettingsBackToChat(cdp);

        findings.push(`${theme.name}: screenshots captured (chat, popover menu, selected text, composer-selection pill, Manage sessions, Settings Appearance, Off switch).`);
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
