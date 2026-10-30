// Helpers for verify-1122-selected-style.mjs, split out to keep it under the 600-line cap.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';

// Exact compiled className of `ActiveIndicatorBar.tsx`: an exact match proves the shared component mounted, not a hand-copied span.
export const ACTIVE_INDICATOR_BAR_CLASS =
  'absolute inset-y-0 left-0 z-10 w-0.5 bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]';

/** Reads a selected site: computed `border-radius`, whether a child span is the exact shared bar, its colour/width,
 * whether it touches the row's top and bottom edges, and the fill colour. `rowFinder` must be the outer element
 * governed by the square-choice selector; `fillFinder` is for fills painted on a different element (e.g. `SessionRow.tsx`'s inner `<div>`). */
export async function readSelectedSite(cdp, rowFinder, fillFinder = rowFinder) {
  return cdp.evaluate(`(() => {
    const row = ${rowFinder};
    if (!row) return null;
    const rowRect = row.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    // The bar's \`position: absolute\` containing block is the row's own PADDING box (CSS
    // Positioned Layout), not its border box -- several rows carry an invisible \`border
    // border-transparent\` (Button's own base class, Settings nav's own native button), so
    // comparing against the raw \`getBoundingClientRect()\` border box would always read ~1px
    // short of "flush" even though the bar paints exactly where the box model says it should.
    const borderTop = parseFloat(rowStyle.borderTopWidth) || 0;
    const borderBottom = parseFloat(rowStyle.borderBottomWidth) || 0;
    const bar = Array.from(row.querySelectorAll('span[aria-hidden]')).find((s) => s.className === ${JSON.stringify(ACTIVE_INDICATOR_BAR_CLASS)});
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const fillEl = ${fillFinder};
    return {
      rowBorderRadius: rowStyle.borderRadius,
      barClassExactMatch: !!bar,
      barFlushTop: barRect ? Math.abs(barRect.top - (rowRect.top + borderTop)) < 1 : null,
      barFlushBottom: barRect ? Math.abs(barRect.bottom - (rowRect.bottom - borderBottom)) < 1 : null,
      barWidthPx: barRect ? barRect.width : null,
      barBackgroundColor: bar ? getComputedStyle(bar).backgroundColor : null,
      fillBackgroundColor: fillEl ? getComputedStyle(fillEl).backgroundColor : null
    };
  })()`);
}

/** #1119: a tree row's name span and leading glyph, by computed `color` (class names only prove intent).
 * The glyph is a direct `<svg>` child of the row (`:scope > svg`); the chevron wrapper is empty on file rows. */
export async function readExplorerRowTone(cdp, rowFinder) {
  return cdp.evaluate(`(() => {
    const row = ${rowFinder};
    if (!row) return null;
    const nameSpan = row.querySelector('span.truncate');
    const iconSvg = row.querySelector(':scope > svg');
    return {
      nameColor: nameSpan ? getComputedStyle(nameSpan).color : null,
      iconColor: iconSvg ? getComputedStyle(iconSvg).color : null
    };
  })()`);
}

/** Resolved colour for a token via the shared `resolveCssVarColor`, read off `document.documentElement`. */
export async function tokenColor(cdp, varName, property = 'color') {
  return resolveCssVarColor(cdp, varName, property);
}

/** Parameterised `forcedColorsRuleCompiled` from `verify-1043-theme-radio-helpers.mjs`. Reads the built
 * `out/tauri-web/assets/*.css` from disk (`document.styleSheets` scans 0 rules for a Tauri-served stylesheet) and confirms
 * `targetSelector` sits inside a `@media (forced-colors: ...)` block (brace-depth counted) with a body matching `declarationRe`. */
