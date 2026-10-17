#!/usr/bin/env node
// Live CDP check for issue #927 (quiet composer: transparent fill, faint border, muted focus
// outline, ghost pickers in Dark and Obsidian; Dark high contrast keeps its 3:1 edges and full
// ring) and issue #928 (composer status line 13px text, 14px icons), shipped together per
// `docs/PLAN.md`'s own "v0.3.0 feedback" row ("Suggested order: #927 and #928 together, both
// composer chrome").
//
// Drives a REAL `omp` (resolved from PATH, ambient already-signed-in default profile, no
// `OMP_PROFILE` override), the same isolation posture `verify-570-tool-colours.mjs`/
// `verify-565-spine.mjs` already use: scratch cwd/worktree/`REFRACT_DATA_DIR` never touch
// Stuart's real Session list. No prompt is ever sent to the agent -- every assertion below is a
// static `getComputedStyle()`/DOM read, needing only an OPEN, enabled Session (composer
// `disabled` clears once the real agent attaches), never a turn, so this spends no model tokens.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-927-928-quiet-composer.mjs (requires a prior
// `pnpm tauri build --debug --no-bundle`, same convention every `verify-5xx-*.mjs`/`verify-9xx-*
// .mjs` script in this repo already documents).
//
// Per theme (Dark, Obsidian, Dark high contrast), this measures:
//   (a) the composer box's own resting `background-color`/`border-color` (transparent fill +
//       faint border in Dark/Obsidian; the old opaque fill + opaque border, unchanged, in Dark
//       high contrast);
//   (b) the SAME box's focus-visible `border-color`/`box-shadow` once the textarea is focused
//       (text fields always qualify for `:focus-visible` regardless of input modality, so a
//       script `.focus()` call is a genuine test here) -- muted border, no glow, in Dark/
//       Obsidian; the old opaque border + `ring-ring/50` glow, unchanged, in Dark high contrast;
//   (c) the Approval pill (`badgeVariants`-based) and Attach button (`Button`-based, the other
//       `GHOST_BUTTON_FOCUS_CLASS` code path) at rest -- no border, no fill -- and their
//       `outline-color` once reached by a REAL keyboard Tab (never a script `.focus()` call,
//       since a `<button>`'s own `:focus-visible` genuinely depends on keyboard-vs-pointer input
//       modality, unlike a text field);
//   (d) Send's own outline-color after the same real-Tab chain, contrasted against the ghost
//       controls' muted one, to prove the #927 split (Send/Stop stayed on the old, opaque
//       `--ring` token) actually took effect;
//   (e) issue #928: every `.text-readout` status-line chip's computed `font-size` (13px) and its
//       icon's computed width/height (14px).
//
// The exe under test is tied to the commit two ways (the established convention this repo's
// `verify-5xx-*.mjs` scripts all follow): rebuild immediately before this script runs (never a
// reused, possibly sibling-lane-clobbered exe), and assert #927/#928-only strings
// (`composer-border`, `text-readout`) are present in the built renderer bundle before trusting
// anything else.

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
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';
import { clamp01, srgbGammaDecode, resolvedLinear, relativeLuminance, contrastRatio } from './contrast-math.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
// Overridable; defaults to a fresh, timestamped folder under the OS temp dir (never a hard-coded
// user path -- the known gate finding every other `verify-5xx-*.mjs` script already fixed) so a
// rerun never mixes its own screenshots with a stale prior run's.
const SHOTS_DIR =
  process.env.REFRACT_927_928_SHOTS_DIR || path.join(tmpdir(), 'refract-927-928-quiet-composer-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

const COMPOSER_BOX_FINDER = `document.querySelector('[aria-label="Message"]')?.closest('.rounded-lg')`;
const APPROVAL_PILL_FINDER =
  `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode'))`;
const ATTACH_BUTTON_FINDER = `document.querySelector('button[aria-label^="Attach images"]')`;
const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;

// Issue #927, Dark (high contrast): the composer border and focus outline must measure a REAL
// >=3:1 ratio against their actual rendered backdrop -- not merely "looks opaque". Parses a
// `getComputedStyle()` colour string into the same `{ alpha, linear }` shape `contrast-math.mjs`
// already works with (reused byte-for-byte from `check-theme-contrast.mjs`'s own static token
// math, just fed live DOM reads instead of hardcoded CSS variable values), then alpha-composites
// and computes the ratio exactly as that script does.
//
// This app's `@theme` tokens and `color-mix(in oklab, ...)` expressions make WebView2/Chromium
// report computed colours in `oklch()`/`oklab()` syntax, not `rgb()` -- confirmed live (this
// script's own first real run reported `oklch(1 0 0 / 0.38)` and `oklab(0.9 0 0 / 0.5)` for
// composer border/focus colours, which the original `rgb()`-only parser below could not read at
// all). Both are parsed via the standard OKLab-to-linear-sRGB matrices (Bjorn Ottosson's method,
// the same one every modern browser uses internally), which already yield LINEAR values --
// `rgb()`/`rgba()` bytes still need `srgbGammaDecode`, oklch/oklab do not.
function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ].map(clamp01);
}

