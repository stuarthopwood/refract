#!/usr/bin/env node
// Live CDP check for issue #927 (quiet composer: transparent fill, faint border, muted focus
// outline, ghost pickers in Dark and Obsidian; Dark high contrast keeps its 3:1 edges and full
// ring) and issue #928 (composer status line 13px text, 14px icons), shipped together per
// `docs/PLAN.md`'s "v0.3.0 feedback" row.
//
// Drives a REAL `omp` (ambient signed-in profile, no `OMP_PROFILE` override), the same isolation
// posture `verify-570-tool-colours.mjs`/`verify-565-spine.mjs` use: scratch cwd/worktree/
// `REFRACT_DATA_DIR` never touch Stuart's real Session list. No prompt is ever sent -- every
// assertion is a static `getComputedStyle()`/DOM read, so this spends no model tokens.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-927-928-quiet-composer.mjs (requires a prior `pnpm tauri build --debug
// --no-bundle`, the same convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs` script documents).
//
// Per theme (Dark, Obsidian, Dark high contrast):
//   (a)/(b) the composer box's resting and focus-visible `background-color`/`border-color`/
//       `box-shadow` (transparent fill, faint border, no glow in Dark/Obsidian; unchanged opaque
//       fill/border/full ring in Dark high contrast);
//   (c)/(d) the Approval pill, Model/Reasoning pickers and Attach button's resting styles (no
//       fill anywhere; a visible resting border ONLY in Dark high contrast, item 6/U1) and their
//       settled (`document.getAnimations().forEach((a) => a.finish())`, item 4/M3) outline-color
//       once reached by a REAL keyboard Tab that must land on Send FIRST (item 3/T2, DOM order),
//       asserted against the resolved `--composer-focus`/`--ring` values;
//   (hover, item 5/T3) a real CDP `mouseMoved` over each ghost trigger: pointer cursor + a faint
//       fill delta when enabled, not-allowed + no fill change when `aria-disabled`;
//   (e) issue #928: every status-line chip's (`[data-slot="readout-chip"]`) computed font-size
//       (13px) and icon RENDERED `getBoundingClientRect` size (14px) -- a real failure, never
//       `notExercised`, if the status line mounted but no chip matched or any size differs.
//
// The exe under test is tied to the commit two ways: rebuilt immediately before this script runs
// (never a reused, possibly sibling-lane-clobbered exe), and #927/#928-only markers
// (`composer-border`, `text-readout`) asserted present in the built renderer bundle first.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';
import { assertGhostHoverStates } from './verify-927-928-hover.mjs';
import { parseComputedColorToEntry, measuredContrastRatio, hasVisibleShadow } from './contrast-math.mjs';

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

// Bug found live (this script's own first two real runs): `.closest('.rounded-lg')` starting
// FROM `[aria-label="Message"]` matches the `<textarea>` ELEMENT ITSELF first -- `Textarea`
// (`components/ui/textarea.tsx`) carries its own, unrelated `rounded-lg` AND `bg-transparent`
// in its base classes, so `.closest()` (which checks the starting element before any ancestor)
// stopped there instead of reaching MessageInput.tsx's own outer box
// (`rounded-lg border ... bg-composer-background`, one level up) -- every measurement below was
// reading the textarea's own hardcoded, theme-independent `bg-transparent`/`ring-ring/50`, not
// the #927 composer box at all. Targets the box's own, #927-unique `bg-composer-background`
// class instead of the ambiguous shared `rounded-lg`, so this can never match the textarea.
const COMPOSER_BOX_FINDER = `document.querySelector('[aria-label="Message"]')?.closest('.bg-composer-background')`;
const APPROVAL_PILL_FINDER =
  `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode'))`;
const ATTACH_BUTTON_FINDER = `document.querySelector('button[aria-label^="Attach images"]')`;
const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;
const MODEL_PICKER_FINDER =
  `Array.from(document.querySelectorAll('button')).find((el) => { const l = el.getAttribute('aria-label') || ''; return l.includes(', model') || /^model\b/i.test(l); })`;
