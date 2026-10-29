// Shared helpers for verify-1050-command-pill.mjs (gate round 1 HIGH remediation, file-size
// split: the main script grew past its own 600-line cap once the caret-visibility, selection-
// highlight, slash-menu-completion and wrapping-token checks were added on top of the original
// pill/spellcheck/geometry/theme checks).
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseComputedColorToEntry, resolvedLinear, srgbGammaEncode } from './contrast-math.mjs';

export const TEXTAREA = `document.querySelector('[aria-label="Message"]')`;
export const PILL = `document.querySelector('[data-command-pill-token]')`;
export const OVERLAY = `document.querySelector('[data-command-pill-overlay]')`;

// All five built-in theme presets (`src/shared/themes.ts`); decision 3's contrast fix and the
// pill's own accent/fill both genuinely differ per preset, so every one is checked and shot.
export const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

export async function clearAndType(cdp, pressKey, text) {
  await cdp.click(TEXTAREA);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select all existing text
  await pressKey(cdp, 8, 'Backspace', 'Backspace'); // delete the selection
  await cdp.waitFor(`${TEXTAREA}.value === ''`, { timeoutMs: 5_000, label: 'composer cleared before typing' });
  await cdp.send('Input.insertText', { text });
}

/** The pill's own rect against the textarea's REAL `getComputedStyle()` padding -- never a
 * guessed offset -- so this proves the pill lands exactly over the token's own glyphs in the
 * real control the user types into, not merely inside the inert mirror's own copied box model. */