export function forcedColorsRuleCompiledFor(repoRoot, targetSelector, declarationRe) {
  const assetsDir = path.join(repoRoot, 'out', 'tauri-web', 'assets');
  let cssFiles;
  try {
    cssFiles = readdirSync(assetsDir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => ({ file: f, full: path.join(assetsDir, f), mtime: statSync(path.join(assetsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    return { error: `could not read ${assetsDir}: ${err.message}`, selectorFound: false, insideForcedColorsMedia: false, declarationMatches: false };
  }
  if (cssFiles.length === 0) {
    return { error: `no .css file found under ${assetsDir}`, selectorFound: false, insideForcedColorsMedia: false, declarationMatches: false };
  }
  const { file, full } = cssFiles[0];
  const raw = readFileSync(full, 'utf8');
  const normalized = raw.replace(/\\(.)/g, '$1');
  const selIdx = normalized.indexOf(targetSelector);
  if (selIdx === -1) {
    return { cssFile: file, selectorFound: false, insideForcedColorsMedia: false, declarationMatches: false };
  }
  const mediaIdx = normalized.lastIndexOf('@media', selIdx);
  const mediaHeader = mediaIdx === -1 ? '' : normalized.slice(mediaIdx, mediaIdx + 40);
  const between = mediaIdx === -1 ? '' : normalized.slice(mediaIdx, selIdx);
  const opens = (between.match(/\{/g) || []).length;
  const closes = (between.match(/\}/g) || []).length;
  const insideForcedColorsMedia = mediaIdx !== -1 && /forced-colors/i.test(mediaHeader) && opens - closes >= 1;
  const bodyStart = normalized.indexOf('{', selIdx);
  const bodyEnd = normalized.indexOf('}', bodyStart);
  const body = bodyStart !== -1 && bodyEnd !== -1 ? normalized.slice(bodyStart, bodyEnd) : '';
  const declarationMatches = declarationRe.test(body);
  return { cssFile: file, selectorFound: true, mediaHeader, insideForcedColorsMedia, body, declarationMatches };
}

/** Moves the pointer off the row and requires `!:hover`, because a resting hover paints the same token as the selected fill and
 * would mask it. Then waits for running transitions to finish before the caller measures. */
export async function movePointerOffAndSettle(cdp, finder, label) {
  const { width, height } = await cdp.evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
  for (const [x, y] of [[width - 20, 450], [Math.round(width / 2), height - 4]]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(50);
    const hovered = await cdp.evaluate(`(() => { const el = ${finder}; return !!el && el.matches(':hover'); })()`);
    if (!hovered) {
      await cdp.waitFor(`(() => { const el = ${finder}; return !!el && el.getAnimations().length === 0; })()`, {
        timeoutMs: 5_000,
        label: `${label}: transitions settled`
      });
      return;
    }
  }
  throw new Error(`${label}: the pointer still hovers the row after moving to two neutral points -- a hover fill would mask the selected fill.`);
}

// Collapsed header trigger of the open Session's group, tagged with a scratch-only `data-verify-1122-group` so it can be re-found after collapsing.
const GROUP_TRIGGER = `document.querySelector('[data-verify-1122-group]')`;

/** Collapses the open Session's group and reads its header trigger (#735 decision 22): square, exact shared bar, bar colour, no selected fill.
 * Re-expands afterwards because later checks click the Session row inside. */
export async function checkCollapsedGroupHeader(cdp, themeName, { barBg, screenshot }) {
  const tagged = await cdp.evaluate(`(() => {
    const trigger = Array.from(document.querySelectorAll('nav[aria-label="Sessions"] button[aria-expanded="true"][aria-controls]'))
      .find((b) => document.getElementById(b.getAttribute('aria-controls'))?.querySelector('li[data-choice-item]'));
    if (!trigger) return false;
    document.querySelectorAll('[data-verify-1122-group]').forEach((el) => el.removeAttribute('data-verify-1122-group'));
    trigger.setAttribute('data-verify-1122-group', '');
    return true;
  })()`);
  if (!tagged) throw new Error(`${themeName}: the open Session's group header trigger was not found.`);
  await cdp.click(GROUP_TRIGGER);
  await cdp.waitFor(`${GROUP_TRIGGER}?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: `${themeName}: group collapsed` });
  await movePointerOffAndSettle(cdp, GROUP_TRIGGER, `${themeName}: collapsed group header`);
  const read = await readSelectedSite(cdp, GROUP_TRIGGER);
  await screenshot();
  await cdp.click(GROUP_TRIGGER);
  await cdp.waitFor(`${GROUP_TRIGGER}?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: `${themeName}: group re-expanded` });
  await cdp.waitFor(`!!document.querySelector('nav[aria-label="Sessions"] li[data-choice-item]')`, { timeoutMs: 10_000, label: `${themeName}: Session row visible again` });
  return read;
}