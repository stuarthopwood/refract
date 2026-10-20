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
// fixtures while prototyping) via `REFRACT_FAKE_OMP_SCENARIO=997-notice-severity`: one turn
// gives a real session, a real echoed user message (`.text-chat-foreground` Markdown), and a
// real Manage sessions/Settings Appearance route, the same flow `verify-1039-amber-retune.mjs`
// already exercises -- no chat content from that fixture is otherwise used here.
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
//
// Screenshots per theme: chat (chat prose plus the header and Send button all visible), Manage
// sessions (the full Session list), and Settings Appearance. Every shot is preceded by
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
import { requireResolvedCssVarColor } from './verify-551-helpers.mjs';
import { parseComputedColorToEntry, compositeOverLinear, resolvedLinear, relativeLuminance, srgbGammaEncode } from './contrast-math.mjs';
import { settleForScreenshot, waitTwoFrames } from './verify-700-todo-pin-helpers.mjs';

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
const PIXEL_TOLERANCE = 20; // per sRGB byte channel, 0-255 -- font antialiasing/hinting slack.

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;
const HEADER_FINDER = `document.querySelector('header .truncate.text-sm.font-medium')`;
const CHAT_PROSE_FINDER = `document.querySelector('.text-chat-foreground')`;
const BADGE_FINDER = `document.querySelector('[data-slot="badge"][data-variant="secondary"]')`;

/** Reads every REAL, currently-rendered element this check needs in one round trip (never a
 * hidden probe alone -- see this file's own header comment for which component each belongs
 * to). */
async function readRealColours(cdp) {
  return cdp.evaluate(`(() => {
    const header = ${HEADER_FINDER};
    const footer = document.querySelector('footer');
    const chatProse = ${CHAT_PROSE_FINDER};
    const send = ${SEND_BUTTON_FINDER};
    return {
      header: header ? getComputedStyle(header).color : null,
      muted: footer ? getComputedStyle(footer).color : null,
      chat: chatProse ? getComputedStyle(chatProse).color : null,
      sendBackground: send ? getComputedStyle(send).backgroundColor : null,
      sendForeground: send ? getComputedStyle(send).color : null
    };
  })()`);
}

/** Session count badge on the Manage sessions screen (`ManageSessionsScreen.tsx`,
 * `data-slot="badge" data-variant="secondary"`) -- only mounted while that screen is open, so
 * read separately from `readRealColours` above (the chat-view elements). */
