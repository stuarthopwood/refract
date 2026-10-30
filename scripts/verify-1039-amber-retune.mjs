#!/usr/bin/env node
// Live CDP check for #1039: Cyber Amber is pure-neutral (chroma 0) on Default Dark's surfaces with an orange
// accent and a warning hue moved apart from it; each real rendered surface must equal its CSS token.
// Usage: node scripts/verify-1039-amber-retune.mjs (needs a prior `pnpm tauri build --debug --no-bundle`)

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
import { hueDistanceDegrees, describeHueLightness, requireResolvedCssVarColor, linearSrgbToOklab } from './verify-551-helpers.mjs';
import { parseComputedColorToEntry } from './contrast-math.mjs';
import { settleForScreenshot, waitTwoFrames } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1039';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1039_SHOTS_DIR || path.join(tmpdir(), 'refract-1039-amber-retune-shots');

// Dark first: its resolved values are captured for the cross-theme equality checks on Cyber Amber's turn.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

// Set below the measured hue distance (~30.7) as a conservative margin, like verify-551's floor.
const ACCENT_WARNING_HUE_FLOOR = 25;

// Surface tokens must be pure neutral, identical to Default Dark's ladder (spec 007 FR-022).
// `--muted`/`--accent`/`--secondary` alias `--surface-hover` (`--surface-3`), so one read covers them.
const CYBER_AMBER_SURFACE_VARS = [
  ['--background', 'background-color'],
  ['--sidebar', 'background-color'],
  ['--card', 'background-color'],
  ['--popover', 'background-color'],
  ['--surface-3', 'background-color'],
  ['--border', 'color']
];
// The other `*-foreground` tokens alias `--foreground` via `var()`, so reading `--foreground` covers them.
const CYBER_AMBER_TEXT_VARS = [
  ['--foreground', 'color'],
  ['--chat-foreground', 'color'],
  ['--muted-foreground', 'color']
];
const SURFACE_CHROMA_CEILING = 0.002;
// Achromatic alone cannot catch a lightness mismatch, so these must equal Dark's values exactly.
const DARK_EQUALITY_VARS = [
  ['--ring', 'color'],
  ['--sidebar-ring', 'color'],
  ['--input', 'color'],
  ['--scrollbar-thumb', 'color'],
  ['--scrollbar-thumb-hover', 'color'],
  ['--composer-focus', 'color']
];

// The colour regex below is informational only; the Mermaid check compares the full decoded SVG.
const MERMAID_COLOUR_REGEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const MERMAID_NODE_TEXT = '#fafafa'; // DARK_FAMILY.primaryTextColor (`--card-foreground`)
// `Markdown.tsx` uses a per-mount `id="mermaid-${reactId}"` that differs across remounts.
const normalizeMermaidId = (svgText) => svgText.replace(/mermaid-_r_[a-z0-9]+_/g, 'mermaid-ID');

// A client-side unknown-command refusal gives a toast without touching the fake-omp tape.
const UNKNOWN_COMMAND = '/zzznotarealcommand1039';
const TOAST_SEEN_ATTR = 'data-1039-seen';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

function noticeFinder(levelLabel) {
  return `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === ${JSON.stringify(levelLabel)}).map((el) => el.parentElement?.parentElement).filter(Boolean)`;
}

const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;

