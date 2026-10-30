#!/usr/bin/env node
// Live CDP check for #1050: the composer command pill renders without a spelling underline,
// with a visible caret, selection and slash-menu completion across all five themes.

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
import { TEXTAREA, PILL, OVERLAY, THEMES, clearAndType, measurePillGeometry, overlayStructure, assertCaretVisible, assertSelectionHighlightVisible, assertSelectedGlyphsInkVisible, defaultShotsDir } from './verify-1050-command-pill-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1050';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1050_SHOTS_DIR || defaultShotsDir();
const LONG_SKILL = 'skill:demo-review-with-a-very-long-name-used-only-to-force-the-recognised-token-to-wrap-across-two-or-more-visual-lines-in-the-composer-textarea-so-this-live-check-reliably-exercises-the-multi-line-pill-box-decoration-break-rounding-behaviour-end-to-end-every-single-run';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Parses a resolved colour string into its OKLCH hue (degrees). Chromium keeps `oklch(...)` notation
 * through getComputedStyle, so parse that directly and fall back to sRGB -> OKLab -> OKLCH for `rgb()`. */
function rgbStringToOklchHue(colorStr) {
  const str = typeof colorStr === 'string' ? colorStr.trim() : '';
  const oklchMatch = str.match(/^oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/);
  if (oklchMatch) return parseFloat(oklchMatch[1]) % 360;
  const rgbMatch = str.match(/rgba?\(([^)]+)\)/);
  if (!rgbMatch) return null;
  const [r, g, b] = rgbMatch[1].split(',').map((n) => parseFloat(n) / 255);
  const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [rl, gl, bl] = [decode(r), decode(g), decode(b)];
  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m_ = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
  const [l_, m2, s_] = [Math.cbrt(l), Math.cbrt(m_), Math.cbrt(s)];
  const a = 1.9779984951 * l_ - 2.428592205 * m2 + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m2 - 0.808675766 * s_;
  let hue = (Math.atan2(bb, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hue;
}

/** The shorter-arc angular difference between two hues (0-360 each), e.g. `circularHueDiff(2,
 * 358) === 4`, never the naive `356` a plain subtraction would give. */
function circularHueDiff(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
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
    '02b-selection-highlight.png',
    '03-pill-skill.png',
    '04-spellcheck-returns.png',
    '05-scrolled-multiline.png',
    '06-slash-menu-completion.png',
    '07-wrapping-token.png',
    '08-chip-plus-pill.png',
    ...THEMES.map((t) => `theme-${t.id}.png`)
  ]);

  const report = [];
  const notExercised = [
    'Ghost text shown at the SAME TIME as the leading command pill: this harness has no scripted ' +
      "predict_word response (chat.predictWord degrades silently to no suggestion on no reply, " +
      'per FR-058), so forcing a live ghost suggestion to coexist with the pill was not reachable ' +
      'this round without adding a second RPC channel to the fake-omp tape. The OTHER half of this ' +
      'combination (a pasted-text chip beside the pill) is exercised below.',
    'Real OS Windows High Contrast / forced-colours mode: no forced-colours harness exists here. ' +
      "The code's own alignment argument (identical box-model classes on the mirror and the " +
      'textarea, so the UA\'s forced CanvasText remap lands both renderings on the same pixels) ' +
      'is reasoned in CommandPillOverlay.tsx\'s own header comment, not live-proven.',
    'Real IME composition (an actual CJK/dead-key input method): no IME harness exists here. ' +
      "Reasoned, not proven: composed text shows through the mirror correctly, because the " +
      "masking moved from `color` to `-webkit-text-fill-color` specifically so anything reading " +
      "`color` (a composition underline included, drawn in `currentColor` by default) keeps a " +
      "real, visible value (CommandPillOverlay.tsx's own comment has the full reasoning). NOT " +
      "verified: the underline's own actual rendered colour/visibility, which needs a real IME " +
      "session to confirm.",
    'Real display zoom (OS/browser zoom level changed mid-session): not driven live; the caret/' +
      'geometry checks below run at the default 100% zoom only.',
    '`/btw` (a recognised, PILLED command) actually reaching a real `chat.send` via a genuine ' +
      'Send click: never exercised together. `/btw` is special-cased by `handleSend` (opens the ' +
      "Side chat panel instead of calling `chat.send` -- confirmed live, draft left untouched, " +
      "gate round 4 finding), so the Send/Stop clickability check below sends `/skill:demo-" +
      "review hi` instead (a DIFFERENT recognised command with no special-cased handling, " +
      'proving the identical z-index/clickability scenario). The pill itself, `/btw`\'s own ' +
      'spellcheck-off and selection-highlight behaviour are all exercised earlier in this run ' +
      'with `/btw` directly; only the combination of its pill WITH a real completed Send is not.'
  ];

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
    await clearAndType(cdp, pressKey, '/zzz hi');
    await sleep(300);
    assertEqual(await cdp.evaluate(`document.querySelectorAll('[data-command-pill-token]').length`), 0, '/zzz hi: no pill rendered');
    assertEqual(await cdp.evaluate(`document.querySelectorAll('[data-command-pill-overlay]').length`), 0, '/zzz hi: no mirror overlay mounted at all');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), true, '/zzz hi: spellcheck stays on');
    const noPillRect = await cdp.evaluate(`(() => { const ta = ${TEXTAREA}; const r = ta.getBoundingClientRect(); return { height: r.height, scrollHeight: ta.scrollHeight }; })()`);
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 36, 'Home', 'Home');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
    const noPillCaret = await cdp.evaluate(`({ start: ${TEXTAREA}.selectionStart, end: ${TEXTAREA}.selectionEnd })`);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-no-pill-zzz.png'));

    // ---- 2. /btw hi (native, recognised): pill, spellcheck off, arguments stay plain,
    //         pixel-visible caret, real selection highlight --------------------------------
    await clearAndType(cdp, pressKey, '/btw hi');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/btw hi: pill appears' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), '/btw', '/btw hi: pill text is exactly the token');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), false, '/btw hi: spellcheck off');
    const btwStruct = await overlayStructure(cdp);
    assertEqual(btwStruct.textContent, '/btw hi', '/btw hi: overlay textContent equals the whole draft (nothing swallowed)');
    assertEqual(btwStruct.elementChildCount, 1, '/btw hi: the overlay has exactly one element child (the pill) -- arguments are bare, unwrapped text');
    assertEqual(btwStruct.pillText, '/btw', '/btw hi: that one element child is the pill, holding just the token');

    const geom = await measurePillGeometry(cdp);
    assertTrue(geom !== null, '/btw hi: textarea and pill both found for geometry');
    assertClose(geom.pillLeft, geom.expectedLeft, 1.5, "/btw hi: pill's left edge sits at the textarea's own real padding-left corner");
    assertClose(geom.pillTop, geom.expectedTop, 1.5, "/btw hi: pill's top edge sits at the textarea's own real padding-top corner");
    assertTrue(geom.pillWidth > 10 && geom.pillWidth < 60, `/btw hi: pill width (${geom.pillWidth}px) plausible for a 4-character token, not the whole line`);
    assertTrue(geom.pillHeight > 10 && geom.pillHeight < 40, `/btw hi: pill height (${geom.pillHeight}px) is one text line, not the whole box`);

    await assertCaretVisible(cdp, sleep, 0, '/btw hi: caret pixel-visible at offset 0 (start of the pilled token)', report);
    await assertCaretVisible(cdp, sleep, 2, '/btw hi: caret pixel-visible at offset 2 (mid-token, inside the pill)', report);
    // Shoot the resting frame before Ctrl+A, which leaves the draft selected.
    await cdp.screenshot(path.join(SHOTS_DIR, '02-pill-btw.png'));
    await assertSelectionHighlightVisible(cdp, pressKey, resolveCssVarColor, report, SHOTS_DIR);
    await assertSelectedGlyphsInkVisible(cdp, pressKey, report);

    // ---- 3. Height/caret identical with and without the pill (both exactly 7 characters) ---
    await clearAndType(cdp, pressKey, '/btw hi');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/btw hi: pill re-shown for the height/caret identity check' });
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

    // ---- 4. /skill:demo-review (tape-provided skill, recognised) ---------------------------
    await clearAndType(cdp, pressKey, '/skill:demo-review do it');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/skill:demo-review do it: pill appears' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), '/skill:demo-review', '/skill:demo-review do it: pill text is the whole token including the skill: prefix');
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), false, '/skill:demo-review do it: spellcheck off');
    const skillStruct = await overlayStructure(cdp);
    assertEqual(skillStruct.textContent, '/skill:demo-review do it', '/skill:demo-review do it: overlay textContent equals the whole draft');
    assertEqual(skillStruct.elementChildCount, 1, '/skill:demo-review do it: exactly one element child (the pill); " do it" is bare text');
    await cdp.screenshot(path.join(SHOTS_DIR, '03-pill-skill.png'));

    // ---- 5. Completing a partial command via a REAL slash-menu click produces the pill -----
    await clearAndType(cdp, pressKey, '/bt');
    const btwOptionFinder = `Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.toLowerCase().includes('btw'))`;
    await cdp.waitFor(`!!(${btwOptionFinder})`, { timeoutMs: 5_000, label: 'slash menu lists a btw match for "/bt"' });
    await cdp.click(btwOptionFinder);
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'completing /bt via a real slash-menu click produces the pill' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), '/btw', 'slash-menu completion: the resulting pill reads /btw');
    await cdp.screenshot(path.join(SHOTS_DIR, '06-slash-menu-completion.png'));

    // ---- 6. /btw -> /btwx (edited into an unrecognised name) drops the pill ----------------
    await clearAndType(cdp, pressKey, '/btw');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: '/btw: pill shown before the edit' });
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 35, 'End', 'End');
    await cdp.send('Input.insertText', { text: 'x' });
    await cdp.waitFor(`${PILL} === null`, { timeoutMs: 5_000, label: '/btw -> /btwx: pill drops the instant the name stops matching' });
    assertEqual(await cdp.evaluate(`${TEXTAREA}.value`), '/btwx', "/btw -> /btwx: draft reads '/btwx'");
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), true, '/btw -> /btwx: spellcheck is back on');

    // ---- 7. Spellcheck returns the instant the leading slash is deleted -------------------
    await clearAndType(cdp, pressKey, '/skill:demo-review do it');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'slash-delete test: pill shown before the edit' });
    await cdp.evaluate(`${TEXTAREA}.focus()`);
    await pressKey(cdp, 36, 'Home', 'Home');
    await pressKey(cdp, 46, 'Delete', 'Delete'); // forward-delete removes just the leading '/'
    await cdp.waitFor(`${PILL} === null`, { timeoutMs: 5_000, label: 'slash deleted: pill disappears' });
    assertEqual(await cdp.evaluate(`${TEXTAREA}.value`), 'skill:demo-review do it', "slash deleted: draft reads 'skill:demo-review do it' (an ordinary word, no leading slash)");
    assertEqual(await cdp.evaluate(`${TEXTAREA}.spellcheck`), true, 'slash deleted: spellcheck back on');
    await cdp.screenshot(path.join(SHOTS_DIR, '04-spellcheck-returns.png'));

    // ---- 8. A long wrapping skill name still pills correctly across visual lines ----------
    await clearAndType(cdp, pressKey, `/${LONG_SKILL} do it`);
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'long skill name: pill appears' });
    assertEqual(await cdp.evaluate(`${PILL}.textContent`), `/${LONG_SKILL}`, 'long skill name: pill holds the whole (long) token');
    const wrappingGeom = await cdp.evaluate(`(() => {
      const ta = ${TEXTAREA};
      const pill = ${PILL};
      const pillRects = pill.getClientRects();
      return { taWidth: ta.getBoundingClientRect().width, pillLineCount: pillRects.length, pillRects: Array.from(pillRects).map((r) => ({ left: r.left, top: r.top, width: r.width })) };
    })()`);
    assertTrue(wrappingGeom.pillLineCount >= 2, `long skill name: the pill's own [box-decoration-break:clone] rounding renders across ${wrappingGeom.pillLineCount} visual line fragment(s), confirming it actually wrapped`, wrappingGeom);
    // Offset 150 is past the ~90-char first line, proving caret alignment on wrapped lines.
    await assertCaretVisible(cdp, sleep, 150, 'long skill name: caret pixel-visible mid-token on a wrapped visual line', report);
    await cdp.screenshot(path.join(SHOTS_DIR, '07-wrapping-token.png'));

    // ---- 9. A pasted-text chip renders beside the pill (ghost text: see notExercised) -----
    await clearAndType(cdp, pressKey, '/btw ');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'chip+pill: pill shown before the paste' });
    const longPasteText = 'x'.repeat(900);
    await cdp.evaluate(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(longPasteText)});
      const ta = ${TEXTAREA};
      ta.focus();
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await cdp.waitFor(`document.querySelectorAll('[role="group"][aria-label="Pending attachments"] button').length > 0`, {
      timeoutMs: 5_000,
      label: 'chip+pill: the large paste collapsed into a pending text chip'
    });
    assertTrue(await cdp.evaluate(`${PILL} !== null`), 'chip+pill: the leading command pill is still shown alongside the new pasted-text chip');
    // Target the in-composer chip mirror (span[role="button"]) beside the pill, which its shadow or z-index could
    // cover; the real above-composer strip is never occluded. Check by elementFromPoint and a real click.
    const chipHit = await cdp.evaluate(`(() => {
      const chip = document.querySelector('span[role="button"]');
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { reachable: hit === chip || chip.contains(hit) };
    })()`);
    assertTrue(!!chipHit && chipHit.reachable, "chip+pill: the in-composer chip mirror's span[role=\"button\"] is actually hit-testable (elementFromPoint at its own centre), not occluded by the pill's mirror or the textarea", chipHit);
    await cdp.click(`document.querySelector('span[role="button"]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, {
      timeoutMs: 5_000,
      label: 'chip+pill: a real click on the in-composer chip mirror opens its preview dialog'
    });
    // Focus stays in the dialog, so Escape reaches Radix's dismiss, not the composer's onKeyDown (which clears the draft).
    await pressKey(cdp, 27, 'Escape', 'Escape');
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 5_000, label: 'chip+pill: preview dialog closed before continuing' });
    assertTrue(await cdp.evaluate(`${PILL} !== null`), 'chip+pill: the pill is still shown after the dialog closes and focus returns to the textarea');
    await cdp.screenshot(path.join(SHOTS_DIR, '08-chip-plus-pill.png'));

    // ---- 10. Pill stays aligned across all five theme presets, fill/text colour verified --
    await clearAndType(cdp, pressKey, '/skill:demo-review do it');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'theme loop: pill re-shown' });
    for (const theme of THEMES) {
      if (theme.id !== 'dark') {
        await switchTheme(cdp, theme.id, theme.name);
        // The Profile button's tooltip can stay open; CDP mouseMoved doesn't fire Radix's pointerleave, so use Escape plus
        // a real click, best-effort. Escape only in the switchTheme branch: in Dark the textarea is still focused and Escape would clear the draft.
        await pressKey(cdp, 27, 'Escape', 'Escape');
        const neutralPoint = await cdp.evaluate(`(() => { const r = ${TEXTAREA}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: neutralPoint.x, y: neutralPoint.y });
        await cdp.click(TEXTAREA);
        await cdp
          .waitFor(`!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `${theme.name}: any stuck tooltip closed before measuring` })
          .catch((err) => {
            notExercised.push(
              `${theme.name}: a stuck Profile-name tooltip did not close after Escape + a real click away (${err.message}) -- the same documented CDP/Radix limitation verify-937-advisor-chip.mjs's gate round 5 already found (synthetic events cannot reliably reproduce the real pointerleave/blur Radix's own close logic listens for); cosmetic only, the pill geometry/colour assertions below are unaffected.`
            );
          });
      }
      // The Profile dropdown's close animation and any tooltip can still be mid-transition; wait before measuring.
      await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: `${theme.name}: profile menu fully closed before measuring` });
      await sleep(300);
      const themeGeom = await measurePillGeometry(cdp);
      assertTrue(themeGeom !== null, `${theme.name}: pill found`);
      assertClose(themeGeom.pillLeft, themeGeom.expectedLeft, 1.5, `${theme.name}: pill left edge still sits at the textarea's own padding-left corner`);
      assertClose(themeGeom.pillTop, themeGeom.expectedTop, 1.5, `${theme.name}: pill top edge still sits at the textarea's own padding-top corner`);
      const pillColors = await cdp.evaluate(`(() => { const s = getComputedStyle(${PILL}); return { bg: s.backgroundColor, color: s.color }; })()`);
      const expectedBg = await resolveCssVarColor(cdp, '--command-pill-bg', 'background-color');
      const expectedColor = await resolveCssVarColor(cdp, '--command-pill-fg', 'color');
      assertEqual(pillColors.bg, expectedBg, `${theme.name}: pill background-color equals --command-pill-bg resolved live`);
      assertEqual(pillColors.color, expectedColor, `${theme.name}: pill text colour equals --command-pill-fg resolved live`);
      const pageBg = await resolveCssVarColor(cdp, '--background', 'background-color');
      assertTrue(pillColors.bg !== pageBg, `${theme.name}: pill fill is a visibly different colour from the plain page background (fill-vs-composer, measured live)`);
      // --command-pill-fg must keep the accent hue; compare hues of the live resolved colours, not the source CSS.
      const accentTextColor = await resolveCssVarColor(cdp, '--accent-text', 'color');
      const pillHue = rgbStringToOklchHue(expectedColor);
      const accentHue = rgbStringToOklchHue(accentTextColor);
      const hueDiff = pillHue !== null && accentHue !== null ? circularHueDiff(pillHue, accentHue) : null;
      assertTrue(hueDiff !== null && hueDiff <= 5, `${theme.name}: --command-pill-fg's own hue (${pillHue?.toFixed(1)}) is within 5 degrees of --accent-text's (${accentHue?.toFixed(1)})`, { pillHue, accentHue, hueDiff });
      await cdp.screenshot(path.join(SHOTS_DIR, `theme-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- 11. Scrolled multi-line draft: overlay scrollTop tracks the textarea's own --------
    const longLines = Array.from({ length: 25 }, (_, i) => `line ${i} of a long draft to force the textarea past its max height and scroll`);
    await clearAndType(cdp, pressKey, `/btw ${longLines.join('\n')}`);
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'scrolled draft: pill still shown at the top of a long draft' });
    await cdp.evaluate(`${TEXTAREA}.scrollTop = ${TEXTAREA}.scrollHeight`);
    await cdp.waitFor(`${TEXTAREA}.scrollTop > 0 && ${OVERLAY}.scrollTop === ${TEXTAREA}.scrollTop`, {
      timeoutMs: 3_000,
      label: 'scrolled draft: command-pill overlay scrollTop synced to the textarea after scrolling to the bottom'
    });
    // Caret must still land on-screen after scrolling to the bottom.
    const endOffset = await cdp.evaluate(`${TEXTAREA}.value.length`);
    await assertCaretVisible(cdp, sleep, endOffset, 'scrolled draft: caret pixel-visible at the end of the draft after scrolling to the bottom', report);
    await cdp.screenshot(path.join(SHOTS_DIR, '05-scrolled-multiline.png'));
    await cdp.evaluate(`${TEXTAREA}.scrollTop = 0`);
    await cdp.waitFor(`${OVERLAY}.scrollTop === 0`, { timeoutMs: 3_000, label: 'scrolled draft: overlay scrollTop synced back to 0 after scrolling to the top' });

    // ---- 12. Send/Stop clickable while a pill shows (gate round 3 CRITICAL fix) ------------
    // The textarea's z-index (only while a pill shows) once painted over Send/Stop. Run last: a real click sends.
    // Use /skill, not /btw: /btw opens the Side chat panel and refuses the send, leaving the draft.
    await clearAndType(cdp, pressKey, '/skill:demo-review hi');
    await cdp.waitFor(`${PILL} !== null`, { timeoutMs: 5_000, label: 'Send/Stop clickability: pill shown before the click' });
    const sendHit = await cdp.evaluate(`(() => {
      const send = document.querySelector('[aria-label="Send message"]');
      if (!send) return null;
      const r = send.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, reachable: hit === send || send.contains(hit) };
    })()`);
    assertTrue(!!sendHit && sendHit.reachable, "Send/Stop clickability: elementFromPoint at Send's own centre returns Send while a pill shows (not the textarea its z-[1] used to paint over)", sendHit);
    await cdp.click(`document.querySelector('[aria-label="Send message"]')`);
    await cdp.waitFor(`${TEXTAREA}.value === ''`, { timeoutMs: 5_000, label: 'Send/Stop clickability: a real pointer click on Send actually sent (draft cleared)' });

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [
        '01-no-pill-zzz.png',
        '02-pill-btw.png',
        '02b-selection-highlight.png',
        '03-pill-skill.png',
        '04-spellcheck-returns.png',
        '05-scrolled-multiline.png',
        '06-slash-menu-completion.png',
        '07-wrapping-token.png',
        '08-chip-plus-pill.png',
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