function parseComputedColorToEntry(raw) {
  const str = (raw ?? '').trim();
  if (str === 'transparent') return { raw, alpha: 0, linear: [0, 0, 0] };
  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
  if (rgbMatch) {
    const [, r, g, b, a] = rgbMatch;
    return {
      raw,
      alpha: a === undefined ? 1 : clamp01(a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)),
      linear: [r, g, b].map((c) => srgbGammaDecode(clamp01(parseFloat(c) / 255)))
    };
  }
  const oklchMatch = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(str);
  if (oklchMatch) {
    const [, lRaw, cRaw, hRaw, aRaw] = oklchMatch;
    const L = lRaw.endsWith('%') ? parseFloat(lRaw) / 100 : parseFloat(lRaw);
    const C = parseFloat(cRaw);
    const hRad = (parseFloat(hRaw) * Math.PI) / 180;
    return {
      raw,
      alpha: aRaw === undefined ? 1 : clamp01(aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw)),
      linear: oklabToLinearSrgb(L, C * Math.cos(hRad), C * Math.sin(hRad))
    };
  }
  const oklabMatch = /^oklab\(\s*([\d.]+%?)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(str);
  if (oklabMatch) {
    const [, lRaw, aValRaw, bValRaw, aRaw] = oklabMatch;
    const L = lRaw.endsWith('%') ? parseFloat(lRaw) / 100 : parseFloat(lRaw);
    return {
      raw,
      alpha: aRaw === undefined ? 1 : clamp01(aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw)),
      linear: oklabToLinearSrgb(L, parseFloat(aValRaw), parseFloat(bValRaw))
    };
  }
  return null;
}

function measuredContrastRatio(fgRaw, bgRaw) {
  const fgEntry = parseComputedColorToEntry(fgRaw);
  const bgEntry = parseComputedColorToEntry(bgRaw);
  if (!fgEntry || !bgEntry) return null;
  const fgLinear = resolvedLinear(fgEntry, bgEntry);
  const bgLinear = resolvedLinear(bgEntry, bgEntry);
  return contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bgLinear));
}

// Issue #927 decision 4a: Dark/Obsidian's composer focus must show NO glow (a quiet border-
// colour change is the whole cue); Dark high contrast must keep its full, visible ring. Tailwind
// v4's `ring-*` utilities always compose `box-shadow` from five comma-separated layers
// (`--tw-inset-shadow,--tw-inset-ring-shadow,--tw-ring-offset-shadow,--tw-ring-shadow,--tw-shadow`)
// even when every one of them is a transparent/zero-geometry no-op -- `getComputedStyle()` never
// collapses that back to the literal string `'none'`, confirmed live (this script's own first
// real run reported a 5-layer string in EVERY theme, Dark high contrast included, which a naive
// `boxShadow !== 'none'` check would misread as "a glow is always present everywhere"). The only
// way to tell a genuine glow from Tailwind's own always-present zero-geometry layers is to
// measure each layer's real blur/spread radius and its colour's alpha: a layer paints visible
// pixels beyond the element's own border box only when (blur>0 or spread>0) AND alpha>0.
function hasVisibleShadow(boxShadowRaw) {
  const str = (boxShadowRaw ?? '').trim();
  if (!str || str === 'none') return false;
  for (const layer of str.split(/,(?![^(]*\))/)) {
    const trimmed = layer.trim().replace(/\s+inset$/, '').replace(/^inset\s+/, '');
    const geomMatch = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s*$/.exec(trimmed);
    if (!geomMatch) continue;
    const [, , , blurStr, spreadStr] = geomMatch;
    const blur = parseFloat(blurStr);
    const spread = parseFloat(spreadStr);
    if (blur <= 0 && spread <= 0) continue;
    const colorRaw = trimmed.slice(0, geomMatch.index).trim();
    const entry = parseComputedColorToEntry(colorRaw);
    if (entry && entry.alpha > 0) return true;
  }
  return false;
}