async function readBadgeColour(cdp) {
  return cdp.evaluate(`(() => { const b = ${BADGE_FINDER}; return b ? getComputedStyle(b).color : null; })()`);
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

/** Decodes a real `Page.captureScreenshot` entirely inside the page via an offscreen `<canvas>`
 * (`drawImage` + `getImageData`), so no Node-side PNG decoder dependency is needed -- the same
 * technique `verify-1050-command-pill-helpers.mjs`'s own (module-private) `capturePixelRegion`
 * uses. Returns a flat RGBA byte array for the given CSS-pixel rect. */
async function samplePixelRegion(cdp, rect) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(${x}, ${y}, ${w}, ${h}).data;
      resolve(Array.from(d));
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,${data}';
  })`);
}

/** The single brightest (most fully-inked, least anti-aliased) pixel in a sampled RGBA region --
 * every theme here is dark-toned, so the chat text is always lighter than its own background,
 * making "brightest" a reliable proxy for "a glyph's own solid interior", not a blended edge. */
function brightestPixel(rgba) {
  let best = null;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const sum = r + g + b;
    if (!best || sum > best.sum) best = { r, g, b, sum };
  }
  return best;
}

async function main() {
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = []; // Genuine skips only.
  const shotNames = [];

  const gitHeadSha = gitHead(REPO_ROOT);
  const gitStatusResult = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
  const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
  const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${gitHeadSha}${dirty === true ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

  clearKnownOutputFiles(
    SHOTS_DIR,
    'refract-1074-text-opacity-shots',
    [...THEMES.flatMap((t) => [`${t.id}-00-chat.png`, `${t.id}-01-manage-sessions.png`, `${t.id}-02-settings-appearance.png`]), 'report.json', 'app.log', 'fake-omp-invocations.log']
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
        // `samplePixelRegion`'s `Math.max(0, ...)` clamp then silently samples whatever real
        // chrome sits at the TOP of the viewport instead (sidebar/header text) -- a false
        // failure for Dark specifically (first theme iterated, so nothing has yet scrolled the
        // element further into negative territory the way later iterations' extra round-trips
        // do) and a false PASS for every other theme only because that unrelated chrome text
        // happens to also read bright. `scrollIntoView` + a real two-frame settle, then a fresh
        // `getBoundingClientRect()`, so the rect genuinely points at the chat-prose element --
        // and the check below now fails loudly (not silently mis-samples) if it ever isn't
        // fully inside the viewport after that.
        await cdp.evaluate(`(() => { const el = ${CHAT_PROSE_FINDER}; if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' }); })()`);
        await waitTwoFrames(cdp);
        const chatRect = await cdp.evaluate(`(() => { const el = ${CHAT_PROSE_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, viewportHeight: window.innerHeight }; })()`);
        if (!chatRect || chatRect.width < 1 || chatRect.height < 1 || chatRect.y < 0 || chatRect.y + chatRect.height > chatRect.viewportHeight) {
          failures.push(`${theme.name}: chat-prose element has no real, fully-in-viewport paintable rect to sample after scrollIntoView (${JSON.stringify(chatRect)}).`);
        } else {
          const bgRaw = await requireResolvedCssVarColor(cdp, '--background', 'background-color');
          const fgEntry = parseComputedColorToEntry(real.chat);
          const bgEntry = parseComputedColorToEntry(bgRaw);
          if (!fgEntry || !bgEntry) {
            failures.push(`${theme.name}: could not parse --chat-foreground (${real.chat}) or --background (${bgRaw}) for the real pixel-compositing check.`);
          } else {
            const expectedLinear = resolvedLinear(fgEntry, bgEntry);
            const expectedRgb = expectedLinear.map((c) => Math.round(srgbGammaEncode(c) * 255));
            const pixels = await samplePixelRegion(cdp, chatRect);
            const ink = brightestPixel(pixels);
            if (!ink) {
              failures.push(`${theme.name}: no pixels sampled from the chat-prose rect (${JSON.stringify(chatRect)}).`);
            } else {
              const diffs = [Math.abs(ink.r - expectedRgb[0]), Math.abs(ink.g - expectedRgb[1]), Math.abs(ink.b - expectedRgb[2])];
              const maxDiff = Math.max(...diffs);
              if (maxDiff > PIXEL_TOLERANCE) {
                failures.push(`${theme.name}: brightest real painted chat-prose pixel is rgb(${ink.r},${ink.g},${ink.b}), expected close to the gamma-composited --chat-foreground-over---background prediction rgb(${expectedRgb.join(',')}) (max channel diff ${maxDiff}, tolerance ${PIXEL_TOLERANCE}).`);
              } else {
                findings.push(`${theme.name}: real painted chat-prose ink rgb(${ink.r},${ink.g},${ink.b}) is within ${maxDiff} of the predicted composited rgb(${expectedRgb.join(',')}) -- the opacity genuinely composites on screen.`);
              }
            }
          }
        }

        // ---- Screenshots: chat (header, chat prose and Send button all visible) and Settings
        // Appearance (Manage sessions already shot above). `settleForScreenshot` runs before
        // EVERY shot -- moves the pointer, blurs, presses Escape, and THROWS if a stray
        // tooltip/hover card is still open. ----
        await settleForScreenshot(cdp);
        const chatShot = `${theme.id}-00-chat.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
        shotNames.push(chatShot);

        await settleForScreenshot(cdp);
        await openSettingsAppearance(cdp);
        await sleep(200);
        await settleForScreenshot(cdp);
        const settingsShot = `${theme.id}-02-settings-appearance.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, settingsShot));
        shotNames.push(settingsShot);
        await closeSettingsBackToChat(cdp);

        findings.push(`${theme.name}: screenshots captured (chat, Manage sessions, Settings Appearance).`);
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
