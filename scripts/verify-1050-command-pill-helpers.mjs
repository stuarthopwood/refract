// Shared helpers for verify-1050-command-pill.mjs (gate round 1 HIGH remediation, file-size
// split: the main script grew past its own 600-line cap once the caret-visibility, selection-
// highlight, slash-menu-completion and wrapping-token checks were added on top of the original
// pill/spellcheck/geometry/theme checks).
import { tmpdir } from 'node:os';
import path from 'node:path';

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

/** The caret's own real pixel position at `charOffset` (a zero-width point, `startOffset ===
 * endOffset`). See `findMirrorOffsetRect` above for the full reasoning. */
async function measureCaretPixel(cdp, charOffset) {
  const rect = await findMirrorOffsetRect(cdp, charOffset, charOffset);
  if (!rect) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2) };
}

/** Gate round 3 HIGH fix: the CENTRE of a single glyph-free character cell (`charOffset` to
 * `charOffset + 1`) -- unlike the caret's zero-width point above, this spans a whole character's
 * own rendered box, so a selection-highlight sample here is immune to the glyph-ink/anti-
 * aliasing noise a pixel landing ON a letter's stroke would introduce. The caller picks a
 * genuinely blank character (a space) so there is no ink to confuse with the highlight itself. */
export async function measureCellCenter(cdp, charOffset) {
  const rect = await findMirrorOffsetRect(cdp, charOffset, charOffset + 1);
  if (!rect) return null;
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
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

/** Parses a `getComputedStyle()`/`resolveCssVarColor` `rgb()`/`rgba()` string into its `[r, g,
 * b]` triplet, for comparing against raw `getImageData` bytes. */
function parseRgbTriplet(rgbStr) {
  const m = typeof rgbStr === 'string' && rgbStr.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(',').map((n) => parseFloat(n)).slice(0, 3);
}

/** Gate round 3 HIGH fix: round 1's version sampled the PILL's own measured centre -- real ink
 * (the mirror's own coloured glyphs), so a "differs" reading there is confounded by ordinary
 * glyph-rendering/anti-aliasing noise and proves nothing specific about a selection background
 * actually painting (confirmed live: it read `differs: true` even with `::selection` having NO
 * authored `background-color` at all, i.e. a false pass). Fixed by sampling the CENTRE of a
 * genuinely glyph-free cell instead -- the space between `/btw` and `hi` (char offset 4) -- a
 * single real pixel there, unselected then selected, and asserting the selected reading matches
 * the LIVE-resolved `--composer-selection-bg`, not merely "differs by some threshold" (a
 * specific, false-positive-resistant assertion). Takes a resting (unselected) shot first,
 * matching `02-pill-btw.png` taken by the caller just before this runs, then its own
 * post-selection shot (`02b-selection-highlight.png`) as separate visual evidence. */
export async function assertSelectionHighlightVisible(cdp, pressKey, resolveCssVarColor, report, shotsDir) {
  const cell = await measureCellCenter(cdp, 4); // "/btw hi": the space right after the pilled token
  if (!cell) throw new Error('FAIL: Ctrl+A selection highlight (measureCellCenter found no mirror text node at the glyph-free space, offset 4)');
  const { x, y } = cell;
  const before = await capturePixelRegion(cdp, x, y, 0, 0);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, including the pill
  const after = await capturePixelRegion(cdp, x, y, 0, 0);
  await cdp.screenshot(path.join(shotsDir, '02b-selection-highlight.png'));
  const expectedBgRaw = await resolveCssVarColor(cdp, '--composer-selection-bg', 'background-color');
  const expectedRgb = parseRgbTriplet(expectedBgRaw);
  const differs = before.some((value, index) => Math.abs(value - after[index]) > 10);
  const matchesExpected = !!expectedRgb && expectedRgb.every((v, i) => Math.abs(v - after[i]) <= 10);
  report.push({ step: 'Ctrl+A: selection highlight paints a real background at a glyph-free cell', ok: differs && matchesExpected, before, after, expectedBgRaw, x, y });
  if (!differs) throw new Error(`FAIL: Ctrl+A selection highlight (glyph-free cell (${x},${y}) identical before/after: ${JSON.stringify(before)})`);
  if (!matchesExpected) throw new Error(`FAIL: Ctrl+A selection highlight (selected pixel ${JSON.stringify(after)} does not match resolved --composer-selection-bg ${expectedBgRaw})`);
  console.log('verify-1050: PASS Ctrl+A: selection highlight paints a real background at a glyph-free cell');
}

export function shotPath(shotsDir, name) {
  return path.join(shotsDir, name);
}

export function defaultShotsDir() {
  return path.join(tmpdir(), 'refract-1050-command-pill-shots');
}
