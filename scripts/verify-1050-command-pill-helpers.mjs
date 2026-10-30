// Shared helpers for verify-1050-command-pill.mjs, split out to keep each file under the 600-line cap.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseComputedColorToEntry, resolvedLinear, srgbGammaEncode } from './contrast-math.mjs';

export const TEXTAREA = `document.querySelector('[aria-label="Message"]')`;
export const PILL = `document.querySelector('[data-command-pill-token]')`;
export const OVERLAY = `document.querySelector('[data-command-pill-overlay]')`;

// All five built-in theme presets (`src/shared/themes.ts`); the pill's accent/fill differ per preset.
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

/** The pill's rect against the real textarea's computed padding, not the inert mirror's box model. */
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

/** Proves "arguments stay plain": the overlay text equals the draft and exactly one element child (the pill span) exists. */
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

/** Client rect of `[startOffset, endOffset)` in the real mirror DOM; a canvas measurement drifts from real text layout (kerning, subpixel) and missed the caret column. The mirror must be mounted. */
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

/** Pixel position of a zero-width boundary at `charOffset`: the caret position and an ink-free sample point for the selection check. */
export async function measureCaretPixel(cdp, charOffset) {
  const rect = await findMirrorOffsetRect(cdp, charOffset, charOffset);
  if (!rect) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2) };
}

/** RGBA pixels of a small region from a real screenshot, decoded in-page via canvas (no Node PNG dependency); a region, because the caret is 1-2px wide and estimates land within a pixel or two of it. */
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

/** Pixel-proves the caret is visible at `charOffset`: two screenshots ~600ms apart (blink interval) must differ near it, since a permanently hidden caret reads the same in both; `caret-color` must also be non-transparent. */
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

/** Expected selection pixel: resolve the translucent `--composer-selection-bg` (oklch/oklab via `parseComputedColorToEntry`) and composite it over `--composer-background`, or `--background` when that is transparent (#927), with the shared `resolvedLinear` math; an opaque conversion gives the wrong pixel. */
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

/** Proves the selection background paints: samples the zero-width h/i boundary of "/btw hi" (plain text clear of the pill's 2px shadow bleed, which fooled the space-cell sample)
 * and asserts it matches the composited `--composer-selection-bg`. Glyph ink is no use here: anti-aliasing noise gave a false pass. Shots `02b-selection-highlight.png`. */
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

/** Proves glyphs stay visible under selection: counts bright pixels (avg > 140; backgrounds measure <100, text >200) in one plain and one pilled glyph before and after Ctrl+A,
 * which would read 0 if `-webkit-text-fill-color: currentColor` were ignored inside `::selection`. Allows a couple of pixels of anti-aliasing drift. */
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

  // Collapse the prior highlight check's selection so the resting ink is unselected.
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
