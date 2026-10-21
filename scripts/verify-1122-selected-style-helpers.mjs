// Helper functions for verify-1122-selected-style.mjs, split out solely to keep that script
// under the repo's 600-line soft cap (scripts/check-file-size.mjs) -- the same pattern
// verify-tauri-560-helpers.mjs/verify-1074-text-opacity-helpers.mjs already use. No behaviour of
// its own beyond the assertions/reads issue #1122/#1119's live check needs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';

// The EXACT compiled className `src/renderer/components/ActiveIndicatorBar.tsx` renders --
// asserting a rendered bar's className equals this literal string (not a loose substring match)
// proves the shared component mounted, not a hand-copied span that merely happens to share one
// or two of the same utility classes (the five-plus pre-#1122 copies: some `inset-y-1
// rounded-full`, one missing the forced-colours fallback entirely).
export const ACTIVE_INDICATOR_BAR_CLASS =
  'absolute inset-y-0 left-0 z-10 w-0.5 bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]';

/** Reads a site's own selected row/button: real computed `border-radius` (square-corner proof),
 * whether a child span's className is the exact shared bar, that child's own real computed
 * `background-color`/`width`/vertical inset (flush-full-height proof -- `inset-y-0` alone is a
 * class name; this confirms the rendered box actually touches the row's own top and bottom
 * edges, not merely carries the class), the bar's own real `background-color`, and the real
 * fill `background-color` -- read off `fillFinder` when the fill paints on a DIFFERENT element
 * than the one the square-choice selector governs (e.g. `SessionRow.tsx`: `data-choice-item`
 * sits on the outer `<li>`, but `bg-sidebar-accent` paints on its inner content `<div>`;
 * defaults to `rowFinder` everywhere the fill and the shape share one element). `rowFinder` must
 * evaluate to the OUTER element whose `border-radius` is the one the square-choice selector
 * governs. */
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

/** Issue #1119: a tree row's name span and its leading folder/file glyph, real computed `color`
 * (never the raw `className` string -- Tailwind's arbitrary/token classes only PROVE intent,
 * the computed value proves the browser actually painted it). Gate round 1 fix (two reviewers):
 * the chevron WRAPPER span (\`span[aria-hidden].flex\`) is empty on a FILE row (the chevron only
 * renders for folders, \`TreeNodeRow\`'s own JSX) -- reading its own computed colour measured the
 * wrapper's class, never the actual glyph a user sees. The folder/file icon itself
 * (\`FolderIcon\`/\`FileIcon\`/etc.) is a direct \`<svg>\` CHILD of the row, a sibling of that
 * wrapper, never nested inside it -- \`:scope > svg\` selects it directly. */
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

/** Real resolved colour for a token, via the shared `resolveCssVarColor` (reads the token off
 * `document.documentElement`, the same cascade point every component inherits from). */
export async function tokenColor(cdp, varName, property = 'color') {
  return resolveCssVarColor(cdp, varName, property);
}

/** Generalised, parameterised version of `verify-1043-theme-radio-helpers.mjs`'s own
 * `forcedColorsRuleCompiled` (that copy is hardcoded to ONE selector) -- reads the real built
 * `out/tauri-web/assets/*.css` straight off disk (never `document.styleSheets` over CDP, which
 * scans 0 rules for a Tauri-served stylesheet, a WebView2/CSSOM cross-origin-style restriction
 * unrelated to whether the CSS genuinely works, per that module's own comment) and confirms
 * `targetSelector` exists, sits inside a real `@media (forced-colors: ...)` block (brace-depth
 * counted from the nearest preceding `@media`), and its own declaration body matches
 * `declarationRe`. */
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
