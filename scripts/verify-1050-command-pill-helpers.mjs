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

/** Measures the real pixel position of the caret at `charOffset` on the FIRST line only (no
 * newline before it) -- an in-page `<canvas>` with the textarea's own computed font measures the
 * exact glyph-prefix width, so this is never a guessed column-to-pixel ratio. */
async function measureCaretPixel(cdp, charOffset) {
  return cdp.evaluate(`(() => {
    const ta = ${TEXTAREA};
    const style = getComputedStyle(ta);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = \`\${style.fontStyle} \${style.fontWeight} \${style.fontSize} \${style.fontFamily}\`;
    const prefix = ta.value.slice(0, ${charOffset});
    const width = ctx.measureText(prefix).width;
    const rect = ta.getBoundingClientRect();
    return {
      x: Math.round(rect.left + parseFloat(style.paddingLeft) + width),
      y: Math.round(rect.top + parseFloat(style.paddingTop) + parseFloat(style.fontSize) * 0.6)
    };
  })()`);
}

/** Reads back one pixel's RGBA from a REAL `Page.captureScreenshot` -- decoded entirely inside
 * the page via an offscreen `<canvas>` (`drawImage` + `getImageData`), so no Node-side PNG
 * decoder dependency is needed. */
async function capturePixel(cdp, x, y) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(${x}, ${y}, 1, 1).data;
      resolve([d[0], d[1], d[2], d[3]]);
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,${data}';
  })`);
}

/** Gate round 1 HIGH remediation (item 5): pixel-proof the native caret is actually visible at
 * `charOffset`, blink-safe -- two REAL screenshots ~600ms apart (Chromium/Windows' own caret-
 * blink interval), decoded to one pixel each at the caret's own measured position. A
 * permanently-hidden caret (the original bug: an opaque pill painted over it) reads the SAME
 * pixel in both samples regardless of timing; a genuinely blinking, visible caret reads
 * differently in at least one of the two (on vs off), which is what this asserts. */
export async function assertCaretVisible(cdp, sleep, charOffset, label, report) {
  await cdp.evaluate(`${TEXTAREA}.focus(); ${TEXTAREA}.setSelectionRange(${charOffset}, ${charOffset})`);
  const { x, y } = await measureCaretPixel(cdp, charOffset);
  const sample1 = await capturePixel(cdp, x, y);
  await sleep(600);
  const sample2 = await capturePixel(cdp, x, y);
  const differs = sample1.some((value, index) => Math.abs(value - sample2[index]) > 10);
  report.push({ step: label, ok: differs, sample1, sample2, x, y });
  if (!differs) throw new Error(`FAIL: ${label} (caret pixel identical at both 600ms-apart samples: ${JSON.stringify(sample1)})`);
  console.log(`verify-1050: PASS ${label}`);
}

/** Gate round 1 HIGH remediation (item 5): proves Ctrl+A's native selection highlight actually
 * paints over the pilled token -- captures the SAME pixel (the pill's own measured centre)
 * unselected, then selected, and asserts the two differ (a real highlight tint was applied,
 * not merely an invisible selection the transparent text would otherwise hide entirely). */
export async function assertSelectionHighlightVisible(cdp, pressKey, report) {
  const geom = await measurePillGeometry(cdp);
  const x = Math.round(geom.pillLeft + geom.pillWidth / 2);
  const y = Math.round(geom.pillTop + geom.pillHeight / 2);
  const before = await capturePixel(cdp, x, y);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select the whole draft, including the pill
  const after = await capturePixel(cdp, x, y);
  const differs = before.some((value, index) => Math.abs(value - after[index]) > 10);
  report.push({ step: 'Ctrl+A: selection highlight visibly paints over the pilled token', ok: differs, before, after, x, y });
  if (!differs) throw new Error(`FAIL: Ctrl+A selection highlight pixel identical before/after (${JSON.stringify(before)})`);
  console.log('verify-1050: PASS Ctrl+A: selection highlight visibly paints over the pilled token');
}

export function shotPath(shotsDir, name) {
  return path.join(shotsDir, name);
}

export function defaultShotsDir() {
  return path.join(tmpdir(), 'refract-1050-command-pill-shots');
}