const REASONING_PICKER_FINDER =
  `Array.from(document.querySelectorAll('button')).find((el) => { const l = el.getAttribute('aria-label') || ''; return l.includes(', reasoning') || /^reasoning\b/i.test(l); })`;
// Item 5 (T3, hover): the same four ghost triggers `readGhostControlRestingStyles` reads,
// keyed identically (`approvalPill`/`modelPicker`/`reasoningPicker`/`attachButton`) so a
// hover read can be compared directly against its own resting background without a second
// name-mapping table.
const GHOST_HOVER_TARGETS = [
  ['approvalPill', APPROVAL_PILL_FINDER],
  ['modelPicker', MODEL_PICKER_FINDER],
  ['reasoningPicker', REASONING_PICKER_FINDER],
  ['attachButton', ATTACH_BUTTON_FINDER]
];

/** (a)/(b) above: the composer box's own resting and focus-visible computed styles. Focuses the
 * textarea directly via `.focus()` -- a genuine `:focus-visible` test, since text fields always
 * qualify for it regardless of input modality (unlike a `<button>`, see the ghost-control check
 * below). */
async function readComposerBoxStyles(cdp) {
  const resting = await cdp.evaluate(`(() => {
    const box = ${COMPOSER_BOX_FINDER};
    if (!box) return null;
    const cs = getComputedStyle(box);
    return { backgroundColor: cs.backgroundColor, borderColor: cs.borderColor, borderWidth: cs.borderTopWidth };
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

/** (c) above: the Approval pill, Model/Reasoning pickers, and Attach button's resting computed
 * styles. Every one is `ghost` (no FILL at rest, in every theme -- decision 4a); the BORDER
 * itself differs by theme (item 6, U1 gate951UI/A11y High): Dark (high contrast) keeps a real,
 * enforced resting border (`--composer-control-border`, globals.css), the opposite of Dark/
 * Obsidian, which stay border-less ghosts -- the caller branches that assertion by theme. */
async function readGhostControlRestingStyles(cdp) {
  return cdp.evaluate(`(() => {
    const read = (el) => el ? { backgroundColor: getComputedStyle(el).backgroundColor, borderColor: getComputedStyle(el).borderColor, borderWidth: getComputedStyle(el).borderTopWidth } : null;
    return {
      approvalPill: read(${APPROVAL_PILL_FINDER}),
      modelPicker: read(${MODEL_PICKER_FINDER}),
      reasoningPicker: read(${REASONING_PICKER_FINDER}),
      attachButton: read(${ATTACH_BUTTON_FINDER})
    };
  })()`);
}

/** (c)/(d) above: a REAL keyboard Tab chain from a REAL click on the message field (verified
 * against `document.elementFromPoint`, never a scripted `.focus()` call -- confirmed live, a
 * scripted start produced unreliable Tab landings).
 *
 * Item 3 (T2): Send sits in DOM order BEFORE the bottom row (MessageInput.tsx: the Send/Stop
 * div is a sibling of the Textarea; Approval/Model/Reasoning/Attach is the next sibling after
 * that), so the FIRST real Tab must land on Send -- landing elsewhere is `wrongPosition`, a real
 * failure. Walks the bottom row afterward with a step cap, recording each of Approval/Model/
 * Reasoning/Attach the first time reached (never a fixed step count, since an intervening
 * tabbable element can sit between any two); not reached within the cap is a real failure.
 *
 * Item 4 (M3): `document.getAnimations().forEach((a) => a.finish())` runs before every outline
 * read -- an outline-colour CSS transition can still be mid-flight the instant a Tab lands. */
async function readFocusOutlineChain(cdp) {
  const fieldRect = await cdp.evaluate(`(() => {
    const field = document.querySelector('[aria-label="Message"]');
    const r = field.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fieldRect.x, y: fieldRect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fieldRect.x, y: fieldRect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fieldRect.x, y: fieldRect.y, button: 'left', clickCount: 1 });
  await sleep(50);
  const clickLanded = await cdp.evaluate(`(() => {
    const field = document.querySelector('[aria-label="Message"]');
    const hit = document.elementFromPoint(${fieldRect.x}, ${fieldRect.y});
    return field === hit && document.activeElement === field;
  })()`);
  if (!clickLanded) throw new Error('verify-927-928: a real click at the message textarea\'s own centre did not focus it (document.elementFromPoint/activeElement mismatch) -- cannot trust the Tab chain below.');

  const readActiveOutline = async () => {
    await cdp.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
    return cdp.evaluate(`(() => {
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
  };

  // Item 3 (T2): the very first Tab off the textarea must land on Send (DOM order), not the
  // bottom row.
  await pressTab(cdp);
  await sleep(50);
  const sendRead = await readActiveOutline();
  const steps = [];
  if (!sendRead) {
    steps.push({ expectedLabel: 'Send', ariaLabel: null, matchesFocusVisible: false, outlineStyle: 'none', outlineColor: null, outlineWidth: null, notReached: true });
  } else if (sendRead.ariaLabel !== 'Send message') {
    steps.push({ expectedLabel: 'Send', ...sendRead, wrongPosition: true });
  } else {
    steps.push({ expectedLabel: 'Send', ...sendRead });
  }

  const KIND_MATCHERS = [
    ['Approval', (label) => label.endsWith(', approval mode')],
    ['Model', (label) => label.includes(', model') || /^model\b/i.test(label)],
    ['Reasoning', (label) => label.includes(', reasoning') || /^reasoning\b/i.test(label)],
    ['Attach', (label) => label.startsWith('Attach images')]
  ];
  const STEP_CAP = 10;
  const found = new Set();
  for (let i = 0; i < STEP_CAP && found.size < KIND_MATCHERS.length; i++) {
    await pressTab(cdp);
    await sleep(50);
    const read = await readActiveOutline();
    if (!read) continue;
    const label = read.ariaLabel || '';
    const kind = KIND_MATCHERS.find(([name, test]) => !found.has(name) && test(label))?.[0];
    if (kind) {
      found.add(kind);
      steps.push({ expectedLabel: kind, ...read });
    }
  }
  for (const [name] of KIND_MATCHERS) {
    if (!found.has(name)) {
      steps.push({ expectedLabel: name, ariaLabel: null, matchesFocusVisible: false, outlineStyle: 'none', outlineColor: null, outlineWidth: null, notReached: true });
    }
  }
  return steps;
}

/** (e) above: every status-line chip's computed font-size, plus its icon's RENDERED size (item
 * 2: `getBoundingClientRect`, not `getComputedStyle` -- the actual on-screen box, not merely the
 * CSS declaration, in case a transform/intrinsic-SVG-size quirk ever diverges from it). H1
 * (gate951Test/Code): finds chips by the structural `data-slot="readout-chip"` attribute
 * (`ReadoutChip.tsx`), NEVER by `.text-readout` -- that literal class is itself the thing issue
 * #928 changes, so a regression there (confirmed live: `cn`'s tailwind-merge stripped it,
 * rendering every chip at the browser default ~16px) would otherwise go undetected by a
 * selector built from the very class under test. */
async function readStatusLineChipSizes(cdp) {
  return cdp.evaluate(`(() => {
    const chips = Array.from(document.querySelectorAll('[data-slot="readout-chip"]'));
    return chips.map((chip) => {
      const icon = chip.querySelector('svg');
      const iconRect = icon ? icon.getBoundingClientRect() : null;
      return {
        text: chip.textContent.trim().slice(0, 40),
        fontSize: getComputedStyle(chip).fontSize,
        iconRect: iconRect ? { width: Math.round(iconRect.width), height: Math.round(iconRect.height) } : null
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
  let anyDisabledTriggerSeen = false; // Item 5 (T3): true only if a real aria-disabled ghost trigger was ever hovered.
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


    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
      } catch (err) {
        failures.push(`Could not switch to the ${theme.name} theme via the real Profile-menu Theme submenu (${err.message}).`);
        continue;
      }
      await sleep(200);

      // Item 4 (M3, settled outline colours): the EXPECTED outline colours for this theme,
      // resolved through a REAL probe element reading the live `var(--composer-focus)`/
      // `var(--ring)` cascade -- never a hardcoded literal, since several presets resolve these
      // through `color-mix()`/`var()` chains only the browser itself can finish computing.
      const resolvedComposerFocus = await resolveCssVarColor(cdp, '--composer-focus');
      const resolvedRing = await resolveCssVarColor(cdp, '--ring');

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
          if (isTransparent(boxStyles.resting.backgroundColor)) failures.push(`${theme.name}: composer background is transparent (${boxStyles.resting.backgroundColor}) -- #927 explicitly excludes this theme, it must keep its old opaque fill.`);
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

      // ---- (c): ghost controls at rest -- fill is border-less in EVERY theme (ghost variant,
      // decision 4a); the BORDER itself differs by theme (item 6, U1 decision 3): Dark (high
      // contrast) keeps a real, enforced >=1px/alpha>0 resting border on these triggers, the
      // OPPOSITE of Dark/Obsidian, which stay border-less ghosts like the fill.
      const ghostResting = await readGhostControlRestingStyles(cdp);
      for (const [name, styles] of Object.entries(ghostResting ?? {})) {
        if (!styles) {
          failures.push(`${theme.name}: ${name} not found (target missing).`);
          continue;
        }
        const isTransparent = (c) => {
          if (c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return true;
          const entry = parseComputedColorToEntry(c);
          return entry !== null && entry.alpha === 0;
        };
        if (!isTransparent(styles.backgroundColor)) failures.push(`${theme.name}: ${name} resting background is ${styles.backgroundColor}, expected transparent (ghost variant, decision 4a).`);
        else findings.push(`${theme.name}: ${name} resting background is transparent (ghost, decision 4a).`);
        const borderWidthPx = parseFloat(styles.borderWidth);
        const borderEntry = parseComputedColorToEntry(styles.borderColor);
        const borderVisible = borderWidthPx >= 1 && !!borderEntry && borderEntry.alpha > 0;
        if (theme.id === 'dark-high-contrast') {
          if (!borderVisible) failures.push(`${theme.name}: ${name} resting border is ${styles.borderColor} (${styles.borderWidth}), expected a visible >=1px, alpha>0 border in this theme (item 6, U1 decision 3).`);
          else findings.push(`${theme.name}: ${name} keeps its visible resting border (${styles.borderColor}, ${styles.borderWidth}), as this theme requires (U1 decision 3).`);
        } else {
          if (borderVisible) failures.push(`${theme.name}: ${name} resting border is ${styles.borderColor} (${styles.borderWidth}), expected no visible border (ghost variant, decision 4a).`);
          else findings.push(`${theme.name}: ${name} has no visible resting border (ghost variant, decision 4a).`);
        }
      }

      // ---- (hover, item 5/T3): real CDP mouseMoved over each ghost trigger (helper split into
      // `verify-927-928-hover.mjs`, file-size #806 ratchet) -- pointer cursor + a faint fill
      // delta for an enabled trigger, not-allowed + no fill change for an aria-disabled one. ----
      if (await assertGhostHoverStates(cdp, theme.name, GHOST_HOVER_TARGETS, ghostResting, findings, failures)) {
        anyDisabledTriggerSeen = true;
      }

      // ---- (c)/(d): real keyboard Tab chain -- T2 (Send precedes the bottom row in DOM order)
      // plus the settled, resolved outline-colour split (item 4/M3) ----
      const chain = await readFocusOutlineChain(cdp);
      const sendStep = chain.find((s) => s.expectedLabel === 'Send');
      const ghostSteps = chain.filter((s) => s.expectedLabel !== 'Send');
      if (!sendStep || sendStep.notReached) {
        failures.push(`${theme.name}: the very first real Tab off the message field never reached Send at all -- Send must be reachable by keyboard.`);
      } else if (sendStep.wrongPosition) {
        failures.push(`${theme.name}: the very first real Tab off the message field landed on "${sendStep.ariaLabel}", not Send -- Send sits before the bottom row in DOM order (item 3, T2) and must be the first Tab stop.`);
      } else if (sendStep.outlineStyle === 'none') {
        failures.push(`${theme.name}: Send's own real-Tab outline is 'none' -- Send (unchanged by #927) must keep a visible focus outline.`);
      } else {
        findings.push(`${theme.name}: the first real Tab off the message field landed on Send (T2 DOM order), outline ${sendStep.outlineStyle}, ${sendStep.outlineColor}, ${sendStep.outlineWidth}.`);
      }

      const EXPECTED_GHOST_LABELS = ['Approval', 'Model', 'Reasoning', 'Attach'];
      for (const expected of EXPECTED_GHOST_LABELS) {
        const step = ghostSteps.find((s) => s.expectedLabel === expected);
        if (!step || step.notReached) {
          failures.push(`${theme.name}: the real Tab walk past Send never reached "${expected}" within its step cap -- every bottom-row control must be keyboard-reachable.`);
        }
      }
      for (const step of ghostSteps) {
        if (!step || step.notReached || step.outlineStyle === 'none') {
          if (step && !step.notReached) failures.push(`${theme.name}: real Tab did not produce a visible focus outline on the step expected to land on "${step.expectedLabel}" (aria-label "${step.ariaLabel}") -- focus must never be invisible (decision 4a).`);
          continue;
        }
        if (!step.matchesFocusVisible) {
          failures.push(`${theme.name}: step expected to land on "${step.expectedLabel}" did not report :focus-visible (aria-label "${step.ariaLabel}") -- possibly landed on an unexpected element; outline was still present (${step.outlineColor}).`);
        } else if (step.outlineColor !== resolvedComposerFocus) {
          failures.push(`${theme.name}: "${step.expectedLabel}" settled outline-color is ${step.outlineColor}, expected the resolved --composer-focus value (${resolvedComposerFocus}).`);
        } else {
          findings.push(`${theme.name}: real keyboard Tab landed on "${step.ariaLabel}" with a settled, resolved --composer-focus outline (${step.outlineStyle}, ${step.outlineColor}, ${step.outlineWidth}).`);
        }
      }
      if (sendStep && !sendStep.notReached && !sendStep.wrongPosition && sendStep.outlineStyle !== 'none') {
        if (sendStep.outlineColor !== resolvedRing) {
          failures.push(`${theme.name}: Send's settled outline-color is ${sendStep.outlineColor}, expected the resolved --ring value (${resolvedRing}).`);
        } else {
          findings.push(`${theme.name}: Send's settled outline-color matches the resolved --ring value (${resolvedRing}).`);
        }
        if (theme.id === 'dark-high-contrast') {
          if (resolvedComposerFocus !== resolvedRing) failures.push(`${theme.name}: expected --composer-focus to alias --ring in this theme (full ring, decision 3); resolved --composer-focus ${resolvedComposerFocus} vs --ring ${resolvedRing}.`);
          else findings.push(`${theme.name}: --composer-focus aliases --ring (${resolvedRing}) as this theme's full-ring decision (3) requires.`);
        } else if (resolvedComposerFocus === resolvedRing) {
          failures.push(`${theme.name}: expected a muted --composer-focus distinct from Send's --ring in this theme; both resolved to ${resolvedRing}.`);
        } else {
          findings.push(`${theme.name}: --composer-focus (${resolvedComposerFocus}) is distinct from --ring (${resolvedRing}) -- confirms the #927 muted/opaque split took effect.`);
        }
      }
      // Screenshot only once Attach is genuinely the live document.activeElement (item 4) --
      // never blind to whether the chain above actually landed there (a failure above already
      // covers Attach never being reached at all).
      const activeIsAttach = await cdp.evaluate(`(() => { const el = document.activeElement; return !!el && typeof el.getAttribute === 'function' && (el.getAttribute('aria-label') || '').startsWith('Attach images'); })()`);
      if (activeIsAttach) {
        await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-01-attach-focus-ring.png`));
      }
      await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

      // ---- (e), issue #928: status line chip text/icon sizes ----
      // Issue #928: `on_launch`'s own unconditional first `schedule_readout_update` call (Rust
      // `session/readout.rs`) runs `READOUT_COALESCE_MS` (100ms) after launch, computing a real
      // `diff_stat` (git status) even with zero changes -- `ChangesChip` renders once that
      // `readout:update` event lands, with no turn needed. Confirmed live (this script's own
      // screenshots): the chip DOES render, just not always inside a short post-launch window
      // (readout-computation latency, the same pre-existing gap `verify-563-subagent-stage.mjs`
      // already documents for the Subagents chip) -- polls generously here, per theme, rather
      // than a single early timed-out wait that masked a real, measurable chip as "absent".
      try {
        await cdp.waitFor(`document.querySelectorAll('[data-slot="readout-chip"]').length > 0`, { timeoutMs: 25_000, label: 'Status line chip rendered' });
      } catch {
        // fall through -- the presence/size checks below report the real failure, never a skip.
      }
      // Item 2: the status line container itself (`data-slot="composer-status-line"`,
      // ComposerStatusLine.tsx) is checked SEPARATELY from its chips -- "the status line
      // rendered but no chip matched" and "the status line never mounted at all" are both real
      // failures, never `notExercised`; the bundle-marker guard earlier in this script only
      // proves this BUILD contains #928's code, never that it actually renders correctly --
      // this live DOM/size check is the only real #928 proof.
      const statusLinePresent = await cdp.evaluate(`!!document.querySelector('[data-slot="composer-status-line"]')`);
      const chipSizes = await readStatusLineChipSizes(cdp);
      if (!statusLinePresent) {
        failures.push(`${theme.name}: the composer status line itself ([data-slot="composer-status-line"]) is not present in the DOM -- ComposerStatusLine never mounted.`);
      } else if (!chipSizes || chipSizes.length === 0) {
        failures.push(`${theme.name}: the status line rendered but no [data-slot="readout-chip"] chip matched after a 25s poll -- DEFAULT_SESSION_READOUT turns changes/context-usage/turn-time on, at least one should render.`);
      } else {
        for (const chip of chipSizes) {
          if (chip.fontSize !== '13px') failures.push(`${theme.name}: status line chip "${chip.text}" computed font-size is ${chip.fontSize}, expected 13px (issue #928).`);
          else findings.push(`${theme.name}: status line chip "${chip.text}" reads 13px text (issue #928).`);
          if (!chip.iconRect) {
            failures.push(`${theme.name}: status line chip "${chip.text}" has no icon svg to measure -- every chip in DEFAULT_SESSION_READOUT ships one.`);
          } else if (chip.iconRect.width !== 14 || chip.iconRect.height !== 14) {
            failures.push(`${theme.name}: status line chip "${chip.text}" icon rendered size is ${chip.iconRect.width}x${chip.iconRect.height}px (getBoundingClientRect), expected 14x14px (issue #928).`);
          } else {
            findings.push(`${theme.name}: status line chip "${chip.text}" icon renders at 14x14px (issue #928).`);
          }
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-02-status-line.png`));
    }
    if (!anyDisabledTriggerSeen) {
      notExercised.push('Item 5 (T3) aria-disabled hover check: no ghost trigger was ever aria-disabled in this run -- this scratch harness never sends a turn, and a picker only disables while the Session is working/needs-you or stopped, neither of which this script produces.');
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
