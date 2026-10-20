#!/usr/bin/env node
// Live CDP check for issue #1050 (composer command pill, no spelling underline). Decided
// (Skippy, delegated by Stuart 2026-10-19, away mode); FR-092, spec 001 Phase 71. Modelled on
// `verify-997-notice-severity.mjs` (single launch, fake-omp tape, five-theme loop) and
// `verify-741-role-chip.mjs` (geometry/contrast proof style), not `verify-947-938-slash-menu.mjs`'s
// ambient-real-omp pattern: that pattern exists specifically for OMP BUILTIN subcommands, which
// need a real probe to verify (FR-032); a `source: 'skill'` descriptor needs no such probe --
// Refract's own classification treats any non-builtin-sourced entry identically regardless of
// whether a skill by that name exists on disk (`filter_supported_commands`/
// `classifySlashInvocation`) -- so the fake-omp tape (`1050-command-pill.jsonl`, this README row)
// carries one deterministic `source: 'skill'` descriptor instead, avoiding the flakiness of
// depending on whichever skills happen to be installed in this harness's own ambient ~/.omp.
// `/btw` needs no tape entry at all: `NATIVE_BUILT_COMMANDS` is unconditionally prepended
// Rust-side regardless of what any tape lists.
//
// Checks, in order:
//   1. `/zzz hi` (unrecognised): no pill, `spellcheck` stays `true`.
//   2. `/btw hi` (native, recognised): pill with text `/btw`; `spellcheck === false`; the
//      overlay's own two children are exactly [the pill, an invisible gap covering ` hi`]
//      (arguments stay plain, asserted structurally, not by pixel guess).
//   3. Pill geometry: the pill's own rect sits at the textarea's own content-box top-left corner
//      (`getBoundingClientRect()` plus the textarea's own real `getComputedStyle()` padding --
//      never a guessed offset), with a plausible width/height for a 4-character token.
//   4. Height/caret identical with and without the pill: `/zzz hi` and `/btw hi` are both exactly
//      7 characters; `getBoundingClientRect().height`/`scrollHeight` and `selectionStart`/
//      `selectionEnd` after an identical Home+3xArrowRight sequence are compared between them.
//   5. `/skill:demo-review do it` (tape-provided skill, recognised): pill text is the whole
//      `/skill:demo-review` token (including the prefix); arguments (` do it`) stay in the
//      trailing invisible gap, asserted the same structural way as item 2.
//   6. Spellcheck returns the instant the leading slash is deleted (Home, then a forward
//      Delete removes just the `/`), leaving `btw hi` -- an ordinary word, not a command.
//   7. The pill stays aligned (geometry re-measured) across all five theme presets, with the
//      pill's own computed `background-color`/`color` equal to `--card`/`--accent-text` resolved
//      live (`resolveCssVarColor`, never a hand-copied hex) -- screenshotted every preset.
//   8. A scrolled multi-line draft: the command-pill overlay's own `scrollTop` is asserted equal
//      to the textarea's real `scrollTop` after scrolling to the bottom, then back to the top.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1050';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1050_SHOTS_DIR || path.join(tmpdir(), 'refract-1050-command-pill-shots');

// All five built-in theme presets (`src/shared/themes.ts`); decision 3's contrast fix and the
// pill's own accent/fill both genuinely differ per preset, so every one is checked and shot.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const TEXTAREA = `document.querySelector('[aria-label="Message"]')`;
const PILL = `document.querySelector('[data-command-pill-token]')`;
const OVERLAY = `document.querySelector('[data-command-pill-overlay]')`;

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function clearAndType(cdp, text) {
  await cdp.click(TEXTAREA);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select all existing text
  await pressKey(cdp, 8, 'Backspace', 'Backspace'); // delete the selection
  await cdp.waitFor(`${TEXTAREA}.value === ''`, { timeoutMs: 5_000, label: 'composer cleared before typing' });
  await cdp.send('Input.insertText', { text });
}

/** The pill's own rect against the textarea's REAL `getComputedStyle()` padding -- never a
 * guessed offset -- so this proves the pill lands exactly over the token's own glyphs in the
 * real control the user types into, not merely inside the inert overlay's own copied box model. */
async function measurePillGeometry(cdp) {
  return cdp.evaluate(`(() => {
    const ta = ${TEXTAREA};
    const pill = ${PILL};
    if (!ta || !pill) return null;
    const taRect = ta.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const style = getComputedStyle(ta);
    return {
      expectedLeft: taRect.left + parseFloat(style.paddingLeft),
      expectedTop: taRect.top + parseFloat(style.paddingTop),
      pillLeft: pillRect.left,
      pillTop: pillRect.top,
      pillWidth: pillRect.width,
      pillHeight: pillRect.height
    };
  })()`);
}