/** (a)/(b) above: the composer box's own resting and focus-visible computed styles. Focuses the
 * textarea directly via `.focus()` -- a genuine `:focus-visible` test, since text fields always
 * qualify for it regardless of input modality (unlike a `<button>`, see the ghost-control check
 * below). */
async function readComposerBoxStyles(cdp) {
  const resting = await cdp.evaluate(`(() => {
    const box = ${COMPOSER_BOX_FINDER};
    if (!box) return null;
    const cs = getComputedStyle(box);
    return {
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      borderWidth: cs.borderTopWidth,
      htmlClassName: document.documentElement.className,
      composerBackgroundVarOnHtml: getComputedStyle(document.documentElement).getPropertyValue('--composer-background').trim(),
      composerBackgroundVarOnBox: cs.getPropertyValue('--composer-background').trim(),
      colorComposerBackgroundVarOnBox: cs.getPropertyValue('--color-composer-background').trim()
    };
  })()`);
  await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.focus()`);
  await sleep(100);
  const focused = await cdp.evaluate(`(() => {
    const box = ${COMPOSER_BOX_FINDER};
    const field = document.querySelector('[aria-label="Message"]');
    if (!box || !field) return null;
    return {
      matchesFocusVisible: field.matches(':focus-visible'),
      borderColor: getComputedStyle(box).borderColor,
      boxShadow: getComputedStyle(box).boxShadow
    };
  })()`);
  await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.blur()`);
  return { resting, focused };
}

/** (c) above: the Approval pill and Attach button's resting (no border, no fill) computed
 * styles. Both should read `rgba(0, 0, 0, 0)`/`none`-equivalent for border/background at rest in
 * EVERY theme (the ghost variant has no border or fill in any theme; it is the FOCUS outline,
 * not the resting chrome, that differs by theme -- see decision 4a). */
async function readGhostControlRestingStyles(cdp) {
  return cdp.evaluate(`(() => {
    const read = (el) => el ? { backgroundColor: getComputedStyle(el).backgroundColor, borderColor: getComputedStyle(el).borderColor, borderWidth: getComputedStyle(el).borderTopWidth } : null;
    return {
      approvalPill: read(${APPROVAL_PILL_FINDER}),
      attachButton: read(${ATTACH_BUTTON_FINDER})
    };
  })()`);
}

/** (c)/(d) above: a REAL keyboard Tab chain -- Approval pill (script-focused, the known starting
 * point; its OWN focus-visible state is never asserted) -> Model -> Reasoning -> Attach -> Send,
 * reading each destination's `:focus-visible` match and computed `outline-color` as it is
 * reached by the real `Input.dispatchKeyEvent` Tab, never a script `.focus()` call -- a
 * `<button>`'s `:focus-visible` genuinely depends on keyboard-vs-pointer input modality, so this
 * is the one path that actually proves the muted/opaque outline split. */