export async function measurePillGeometry(cdp) {
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

/** Gate round 1 HIGH remediation (item 2): the overlay now renders the WHOLE draft (highlight-
 * within-textarea), not just invisible gap spans around the pill -- so "arguments stay plain" is
 * proven structurally by confirming the overlay's own text content matches the draft exactly
 * (nothing swallowed or duplicated) and that exactly ONE element child exists (the pill span);
 * every other character is a bare text node, never re-wrapped or re-coloured. */
export async function overlayStructure(cdp) {
  return cdp.evaluate(`(() => {
    const overlay = ${OVERLAY};
    if (!overlay) return null;
    return {
      textContent: overlay.textContent,
      elementChildCount: overlay.children.length,
      pillText: overlay.querySelector('[data-command-pill-token]')?.textContent ?? null
    };
  })()`);
}

/** Finds the real client rect of the range `[startOffset, endOffset)` against
 * `CommandPillOverlay`'s own REAL rendered mirror DOM -- not a separate offscreen `<canvas>`
 * measurement. A canvas re-implementing text metrics in isolation can legitimately disagree
 * with the browser's own real text layout (font loading timing, kerning, ligatures, subpixel
 * rounding), which is exactly what caused this check's own first draft to fail: the canvas-
 * measured x for a mid-token offset landed on a glyph stroke instead of the real caret column --
 * a script bug, not a product bug, confirmed by this fix reusing the SAME mirror the real
 * textarea is already proven (by the geometry checks above) to align with pixel-for-pixel.
 * Works for any visual line (wrapped or not) and any scroll position: `Range.getClientRects()`
 * returns real viewport-relative coordinates that already account for both, unlike the original
 * canvas measurement (which only ever handled the first, unwrapped, unscrolled line). The
 * mirror must be mounted (a recognised token showing) for this to find anything. */
async function findMirrorOffsetRect(cdp, startOffset, endOffset) {
  return cdp.evaluate(`(() => {
    const overlay = ${OVERLAY};
    if (!overlay) return null;
    function locate(offset) {
      let remaining = offset;
      let targetNode = null;
      let targetOffset = 0;
      (function visit(node) {
        if (targetNode) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const len = node.textContent.length;
          if (remaining <= len) {
            targetNode = node;
            targetOffset = remaining;
            return;
          }
          remaining -= len;
        } else {
          for (const child of node.childNodes) {
            visit(child);
            if (targetNode) return;
          }
        }
      })(overlay);
      return targetNode ? { node: targetNode, offset: targetOffset } : null;
    }
    const start = locate(${startOffset});
    const end = locate(${endOffset});
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
}

/** The real pixel position of a zero-width character BOUNDARY at `charOffset` (`startOffset ===
 * endOffset`) -- used both for the native caret's own position (`assertCaretVisible` below) and,
 * reused gate round 4, for a genuinely ink-free sample point for the selection-highlight check
 * (a letter-to-letter boundary inside plain argument text, comfortably far from the pill and its
 * own box-shadow bleed). See `findMirrorOffsetRect` above for the full reasoning. */
export async function measureCaretPixel(cdp, charOffset) {
  const rect = await findMirrorOffsetRect(cdp, charOffset, charOffset);
  if (!rect) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2) };
}

/** Reads back a small region's RGBA pixels from a REAL `Page.captureScreenshot` -- decoded
 * entirely inside the page via an offscreen `<canvas>` (`drawImage` + `getImageData`), so no
 * Node-side PNG decoder dependency is needed. A REGION, not a single pixel (gate round 3 fix):
 * the native caret is only 1-2 real screen px wide, and two independent geometric estimates of
 * its own x position (a canvas text-metrics measurement, then a mirror `Range`) each landed
 * within a pixel or two of it but not exactly ON it -- real browser caret placement and a
 * same-font-same-classes-but-separate-element geometric estimate can legitimately differ by a
 * sub-pixel amount from independent font rasterisation, even with identical CSS. Sampling a
 * small window around the estimate (not the whole pill, so a quiet, unchanging fill still
 * correctly reads "no difference" everywhere outside the caret's own column) absorbs that
 * estimation slack while staying a genuine, local, blink-timed pixel comparison. */
async function capturePixelRegion(cdp, x, y, halfWidth = 3, halfHeight = 2) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const left = Math.max(0, x - halfWidth);
  const top = Math.max(0, y - halfHeight);
  const width = halfWidth * 2 + 1;
  const height = halfHeight * 2 + 1;
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(${left}, ${top}, ${width}, ${height}).data;
      resolve(Array.from(d));
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,${data}';
  })`);
}

/** Gate round 1 HIGH remediation (item 5), widened gate round 3: pixel-proof the native caret is
 * actually visible at `charOffset`, blink-safe -- two REAL screenshots ~600ms apart (Chromium/
 * Windows' own caret-blink interval), decoded to a small region around the caret's own
 * estimated position. A permanently-hidden caret (the original bug: an opaque pill painted over
 * it) reads the SAME region in both samples regardless of timing; a genuinely blinking, visible
 * caret reads differently SOMEWHERE in that region in at least one of the two (on vs off).
 * Supplemented by a deterministic, non-timing-based fact: `caret-color` itself is a real,
 * non-transparent colour (the style half of "the caret can render at all", independent of
 * exactly where this script's own estimate landed within a couple of pixels). */
export async function assertCaretVisible(cdp, sleep, charOffset, label, report) {
  await cdp.evaluate(`${TEXTAREA}.focus(); ${TEXTAREA}.setSelectionRange(${charOffset}, ${charOffset})`);
  const caretColor = await cdp.evaluate(`getComputedStyle(${TEXTAREA}).caretColor`);
  const hasRealCaretColor = caretColor !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)/.test(caretColor);
  if (!hasRealCaretColor) throw new Error(`FAIL: ${label} (caret-color is not a real colour: ${caretColor})`);
  const pixelPos = await measureCaretPixel(cdp, charOffset);
  if (!pixelPos) throw new Error(`FAIL: ${label} (measureCaretPixel found no mirror text node at offset ${charOffset} -- is a recognised token showing?)`);
  const { x, y } = pixelPos;
  const sample1 = await capturePixelRegion(cdp, x, y);
  await sleep(600);
  const sample2 = await capturePixelRegion(cdp, x, y);
  const differs = sample1.some((value, index) => Math.abs(value - sample2[index]) > 10);
  report.push({ step: label, ok: differs, caretColor, x, y, sample1Hash: sample1.join(','), sample2Hash: sample2.join(',') });
  if (!differs) throw new Error(`FAIL: ${label} (caret region pixels identical at both 600ms-apart samples around (${x},${y}), caret-color ${caretColor})`);
  console.log(`verify-1050: PASS ${label}`);
}

/** Gate round 4 fix: `resolveCssVarColor` had only ever been fed through `outline-color`/
 * `background-color` call sites that Chromium happened to serialize as `rgb()` before -- a
 * `background-color` resolving through an INDIRECT `var()` chain (`--composer-selection-bg` ->
 * `var(--accent)` -> `oklch(0.269 0 0)`) comes back as the LITERAL `oklch(...)` string instead
 * (confirmed live: `expectedBgRaw` read `'oklch(0.269 0 0)'`, which a plain `rgba?\(...\)` regex
 * never matches, so the comparison silently always failed). Reuses `contrast-math.mjs`'s own
 * `parseComputedColorToEntry` (already handles `rgb()`/`oklch()`/`oklab()`, the same parser
 * `check-theme-contrast.mjs` relies on) instead of a second, narrower regex here.
 *
 * Gate round 5 fix (test review): `--composer-selection-bg` is now TRANSLUCENT (34% alpha,
 * `color-mix`) -- parsing its raw `background-color` string and converting straight to bytes (as
 * this function used to) treats it as if fully OPAQUE, which is the WRONG expected pixel: the
 * real on-screen result is that translucent colour COMPOSITED over whatever is actually behind
 * it (confirmed live: expected `oklab(0.62... / 0.34)` converted directly read nowhere near the
 * real captured `[46,47,89,255]`, which is in fact an almost-exact match for the colour
 * COMPOSITED over `--background`). Resolves `--composer-background` first (the textarea's own
 * immediate backdrop) and falls back to `--background` if that reads fully transparent (alpha 0
 * -- true in every preset except Dark high contrast, `globals.css`'s own `#927` comment has the
 * reasoning), then composites via the SAME gamma-space math `check-theme-contrast.mjs`/
 * `composerSelectionContrastRows` already share (`resolvedLinear`, `contrast-math.mjs`), instead
 * of a second, independently-maintained compositing formula living only here. */