/** Reads every real, currently-rendered surface this check needs in one round trip. */
async function readRealColours(cdp) {
  return cdp.evaluate(`(() => {
    const body = document.body;
    const sidebarRoot = document.querySelector('.bg-sidebar.text-sidebar-foreground');
    const footer = document.querySelector('footer');
    const chatProse = document.querySelector('.text-chat-foreground');
    const warningRows = (${noticeFinder('Warning:')});
    const warningRow = warningRows[warningRows.length - 1];
    const warningSpan = warningRow ? warningRow.querySelector(':scope > span.min-w-0.flex-1') : null;
    const send = ${SEND_BUTTON_FINDER};
    return {
      bodyBackground: body ? getComputedStyle(body).backgroundColor : null,
      bodyForeground: body ? getComputedStyle(body).color : null,
      sidebarBackground: sidebarRoot ? getComputedStyle(sidebarRoot).backgroundColor : null,
      sidebarForeground: sidebarRoot ? getComputedStyle(sidebarRoot).color : null,
      cardBackground: footer ? getComputedStyle(footer).backgroundColor : null,
      mutedForeground: footer ? getComputedStyle(footer).color : null,
      chatForeground: chatProse ? getComputedStyle(chatProse).color : null,
      warningColour: warningSpan ? getComputedStyle(warningSpan).color : null,
      sendBackground: send ? getComputedStyle(send).backgroundColor : null,
      sendForeground: send ? getComputedStyle(send).color : null
    };
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
    'refract-1039-amber-retune-shots',
    [...THEMES.flatMap((t) => [`${t.id}-00-chat-with-warning.png`, `${t.id}-01-manage-sessions.png`, `${t.id}-02-settings-appearance.png`, `${t.id}-03-code-block.png`, `${t.id}-04-profile-dropdown.png`, `${t.id}-05-toast-warning.png`]), 'report.json', 'app.log', 'fake-omp-invocations.log']
  );

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1039-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1039-amber-retune');
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-shim-'));

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

    // Without this, a wrong fake-omp shim (stale PATH, early crash) could still "pass" on UI state alone.
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
    await cdp.waitFor(`(${noticeFinder('Warning:')}).length > 0`, { timeoutMs: 30_000, label: 'Warning notice rendered' });
    await sleep(300);

    const darkCaptured = {};
    let darkMermaidSvgText = null;

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
          ['document.body background', real.bodyBackground, await requireResolvedCssVarColor(cdp, '--background', 'background-color')],
          ['document.body foreground', real.bodyForeground, await requireResolvedCssVarColor(cdp, '--foreground', 'color')],
          ['SessionList root background (the sidebar)', real.sidebarBackground, await requireResolvedCssVarColor(cdp, '--sidebar', 'background-color')],
          ['SessionList root foreground', real.sidebarForeground, await requireResolvedCssVarColor(cdp, '--sidebar-foreground', 'color')],
          ['StatusBar footer background (a card)', real.cardBackground, await requireResolvedCssVarColor(cdp, '--card', 'background-color')],
          ['StatusBar footer foreground (muted text)', real.mutedForeground, await requireResolvedCssVarColor(cdp, '--muted-foreground', 'color')],
          ['user message prose (chat text)', real.chatForeground, await requireResolvedCssVarColor(cdp, '--chat-foreground', 'color')],
          ['warning NoticeRow', real.warningColour, await requireResolvedCssVarColor(cdp, '--severity-warning', 'color')],
          ['Send button fill', real.sendBackground, await requireResolvedCssVarColor(cdp, '--send', 'background-color')],
          ['Send button text', real.sendForeground, await requireResolvedCssVarColor(cdp, '--send-foreground', 'color')]
        ];
        for (const [label, actual, expected] of assertions) {
          if (actual === null) continue; // already reported in `missing` above
          if (actual !== expected) {
            failures.push(`${theme.name}: ${label} measures ${actual}, expected it to equal its own token (${expected}).`);
          } else {
            findings.push(`${theme.name}: ${label} (${actual}) matches its own token.`);
          }
        }

        const accentRaw = await requireResolvedCssVarColor(cdp, '--accent-text', 'color');
        const accentHL = describeHueLightness(accentRaw);
        const warningHL = real.warningColour ? describeHueLightness(real.warningColour) : null;
        if (!accentHL || !warningHL) {
          failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or the real warning colour (${real.warningColour}) for a real OKLab hue read.`);
        } else {
          const hueDist = hueDistanceDegrees(accentHL.hue, warningHL.hue);
          if (hueDist < ACCENT_WARNING_HUE_FLOOR) {
            failures.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and the real warning colour (hue ${warningHL.hue.toFixed(1)}) are only ${hueDist.toFixed(1)} degrees apart -- below the ${ACCENT_WARNING_HUE_FLOOR}-degree floor, so a warning could read as the accent.`);
          } else {
            findings.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and the real warning colour (hue ${warningHL.hue.toFixed(1)}) are ${hueDist.toFixed(1)} degrees apart (>=${ACCENT_WARNING_HUE_FLOOR}), a real distinct hue.`);
          }
        }
        findings.push(`${theme.name}: --accent-text resolved colour: ${accentRaw} (probe only -- this fixture's one turn renders no Markdown link).`);

        for (const [varName, property] of [...CYBER_AMBER_SURFACE_VARS, ...CYBER_AMBER_TEXT_VARS]) {
          const raw = await requireResolvedCssVarColor(cdp, varName, property);
          const entry = parseComputedColorToEntry(raw);
          if (!entry) {
            failures.push(`${theme.name}: could not parse ${varName} (${raw}) for a real OKLCH chroma read.`);
            continue;
          }
          const { a, b } = linearSrgbToOklab(entry.linear);
          const chroma = Math.hypot(a, b);
          if (chroma > SURFACE_CHROMA_CEILING) {
            failures.push(`${theme.name}: ${varName} (${raw}) measures chroma ${chroma.toFixed(4)}, above the ${SURFACE_CHROMA_CEILING} pure-neutral ceiling.`);
          } else {
            findings.push(`${theme.name}: ${varName} (${raw}) measures chroma ${chroma.toFixed(4)} (<=${SURFACE_CHROMA_CEILING}, pure neutral).`);
          }
        }

        if (theme.id === 'dark') {
          for (const [varName, property] of DARK_EQUALITY_VARS) {
            darkCaptured[varName] = await requireResolvedCssVarColor(cdp, varName, property);
          }
          findings.push(`Dark: captured ${DARK_EQUALITY_VARS.length} token(s) as the cross-theme equality baseline (${DARK_EQUALITY_VARS.map(([v]) => v).join(', ')}).`);
        } else {
          for (const [varName, property] of DARK_EQUALITY_VARS) {
            const raw = await requireResolvedCssVarColor(cdp, varName, property);
            const expected = darkCaptured[varName];
            if (raw !== expected) {
              failures.push(`${theme.name}: ${varName} measures ${raw}, expected it byte-identical to Dark's own ${expected}.`);
            } else {
              findings.push(`${theme.name}: ${varName} (${raw}) is byte-identical to Dark's own.`);
            }
          }
        }

        // Mermaid `<img>` must re-render (src changes via Obsidian) so a stale Dark image can't pass. The per-mount
        // React id differs across remounts, so `normalizeMermaidId` strips it before comparing the decoded SVG.
        const mermaidImgSrcExpr = `document.querySelector('img[role="img"]')?.getAttribute('src') ?? null`;
        if (theme.id === 'cyber-amber') {
          const preObsidianSrc = await cdp.evaluate(mermaidImgSrcExpr);
          await switchTheme(cdp, 'obsidian', 'Obsidian');
          await cdp.waitFor(`(${mermaidImgSrcExpr}) !== ${JSON.stringify(preObsidianSrc)}`, { timeoutMs: 15_000, label: 'Mermaid image src changed after switching Cyber Amber -> Obsidian' });
          findings.push('Mermaid image src genuinely changed after switching to Obsidian, proving a real re-render, not a stale cached image.');
          const obsidianSrc = await cdp.evaluate(mermaidImgSrcExpr);
          await switchTheme(cdp, 'cyber-amber', 'Cyber Amber');
          await cdp.waitFor(`(${mermaidImgSrcExpr}) !== ${JSON.stringify(obsidianSrc)}`, { timeoutMs: 15_000, label: 'Mermaid image src changed again after switching Obsidian -> Cyber Amber' });
          findings.push('Mermaid image src genuinely changed again after switching back to Cyber Amber, proving a second real re-render.');
        }
        await cdp.waitFor(`!!document.querySelector('img[role="img"]')`, { timeoutMs: 15_000, label: `${theme.name}: Mermaid diagram image rendered` });
        const mermaidSrc = await cdp.evaluate(mermaidImgSrcExpr);
        if (!mermaidSrc || !mermaidSrc.startsWith('data:image/svg+xml')) {
          failures.push(`${theme.name}: Mermaid diagram image has no real data: URI src (got ${JSON.stringify(mermaidSrc)}).`);
        } else {
          const svgText = decodeURIComponent(mermaidSrc.slice(mermaidSrc.indexOf(',') + 1));
          const hasText = svgText.includes(MERMAID_NODE_TEXT);
          if (!hasText) {
            failures.push(`${theme.name}: real rendered Mermaid SVG is missing Dark's own node text literal ${MERMAID_NODE_TEXT}.`);
          } else {
            findings.push(`${theme.name}: real rendered Mermaid SVG contains Dark's own node text literal (${MERMAID_NODE_TEXT}).`);
          }
          const colours = new Set((svgText.match(MERMAID_COLOUR_REGEX) ?? []).map((c) => c.toLowerCase()));
          findings.push(`${theme.name}: real rendered Mermaid SVG contains ${colours.size} distinct colour token(s) (informational, hex/rgb()/hsl()).`);
          if (theme.id === 'dark') {
            darkMermaidSvgText = normalizeMermaidId(svgText);
            findings.push(`Dark: captured the real rendered Mermaid SVG's own full decoded text (${svgText.length} chars, id-normalized) as the cross-theme equality baseline.`);
          } else if (!darkMermaidSvgText) {
            failures.push(`${theme.name}: no Dark Mermaid SVG baseline was captured to compare against (Dark's own turn must run first).`);
          } else if (normalizeMermaidId(svgText) !== darkMermaidSvgText) {
            failures.push(`${theme.name}: real rendered Mermaid SVG differs from Dark's own (id-normalized full-string compare) -- Cyber Amber's own Mermaid palette may have drifted off DARK_FAMILY.`);
          } else {
            findings.push(`${theme.name}: real rendered Mermaid SVG is byte-identical to Dark's own full decoded text (after normalizing the volatile per-mount React useId substring).`);
          }
        }

        // `settleForScreenshot` runs before every shot and throws on a stray tooltip; call it before the action
        // that produces the shot's state so it never dismisses it.
        await settleForScreenshot(cdp);
        const chatShot = `${theme.id}-00-chat-with-warning.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
        shotNames.push(chatShot);

        await settleForScreenshot(cdp);
        // Scoped to this toggle's name: `button[aria-expanded="true"]` is ambiguous and leaks `showSource` state.
        const mermaidToggleFinder = `Array.from(document.querySelectorAll('button')).find((el) => { const t = el.textContent.trim(); return t.startsWith('Show source for Mermaid') || t.startsWith('Hide source for Mermaid'); })`;
        await cdp.click(mermaidToggleFinder);
        await cdp.waitFor(`(() => { const el = ${mermaidToggleFinder}; return !!el && el.getAttribute('aria-expanded') === 'true'; })()`, { timeoutMs: 10_000, label: `${theme.name}: Mermaid source code block shown` });
        const codeBlockShot = `${theme.id}-03-code-block.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, codeBlockShot));
        shotNames.push(codeBlockShot);
        await cdp.click(mermaidToggleFinder);
        await cdp.waitFor(`(() => { const el = ${mermaidToggleFinder}; return !!el && el.getAttribute('aria-expanded') === 'false'; })()`, { timeoutMs: 10_000, label: `${theme.name}: Mermaid source code block hidden again` });

        await settleForScreenshot(cdp);
        await cdp.click(`document.querySelector('[data-profile-name-button]')`);
        await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
          timeoutMs: 10_000,
          label: 'Profile dropdown menu open (containing Manage sessions)'
        });
        // `data-state="open"` fires before the animation ends; wait it out, then two rAFs.
        await cdp.waitFor(`(() => { const m = Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions')); return !!m && m.getAnimations().length === 0; })()`, { timeoutMs: 5_000, label: 'Profile dropdown menu open animation settled' });
        await waitTwoFrames(cdp);
        const dropdownShot = `${theme.id}-04-profile-dropdown.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, dropdownShot));
        shotNames.push(dropdownShot);
        await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Manage sessions screen opened' });
        await sleep(200);
        await settleForScreenshot(cdp);
        const manageShot = `${theme.id}-01-manage-sessions.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, manageShot));
        shotNames.push(manageShot);
        await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
        await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Manage sessions closed, back in chat' });

        await settleForScreenshot(cdp);
        const toastSelector = `document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')`;
        const freshToastExpr = `Array.from(${toastSelector}).find((el) => !el.hasAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}))`;
        await cdp.evaluate(`Array.from(${toastSelector}).forEach((el) => el.setAttribute(${JSON.stringify(TOAST_SEEN_ATTR)}, 'true'))`);
        await cdp.typeIntoByLabel('Message', UNKNOWN_COMMAND);
        await cdp.clickByLabel('Send message');
        await cdp.waitFor(`!!(${freshToastExpr})`, { timeoutMs: 15_000, label: `${theme.name}: unknown-command refusal toast mounted` });
        await sleep(400);
        const toastShot = `${theme.id}-05-toast-warning.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, toastShot));
        shotNames.push(toastShot);
        await cdp.click(`(${freshToastExpr})?.querySelector('[data-close-button]')`);
        await cdp.waitFor(`!(${freshToastExpr})`, { timeoutMs: 5_000, label: `${theme.name}: refusal toast dismissed` });
        // A refusal leaves the draft (FR-019); `clearField`'s Ctrl+A/Backspace was unreliable here, so use the native value setter.
        await cdp.evaluate(`(() => { const el = document.querySelector('[aria-label="Message"]'); if (!el) return; Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value === ''`, { timeoutMs: 5_000, label: `${theme.name}: composer draft cleared` });

        await settleForScreenshot(cdp);
        await openSettingsAppearance(cdp);
        await sleep(200);
        await settleForScreenshot(cdp);
        const settingsShot = `${theme.id}-02-settings-appearance.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, settingsShot));
        shotNames.push(settingsShot);
        await closeSettingsBackToChat(cdp);

        findings.push(`${theme.name}: screenshots captured (chat+warning, code block, profile dropdown, Manage sessions, toast, Settings Appearance).`);
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