async function readFocusOutlineChain(cdp) {
  await cdp.evaluate(`(${APPROVAL_PILL_FINDER})?.focus()`);
  await sleep(50);
  const steps = [];
  const labels = ['Model', 'Reasoning', 'Attach', 'Send'];
  for (const label of labels) {
    await pressTab(cdp);
    await sleep(50);
    let read = await cdp.evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        ariaLabel: el.getAttribute('aria-label'),
        matchesFocusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        outlineWidth: cs.outlineWidth
      };
    })()`);
    // Issue #927 split-proof step (Send): App.tsx's own split-pane `ResizableHandle` ("Resize
    // right pane") sits in real DOM/tab order between the composer's Attach button and Send
    // (a layout fact, not something either issue touches) -- confirmed live (this script's own
    // first real run landed here instead of Send every time). Presses a few more real Tabs,
    // bounded, to genuinely reach Send rather than reporting a permanent "not exercised" skip.
    if (label === 'Send') {
      let extra = 0;
      while (read?.ariaLabel !== 'Send message' && extra < 4) {
        await pressTab(cdp);
        await sleep(50);
        read = await cdp.evaluate(`(() => {
          const el = document.activeElement;
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            ariaLabel: el.getAttribute('aria-label'),
            matchesFocusVisible: el.matches(':focus-visible'),
            outlineStyle: cs.outlineStyle,
            outlineColor: cs.outlineColor,
            outlineWidth: cs.outlineWidth
          };
        })()`);
        extra += 1;
      }
    }
    steps.push({ expectedLabel: label, ...read });
  }
  return steps;
}

/** (e) above: every `.text-readout` status-line chip's computed font-size, plus its icon's
 * computed width/height -- `.text-readout` is the literal Tailwind class issue #928 adds
 * (globals.css's own `@theme { --text-readout: 13px }`), so this never needs to know which
 * specific chip kind happens to be visible (`sessionReadout`'s defaults, `DEFAULT_SESSION_
 * READOUT`, turn several on at once; `ChangesChip`/`ContextUsageChip` both render through
 * `ReadoutChip` even in their own "Not available"/null fallback text). */
async function readStatusLineChipSizes(cdp) {
  return cdp.evaluate(`(() => {
    const chips = Array.from(document.querySelectorAll('.text-readout'));
    return chips.map((chip) => {
      const icon = chip.querySelector('svg');
      return {
        text: chip.textContent.trim().slice(0, 40),
        fontSize: getComputedStyle(chip).fontSize,
        iconWidth: icon ? getComputedStyle(icon).width : null,
        iconHeight: icon ? getComputedStyle(icon).height : null
      };
    });
  })()`);
}

// Ties the exe under test to the actual commit, not merely to a comment's own assertion --
// `composer-border` (globals.css's new #927 token, consumed via Tailwind's `border-composer-
// border` utility, itself literally present in MessageInput.tsx's `className` string) and
// `text-readout` (globals.css's new #928 font-size utility, literally present in
// `ReadoutChip.tsx`'s `className` string) exist only from this story's own commits onward --
// grepping the just-built renderer bundle for both is a real, cheap proof that THIS build really
// contains #927/#928's code, independent of git log reasoning about timing.
function assertBundleContainsStory927928Markers() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsStory927928Markers: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  const found = { 'composer-border': false, 'text-readout': false };
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('composer-border')) found['composer-border'] = true;
    if (text.includes('text-readout')) found['text-readout'] = true;
  }
  for (const marker of Object.keys(found)) {
    if (!found[marker]) throw new Error(`assertBundleContainsStory927928Markers: '${marker}' not found in any built renderer asset -- this build does not contain its story's code.`);
  }
  console.log("verify-927-928: confirmed #927/#928-only markers 'composer-border' and 'text-readout' present in the built renderer bundle.");
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
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-927-928-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-927-928-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-927-928-repo-')), 'verify-927-928-quiet-composer');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-927-928-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-927-928-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`verify-927-928: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-927-928: data dir ${dataDir}`);
    console.log(`verify-927-928: shots dir ${SHOTS_DIR}`);
    console.log(`verify-927-928: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-927-928' });
    assertBundleContainsStory927928Markers();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-927-928: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-927-928');

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
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent -- every check below is a static computed-style read.');

    if (!(await cdp.evaluate(`!!(${COMPOSER_BOX_FINDER})`))) {
      throw new Error('verify-927-928: composer box not found via [aria-label="Message"]\'s own .closest(\'.rounded-lg\') -- cannot measure anything below.');
    }

    // Issue #928: `on_launch`'s own unconditional first `schedule_readout_update` call (Rust
    // `session/readout.rs`) runs `READOUT_COALESCE_MS` (100ms) after launch, computing a real
    // `diff_stat` (git status) even with zero changes -- `ChangesChip` renders once that
    // `readout:update` event lands, with no turn needed. Waits for the FIRST `.text-readout`
    // chip once, before the per-theme loop (not per-theme -- this is launch-time state, not
    // theme-dependent), so the per-theme reads below measure real chips rather than racing this
    // async round trip.
    let readoutChipsConfirmed = false;
    try {
      await cdp.waitFor(`document.querySelectorAll('.text-readout').length > 0`, { timeoutMs: 15_000, label: 'Status line chip (.text-readout) rendered' });
      readoutChipsConfirmed = true;
      findings.push('Status line chip(s) rendered after the launch-time readout update (no turn needed).');
    } catch (err) {
      notExercised.push(`Status line: no .text-readout chip rendered within 15s of session creation (${err.message}) -- issue #928's font-size/icon-size checks below will report no chips found for every theme.`);
    }

    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
      } catch (err) {
        failures.push(`Could not switch to the ${theme.name} theme via the real Profile-menu Theme submenu (${err.message}).`);
        continue;
      }
      await sleep(200);

      // ---- (a)/(b): composer box resting + focus-visible styles ----
      const boxStyles = await readComposerBoxStyles(cdp);
      if (!boxStyles?.resting || !boxStyles?.focused) {
        failures.push(`${theme.name}: composer box styles could not be read (target missing).`);
      } else {
        const isTransparent = (c) => {
          if (c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return true;
          const entry = parseComputedColorToEntry(c);
          return entry !== null && entry.alpha === 0;
        };
        if (theme.id === 'dark-high-contrast') {
          if (isTransparent(boxStyles.resting.backgroundColor)) failures.push(`${theme.name}: composer background is transparent (${boxStyles.resting.backgroundColor}) -- #927 explicitly excludes this theme, it must keep its old opaque fill. Diagnostic: <html> className "${boxStyles.resting.htmlClassName}", --composer-background on <html> "${boxStyles.resting.composerBackgroundVarOnHtml}", --composer-background on the box itself "${boxStyles.resting.composerBackgroundVarOnBox}", --color-composer-background on the box "${boxStyles.resting.colorComposerBackgroundVarOnBox}".`);
          else findings.push(`${theme.name}: composer background stayed opaque (${boxStyles.resting.backgroundColor}), unchanged by #927 as decided.`);
          if (!hasVisibleShadow(boxStyles.focused.boxShadow)) failures.push(`${theme.name}: composer focus box-shadow has no visible glow (${boxStyles.focused.boxShadow}) -- #927 keeps this theme's full ring (the old ring-ring/50 glow) unchanged.`);
          else findings.push(`${theme.name}: composer focus-visible box-shadow has a real, visible glow (${boxStyles.focused.boxShadow}), the unchanged full ring.`);
          // Measured (not merely visual) >=3:1 edge contrast, Dark high contrast only (#927
          // explicitly keeps this theme's 3:1 border and full ring): real `getComputedStyle()`
          // reads, alpha-composited with the same math `check-theme-contrast.mjs` already uses.
          const pageBackground = await cdp.evaluate(`getComputedStyle(document.body).backgroundColor`);
          const borderRatio = measuredContrastRatio(boxStyles.resting.borderColor, pageBackground);
          if (borderRatio === null) failures.push(`${theme.name}: could not parse composer border (${boxStyles.resting.borderColor}) or page background (${pageBackground}) for a measured contrast ratio.`);
          else if (borderRatio < 3) failures.push(`${theme.name}: composer border measures ${borderRatio.toFixed(2)}:1 against the page background (${boxStyles.resting.borderColor} on ${pageBackground}), below the 3:1 floor this theme must keep.`);
          else findings.push(`${theme.name}: composer border measures ${borderRatio.toFixed(2)}:1 against the page background (${boxStyles.resting.borderColor} on ${pageBackground}), >=3:1 as this theme requires.`);
          const focusRatio = measuredContrastRatio(boxStyles.focused.borderColor, boxStyles.resting.backgroundColor);
          if (focusRatio === null) failures.push(`${theme.name}: could not parse composer focus border (${boxStyles.focused.borderColor}) or composer background (${boxStyles.resting.backgroundColor}) for a measured contrast ratio.`);
          else if (focusRatio < 3) failures.push(`${theme.name}: composer focus border measures ${focusRatio.toFixed(2)}:1 against the composer's own background (${boxStyles.focused.borderColor} on ${boxStyles.resting.backgroundColor}), below the 3:1 floor this theme must keep.`);
          else findings.push(`${theme.name}: composer focus border measures ${focusRatio.toFixed(2)}:1 against the composer's own background (${boxStyles.focused.borderColor} on ${boxStyles.resting.backgroundColor}), >=3:1 as this theme requires.`);
        } else {
          if (!isTransparent(boxStyles.resting.backgroundColor)) failures.push(`${theme.name}: composer background is ${boxStyles.resting.backgroundColor}, expected transparent (#927 quiet composer).`);
          else findings.push(`${theme.name}: composer background is transparent, as #927 decides.`);
          if (hasVisibleShadow(boxStyles.focused.boxShadow)) failures.push(`${theme.name}: composer focus-visible box-shadow has a real, visible glow (${boxStyles.focused.boxShadow}), expected none -- #927 decides a quiet border-colour change only, no glow ring, for this theme.`);
          else findings.push(`${theme.name}: composer focus-visible box-shadow has no visible glow (${boxStyles.focused.boxShadow}), the quiet border-only focus cue #927 decides.`);
        }
        if (!boxStyles.focused.matchesFocusVisible) failures.push(`${theme.name}: the message field does not match :focus-visible once focused -- focus must still be visible (accessibility.md "Accepted departures": muted, never removed).`);
        else findings.push(`${theme.name}: message field genuinely matches :focus-visible once focused (border ${boxStyles.resting.borderColor} -> ${boxStyles.focused.borderColor}).`);
        if (boxStyles.resting.borderColor === boxStyles.focused.borderColor) failures.push(`${theme.name}: composer border colour is identical at rest and on focus (${boxStyles.resting.borderColor}) -- decision 4a requires a visible, if muted, change.`);
        else findings.push(`${theme.name}: composer border changes colour on focus (${boxStyles.resting.borderColor} -> ${boxStyles.focused.borderColor}).`);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-00-composer-rest.png`));

      // ---- (c): ghost controls at rest -- no border, no fill, in every theme ----
      const ghostResting = await readGhostControlRestingStyles(cdp);
      for (const [name, styles] of Object.entries(ghostResting ?? {})) {
        if (!styles) {
          failures.push(`${theme.name}: ${name} not found (target missing).`);
          continue;
        }
        const isTransparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
        if (!isTransparent(styles.backgroundColor)) failures.push(`${theme.name}: ${name} resting background is ${styles.backgroundColor}, expected transparent (ghost variant, decision 4a).`);
        else findings.push(`${theme.name}: ${name} resting background is transparent (ghost, decision 4a).`);
        if (!isTransparent(styles.borderColor) && styles.borderWidth !== '0px') failures.push(`${theme.name}: ${name} resting border is ${styles.borderColor} (${styles.borderWidth}), expected no visible border (ghost variant).`);
        else findings.push(`${theme.name}: ${name} has no visible resting border (ghost variant).`);
      }

      // ---- (c)/(d): real keyboard Tab chain -- the muted-vs-opaque outline split ----
      const chain = await readFocusOutlineChain(cdp);
      const ghostSteps = chain.filter((s) => s.expectedLabel !== 'Send');
      const sendStep = chain.find((s) => s.expectedLabel === 'Send');
      for (const step of ghostSteps) {
        if (!step || step.outlineStyle === 'none') {
          failures.push(`${theme.name}: real Tab did not produce a visible focus outline on the step expected to land on "${step?.expectedLabel}" (aria-label "${step?.ariaLabel}") -- focus must never be invisible (decision 4a).`);
        } else if (!step.matchesFocusVisible) {
          notExercised.push(`${theme.name}: step expected to land on "${step.expectedLabel}" did not report :focus-visible (aria-label "${step.ariaLabel}") -- possibly landed on an unexpected element; outline was still present (${step.outlineColor}).`);
        } else {
          findings.push(`${theme.name}: real keyboard Tab landed on "${step.ariaLabel}" with a visible :focus-visible outline (${step.outlineStyle}, ${step.outlineColor}, ${step.outlineWidth}).`);
        }
      }
      if (!sendStep || sendStep.outlineStyle === 'none') {
        notExercised.push(`${theme.name}: could not read Send's own real-Tab outline (sendStep=${JSON.stringify(sendStep)}).`);
      } else {
        findings.push(`${theme.name}: Send (unchanged by #927) shows its own real-Tab outline: ${sendStep.outlineStyle}, ${sendStep.outlineColor}, ${sendStep.outlineWidth}.`);
        const ghostOutlineColors = new Set(ghostSteps.filter((s) => s && s.outlineStyle !== 'none').map((s) => s.outlineColor));
        if (theme.id === 'dark-high-contrast') {
          if (ghostOutlineColors.size === 1 && [...ghostOutlineColors][0] === sendStep.outlineColor) findings.push(`${theme.name}: ghost controls' outline colour (${[...ghostOutlineColors][0]}) matches Send's (${sendStep.outlineColor}) -- expected here, since this theme's --composer-focus aliases --ring.`);
          else notExercised.push(`${theme.name}: expected the ghost controls' outline colour to match Send's in this theme (an exact --ring alias); observed ghost colours ${JSON.stringify([...ghostOutlineColors])} vs Send ${sendStep.outlineColor}.`);
        } else {
          if (ghostOutlineColors.size > 0 && ![...ghostOutlineColors].includes(sendStep.outlineColor)) findings.push(`${theme.name}: ghost controls' outline colour (${[...ghostOutlineColors]}) is DISTINCT from Send's unchanged full outline (${sendStep.outlineColor}) -- confirms the #927 muted/opaque split took effect.`);
          else failures.push(`${theme.name}: ghost controls' outline colour (${JSON.stringify([...ghostOutlineColors])}) is NOT distinct from Send's (${sendStep.outlineColor}) -- expected a muted colour here, different from Send's unchanged --ring.`);
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-01-attach-focus-ring.png`));
      await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

      // ---- (e), issue #928: status line chip text/icon sizes ----
      const chipSizes = await readStatusLineChipSizes(cdp);
      if (!chipSizes || chipSizes.length === 0) {
        if (readoutChipsConfirmed) failures.push(`${theme.name}: no .text-readout status-line chips found even though a chip rendered earlier in this same session -- a theme switch should never hide every chip.`);
        else notExercised.push(`${theme.name}: no .text-readout status-line chips found (no chip ever rendered in this session within the pre-loop wait -- see the standalone finding above).`);
      } else {
        for (const chip of chipSizes) {
          if (chip.fontSize !== '13px') failures.push(`${theme.name}: status line chip "${chip.text}" computed font-size is ${chip.fontSize}, expected 13px (issue #928).`);
          else findings.push(`${theme.name}: status line chip "${chip.text}" reads 13px text (issue #928).`);
          if (chip.iconWidth !== null) {
            if (chip.iconWidth !== '14px' || chip.iconHeight !== '14px') failures.push(`${theme.name}: status line chip "${chip.text}" icon computed size is ${chip.iconWidth} x ${chip.iconHeight}, expected 14px x 14px (issue #928).`);
            else findings.push(`${theme.name}: status line chip "${chip.text}" icon reads 14px (issue #928).`);
          }
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-02-status-line.png`));
    }

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
    console.log('\n=== verify-927-928: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-927-928: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-927-928: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-927-928: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-927-928: FAILED:', err?.stack ?? err);
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
  console.error('verify-927-928: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