async function expectedSelectionPixelBytes(cdp, resolveCssVarColor) {
  const selectionBgRaw = await resolveCssVarColor(cdp, '--composer-selection-bg', 'background-color');
  const selectionEntry = parseComputedColorToEntry(selectionBgRaw);
  if (!selectionEntry) return null;
  const composerBgRaw = await resolveCssVarColor(cdp, '--composer-background', 'background-color');
  let backdropEntry = parseComputedColorToEntry(composerBgRaw);
  if (!backdropEntry || backdropEntry.alpha === 0) {
    const pageBgRaw = await resolveCssVarColor(cdp, '--background', 'background-color');
    backdropEntry = parseComputedColorToEntry(pageBgRaw);
  }
  if (!backdropEntry) return null;
  const composited = resolvedLinear(selectionEntry, backdropEntry);
  return composited.map((c) => Math.round(srgbGammaEncode(c) * 255));
}

/** Gate round 3 HIGH fix, remediated gate round 4: round 1's version sampled the PILL's own
 * measured centre -- real ink (the mirror's own coloured glyphs), so a "differs" reading there
 * is confounded by ordinary glyph-rendering/anti-aliasing noise and proves nothing specific
 * about a selection background actually painting (confirmed live: it read `differs: true` even
 * with `::selection` having NO authored `background-color` at all, i.e. a false pass). Round
 * 3's fix (the space between `/btw` and `hi`) turned out to ALSO be wrong, for a different
 * reason: the pill's own 2px `box-shadow` padding illusion bleeds into that narrow space cell,
 * reading as the pill's own fill in BOTH samples regardless of selection state (confirmed live:
 * identical `[48,48,48,255]`, exactly Dark's `--command-pill-bg`). Fixed by sampling the
 * zero-width glyph BOUNDARY between 'h' and 'i' (offset 6 of "/btw hi") instead -- genuinely
 * plain argument text, several character-widths clear of the pill and its 2px shadow bleed, the
 * same zero-width-boundary technique already proven reliable for every caret check above -- and
 * asserting the selected reading matches the LIVE-resolved, properly COMPOSITED `--composer-
 * selection-bg` (gate round 5 fix above), not merely "differs by some threshold" (a specific,
 * false-positive-resistant assertion). Takes a resting (unselected) shot first, matching
 * `02-pill-btw.png` taken by the caller just before this runs, then its own post-selection shot
 * (`02b-selection-highlight.png`) as separate visual evidence. */
export async function assertSelectionHighlightVisible(cdp, pressKey, resolveCssVarColor, report, shotsDir) {
  const point = await measureCaretPixel(cdp, 6); // "/btw hi": the h/i boundary, plain argument text
  if (!point) throw new Error('FAIL: Ctrl+A selection highlight (measureCaretPixel found no mirror text node at the h/i boundary, offset 6)');
  const { x, y } = point;
  const before = await capturePixelRegion(cdp, x, y, 0, 0);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, including the pill
  const after = await capturePixelRegion(cdp, x, y, 0, 0);
  await cdp.screenshot(path.join(shotsDir, '02b-selection-highlight.png'));
  const expectedRgb = await expectedSelectionPixelBytes(cdp, resolveCssVarColor);
  const differs = before.some((value, index) => Math.abs(value - after[index]) > 10);
  const matchesExpected = !!expectedRgb && expectedRgb.every((v, i) => Math.abs(v - after[i]) <= 10);
  report.push({ step: 'Ctrl+A: selection highlight paints a real background over plain argument text', ok: differs && matchesExpected, before, after, expectedRgb, x, y });
  if (!differs) throw new Error(`FAIL: Ctrl+A selection highlight (h/i boundary (${x},${y}) identical before/after: ${JSON.stringify(before)})`);
  if (!matchesExpected) throw new Error(`FAIL: Ctrl+A selection highlight (selected pixel ${JSON.stringify(after)} does not match the composited --composer-selection-bg ${JSON.stringify(expectedRgb)})`);
  console.log('verify-1050: PASS Ctrl+A: selection highlight paints a real background over plain argument text');
}