async function overlaySegments(cdp) {
  return cdp.evaluate(`(() => {
    const overlay = ${OVERLAY};
    if (!overlay) return null;
    return Array.from(overlay.children).map((el) => ({
      isPill: el.hasAttribute('data-command-pill-token'),
      isInvisible: el.classList.contains('invisible'),
      text: el.textContent
    }));
  })()`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1050-command-pill-shots', [
    'report.json',
    '01-no-pill-zzz.png',
    '02-pill-btw.png',
    '03-pill-skill.png',
    '04-spellcheck-returns.png',
    '05-scrolled-multiline.png',
    ...THEMES.map((t) => `theme-${t.id}.png`)
  ]);

  const report = [];
  const notExercised = [];

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertTrue(actual, label, extra) {
    const ok = actual === true;
    report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}${extra ? `, ${JSON.stringify(extra)}` : ''})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertClose(actual, expected, epsilonPx, label) {
    const diff = Math.abs(actual - expected);
    const ok = diff <= epsilonPx;
    report.push({ step: label, ok, actual, expected, diff, epsilonPx });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${actual}, expected ${expected}, diff ${diff} > ${epsilonPx})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1050-data-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1050-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1050-command-pill');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1050-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1050-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1050-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: '1050-command-pill'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    // Real UI flow (same convention every Tauri live check uses): readiness, Add repository,
    // New session, wait for the composer against the fake omp's scripted tape.
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
    await cdp.waitFor(`(() => { const el = ${TEXTAREA}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session composer enabled' });

    // ---- 1. /zzz (unrecognised): no pill, spellcheck stays on ------------------------------
    await clearAndType(cdp, '/zzz hi');
    await sleep(300);
    assertEqual(await cdp.evaluate(`document.querySelectorAll('[data-command-pill-token]').length`), 0, '/zzz hi: no pill rendered');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), true, '/zzz hi: spellcheck stays on');
    const noPillRect = await cdp.evaluate(`(() => { const ta = ${TEXTAREA}; const r = ta.getBoundingClientRect(); return { height: r.height, scrollHeight: ta.scrollHeight }; })()`);
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 36, 'Home', 'Home');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    const noPillCaret = await cdp.evaluate(`({ start: ${TEXTAREA}.selectionStart, end: ${TEXTAREA}.selectionEnd })`);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-no-pill-zzz.png'));

    // ---- 2. /btw hi (native, recognised): pill, spellcheck off, arguments stay plain -------
    await clearAndType(cdp, '/btw hi');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/btw hi: pill appears' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), '/btw', '/btw hi: pill text is exactly the token');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), false, '/btw hi: spellcheck off');
    const btwSegs = await overlaySegments(cdp);
    assertEqual(btwSegs?.length, 2, '/btw hi: overlay has exactly 2 segments (pill + trailing gap)');
    assertTrue(btwSegs[0].isPill && btwSegs[0].text === '/btw', '/btw hi: first segment is the pill holding just the token');
    assertTrue(btwSegs[1].isInvisible && btwSegs[1].text === ' hi', '/btw hi: second segment is an invisible gap covering the arguments exactly (arguments stay plain)');

    // ---- 3. Pill geometry: sits at the textarea's own real content-box corner --------------
    const geom = await measurePillGeometry(cdp);
    assertTrue(geom !== null, '/btw hi: textarea and pill both found for geometry');
    assertClose(geom.pillLeft, geom.expectedLeft, 1.5, "/btw hi: pill's left edge sits at the textarea's own real padding-left corner");
    assertClose(geom.pillTop, geom.expectedTop, 1.5, "/btw hi: pill's top edge sits at the textarea's own real padding-top corner");
    assertTrue(geom.pillWidth > 10 && geom.pillWidth < 60, `/btw hi: pill width (${geom.pillWidth}px) plausible for a 4-character token, not the whole line`);
    assertTrue(geom.pillHeight > 10 && geom.pillHeight < 40, `/btw hi: pill height (${geom.pillHeight}px) is one text line, not the whole box`);

    // ---- 4. Height/caret identical with and without the pill (both exactly 7 characters) ---
    const pillRect = await cdp.evaluate(`(() => { const ta = ${TEXTAREA}; const r = ta.getBoundingClientRect(); return { height: r.height, scrollHeight: ta.scrollHeight }; })()`);
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 36, 'Home', 'Home');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    const pillCaret = await cdp.evaluate(`({ start: ${TEXTAREA}.selectionStart, end: ${TEXTAREA}.selectionEnd })`);
    assertEqual(pillRect.height, noPillRect.height, "textarea getBoundingClientRect().height identical with and without the pill ('/btw hi' vs '/zzz hi', both 7 chars)");
    assertEqual(pillRect.scrollHeight, noPillRect.scrollHeight, 'textarea scrollHeight identical with and without the pill');
    assertEqual(pillCaret.start, noPillCaret.start, 'caret selectionStart identical with and without the pill after an identical Home+3xArrowRight sequence');
    assertEqual(pillCaret.end, noPillCaret.end, 'caret selectionEnd identical with and without the pill after an identical Home+3xArrowRight sequence');
    await cdp.screenshot(path.join(SHOTS_DIR, '02-pill-btw.png'));

    // ---- 5. /skill:demo-review (tape-provided skill, recognised) ---------------------------
    await clearAndType(cdp, '/skill:demo-review do it');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/skill:demo-review do it: pill appears' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), '/skill:demo-review', '/skill:demo-review do it: pill text is the whole token including the skill: prefix');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), false, '/skill:demo-review do it: spellcheck off');
    const skillSegs = await overlaySegments(cdp);
    assertEqual(skillSegs?.length, 2, '/skill:demo-review do it: overlay has exactly 2 segments');
    assertTrue(skillSegs[1].isInvisible && skillSegs[1].text === ' do it', '/skill:demo-review do it: arguments (" do it") stay in the invisible gap, plain text');
    await cdp.screenshot(path.join(SHOTS_DIR, '03-pill-skill.png'));

    // ---- 6. Spellcheck returns the instant the leading slash is deleted -------------------
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 36, 'Home', 'Home');
    await pressKey(cdp, 46, 'Delete', 'Delete'); // forward-delete removes just the leading '/'
    await cdp.waitFor(`${PILL} === null`, { timeoutMs: 5_000, label: 'slash deleted: pill disappears' });
    assertEqual(await cdp.evaluate(`${TEXTAREA}.value`), 'skill:demo-review do it', "slash deleted: draft reads 'skill:demo-review do it' (an ordinary word, no leading slash)");
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), true, 'slash deleted: spellcheck back on');
    await cdp.screenshot(path.join(SHOTS_DIR, '04-spellcheck-returns.png'));

    // ---- 7. Pill stays aligned across all five theme presets, fill/text colour verified ---
    await clearAndType(cdp, '/skill:demo-review do it');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'theme loop: pill re-shown' });
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const themeGeom = await measurePillGeometry(cdp);
      assertTrue(themeGeom !== null, `${theme.name}: pill found`);
      assertClose(themeGeom.pillLeft, themeGeom.expectedLeft, 1.5, `${theme.name}: pill left edge still sits at the textarea's own padding-left corner`);
      assertClose(themeGeom.pillTop, themeGeom.expectedTop, 1.5, `${theme.name}: pill top edge still sits at the textarea's own padding-top corner`);
      const pillColors = await cdp.evaluate(`(() => { const s = getComputedStyle(${PILL}); return { bg: s.backgroundColor, color: s.color }; })()`);
      const expectedBg = await resolveCssVarColor(cdp, '--card', 'background-color');
      const expectedColor = await resolveCssVarColor(cdp, '--accent-text', 'color');
      assertEqual(pillColors.bg, expectedBg, `${theme.name}: pill background-color equals --card resolved live`);
      assertEqual(pillColors.color, expectedColor, `${theme.name}: pill text colour equals --accent-text resolved live`);
      await cdp.screenshot(path.join(SHOTS_DIR, `theme-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- 8. Scrolled multi-line draft: overlay scrollTop tracks the textarea's own --------
    const longLines = Array.from({ length: 25 }, (_, i) => `line ${i} of a long draft to force the textarea past its max height and scroll`);
    await clearAndType(cdp, `/btw ${longLines.join('\n')}`);
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'scrolled draft: pill still shown at the top of a long draft' });
    await cdp.evaluate(`${TEXTAREA}.scrollTop = ${TEXTAREA}.scrollHeight`);
    await cdp.waitFor(`${TEXTAREA}.scrollTop > 0 && ${OVERLAY}.scrollTop === ${TEXTAREA}.scrollTop`, {
      timeoutMs: 3_000,
      label: 'scrolled draft: command-pill overlay scrollTop synced to the textarea after scrolling to the bottom'
    });
    await cdp.screenshot(path.join(SHOTS_DIR, '05-scrolled-multiline.png'));
    await cdp.evaluate(`${TEXTAREA}.scrollTop = 0`);
    await cdp.waitFor(`${OVERLAY}.scrollTop === 0`, { timeoutMs: 3_000, label: 'scrolled draft: overlay scrollTop synced back to 0 after scrolling to the top' });

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [
        '01-no-pill-zzz.png',
        '02-pill-btw.png',
        '03-pill-skill.png',
        '04-spellcheck-returns.png',
        '05-scrolled-multiline.png',
        ...THEMES.map((t) => `theme-${t.id}.png`)
      ])
    });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