/** Gate round 5 fix (#1050, test review): the h/i-boundary sample above proves the BACKGROUND
 * paints a real fill during selection, but proves nothing about whether the GLYPHS themselves
 * stay visible on top of it -- the exact HIGH-severity risk this round's selection redesign
 * exists to address (a translucent `--composer-selection-bg` specifically so real ink shows
 * through even if `-webkit-text-fill-color: currentColor` is not honoured inside `::selection`
 * by every engine). Samples a WIDE region covering most of one glyph's own bounding box (not a
 * single pixel, and not a zero-width boundary) for a PLAIN-text character and a PILLED-token
 * character, counts "bright" pixels (RGB average > 140 -- comfortably between every theme's own
 * near-black backgrounds/composited selection fills, all measured <100, and its near-white/
 * bright text colours, all measured >200) before and after Ctrl+A, and asserts the selected
 * count is still close to the resting count (allowing a couple of pixels either way for edge
 * anti-aliasing blending differently against a different background colour) rather than merely
 * ">0", a stricter, false-positive-resistant bar. This is the one check that would have FAILED
 * against the pre-round-5 build if `-webkit-text-fill-color: currentColor` were silently
 * ignored inside `::selection` on an opaque `--composer-selection-bg`: the glyph would have
 * stayed fully masked, reading 0 bright pixels after Ctrl+A regardless of the resting count. */
export async function assertSelectedGlyphsInkVisible(cdp, pressKey, report) {
  async function glyphBrightPixelCount(charOffset) {
    const rect = await findMirrorOffsetRect(cdp, charOffset, charOffset + 1);
    if (!rect) return null;
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const halfWidth = Math.max(1, Math.round(rect.width / 3));
    const halfHeight = Math.max(1, Math.round(rect.height / 3));
    const pixels = await capturePixelRegion(cdp, cx, cy, halfWidth, halfHeight);
    let bright = 0;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 140) bright++;
    }
    return bright;
  }

  // The preceding highlight check leaves the whole draft selected; collapse it first so the
  // "resting" ink is genuinely unselected.
  await cdp.evaluate(`${TEXTAREA}.focus(); ${TEXTAREA}.setSelectionRange(0, 0)`);
  const collapsed = await cdp.evaluate(`${TEXTAREA}.selectionStart === ${TEXTAREA}.selectionEnd`);
  if (!collapsed) throw new Error('FAIL: selected-glyph ink visibility (selection did not collapse before sampling resting ink)');

  // "/btw hi": offset 1 is 'b' (inside the pilled token), offset 5 is 'h' (plain argument text).
  const restingPillInk = await glyphBrightPixelCount(1);
  const restingPlainInk = await glyphBrightPixelCount(5);
  if (restingPillInk === null || restingPlainInk === null) {
    throw new Error('FAIL: selected-glyph ink visibility (findMirrorOffsetRect found no mirror text node -- is a recognised token showing?)');
  }
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, including the pill
  const selectedPillInk = await glyphBrightPixelCount(1);
  const selectedPlainInk = await glyphBrightPixelCount(5);
  const pillOk = restingPillInk > 0 && selectedPillInk >= restingPillInk - 2;
  const plainOk = restingPlainInk > 0 && selectedPlainInk >= restingPlainInk - 2;
  report.push({
    step: 'Ctrl+A: selected glyph ink stays pixel-visible over both the pilled token and plain argument text',
    ok: pillOk && plainOk,
    restingPillInk,
    selectedPillInk,
    restingPlainInk,
    selectedPlainInk
  });
  if (!pillOk) throw new Error(`FAIL: selected-glyph ink visibility over the pilled token (resting ${restingPillInk} bright px, selected ${selectedPillInk} bright px)`);
  if (!plainOk) throw new Error(`FAIL: selected-glyph ink visibility over plain argument text (resting ${restingPlainInk} bright px, selected ${selectedPlainInk} bright px)`);
  console.log('verify-1050: PASS Ctrl+A: selected glyph ink stays pixel-visible over both the pilled token and plain argument text');
}

export function shotPath(shotsDir, name) {
  return path.join(shotsDir, name);
}

export function defaultShotsDir() {
  return path.join(tmpdir(), 'refract-1050-command-pill-shots');
}
