// Constants and DOM helpers for verify-1043-theme-radio.mjs, split out for the #806 file-size cap.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import { pressKey, pressEscape, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

// The 5 built-in presets in `src/shared/themes.ts` order; each is exercised as the current preset in turn.
export const THEMES_1043 = [
  { id: 'dark', name: 'Dark', swatch: '#0a0a0a', swatchPrimary: '#e5e5e5' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', swatch: '#000000', swatchPrimary: '#ffffff' },
  { id: 'obsidian', name: 'Obsidian', swatch: '#0F1014', swatchPrimary: '#5A5EEE' },
  { id: 'nordic-frost', name: 'Nordic Frost', swatch: '#060f1e', swatchPrimary: '#007a7c' },
  { id: 'cyber-amber', name: 'Cyber Amber', swatch: '#0a0a0a', swatchPrimary: '#c2410c' }
];

// Literal hex values from `src/shared/themes.ts`; Chromium normalises computed `background-image` to `rgb(r, g, b)`, so they are converted before comparing.
export function hexToRgbTuple(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// Hand-maintained copy of `modelDisplay.ts`'s `THINKING_LEVELS`/`THINKING_LEVEL_LABEL` (a .mjs script cannot import .ts).
export const THINKING_LEVELS_1043 = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_LEVEL_LABEL_1043 = {
  inherit: 'Default',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
};

export async function pressArrow(cdp, direction) {
  const map = { Down: [40, 'ArrowDown'], Up: [38, 'ArrowUp'], Left: [37, 'ArrowLeft'], Right: [39, 'ArrowRight'] };
  const [code, key] = map[direction];
  await pressKey(cdp, code, key, key);
}

export async function pressEnterKey(cdp) {
  await pressKey(cdp, 13, 'Enter', 'Enter');
}

/** Opens the Theme submenu by pointer without selecting, so every preset's radio state can be read first. */
export async function openThemeSubmenu(cdp) {
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Every menu closed before opening Theme submenu' });
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Theme'))`,
    { timeoutMs: 10_000, label: 'Profile dropdown menu open (containing Theme)' }
  );
  const themeTriggerFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Theme'))`;
  await cdp.waitFor(`!!(${themeTriggerFinder})`, { timeoutMs: 10_000, label: 'Theme submenu trigger visible' });
  const rect = await cdp.evaluate(`(() => { const el = ${themeTriggerFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(400);
  await cdp.click(themeTriggerFinder);
  await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= 5`, { timeoutMs: 10_000, label: 'Theme submenu open with 5 radio rows' });
}

export async function closeAllMenus(cdp) {
  await pressEscape(cdp);
  await sleep(150);
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'All menus closed' });
  // The menu element unmounting does not mean Radix's close transition/focus-return has settled; an immediate
  // reopen raced it live (the next Theme trigger click found nothing), so settle briefly (#1043).
  await sleep(400);
}

/** Reads every `[role="menuitemradio"]` row (Theme submenu and Reasoning picker). `hasDot` is whether the ItemIndicator
 * mounted `RADIO_DOT_CLASS` (Radix mounts it only while checked), a structural proof rather than trusting `aria-checked`. */
export const READ_RADIO_ROWS_EXPR = `
  Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((row) => {
    const ring = row.children[0] || null;
    const nameSpan = row.children[1] || null;
    const swatch = row.children[2] || null;
    return {
      label: (nameSpan ? nameSpan.textContent : row.textContent).trim(),
      ariaChecked: row.getAttribute('aria-checked'),
      ringClass: ring ? ring.className : null,
      hasDot: !!(ring && ring.querySelector('span')),
      childCount: row.children.length,
      swatchClass: swatch ? swatch.className : null,
      swatchBackgroundImage: swatch ? getComputedStyle(swatch).backgroundImage : null
    };
  })
`;

export async function readRadioRows(cdp) {
  return cdp.evaluate(READ_RADIO_ROWS_EXPR);
}

/** The Reasoning picker trigger: its `aria-label` either ends with ", reasoning" or starts with "Reasoning" (the two unset-level labels). */
export const REASONING_TRIGGER_FINDER = `Array.from(document.querySelectorAll('button')).find((b) => { const al = b.getAttribute('aria-label') || ''; return al.endsWith(', reasoning') || /^reasoning\\b/i.test(al); })`;

export async function openReasoningPicker(cdp) {
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Every menu closed before opening the Reasoning picker' });
  await cdp.click(REASONING_TRIGGER_FINDER);
  await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= ${THINKING_LEVELS_1043.length}`, {
    timeoutMs: 10_000,
    label: 'Reasoning picker open with every level listed'
  });
  // Let the open transition finish so a screenshot never catches the popover mid-fade.
  await sleep(300);
}

/** Navigates an open radio group by keyboard from the current focus to `targetLabel`, then presses Enter.
 * Radix does not reliably refocus the checked item on reopen (only `ThemeSubmenu` has bespoke logic), so this reads
 * focus from the AX tree and computes the arrow-press count; seeding `registry.json` instead raced the session-settle resync.
 * `labels` is the group's rows in on-screen order. */
export async function navigateRadioGroupByKeyboardTo(cdp, labels, targetLabel) {
  // Open-auto-focus lands on a row for the Theme submenu but stays on the Reasoning trigger (double-wrapped
  // `TooltipTrigger`/`DropdownMenuTrigger`) indefinitely, so focus a known row to make the start deterministic.
  const landedOnRow = await cdp.evaluate(`document.activeElement?.getAttribute('role') === 'menuitemradio'`).catch(() => false);
  if (!landedOnRow) {
    await cdp.evaluate(`
      (() => {
        const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
        const target = rows.find((r) => r.getAttribute('aria-checked') === 'true') || rows[0];
        target?.focus();
      })()
    `);
    await sleep(100);
  }
  const focused = await getActiveElementAccessibleName(cdp);
  const fromIdx = labels.indexOf(focused.name);
  const toIdx = labels.indexOf(targetLabel);
  if (fromIdx === -1 || toIdx === -1) {
    throw new Error(`navigateRadioGroupByKeyboardTo: could not locate "${focused.name}" -> "${targetLabel}" in ${JSON.stringify(labels)}`);
  }
  const steps = toIdx - fromIdx;
  const direction = steps > 0 ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(steps); i++) {
    await pressArrow(cdp, direction);
    await sleep(100);
  }
  await pressEnterKey(cdp);
}

/** Reads the active radio ring's `className` so the forced-colors claim is structurally grounded; OS forced-colors
 * rendering is not drivable over this CDP endpoint, so (as in `verify-tauri-567.mjs`) this falls back to a static check. */
export async function ringCarriesForcedColorsOverride(cdp) {
  return cdp.evaluate(`
    (() => {
      const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
      const checked = rows.find((r) => r.getAttribute('aria-checked') === 'true');
      const unchecked = rows.find((r) => r.getAttribute('aria-checked') !== 'true');
      const checkedRing = checked ? checked.children[0] : null;
      const uncheckedRing = unchecked ? unchecked.children[0] : null;
      const cls = (el) => (el ? el.className : null);
      return {
        checkedRingClass: cls(checkedRing),
        uncheckedRingClass: cls(uncheckedRing),
        checkedHasOverride: !!(checkedRing && checkedRing.className.includes("forced-colors:group-data-[state=checked]/radio-item:border-[Highlight]")),
        uncheckedHasOverride: !!(uncheckedRing && uncheckedRing.className.includes("forced-colors:group-data-[state=checked]/radio-item:border-[Highlight]"))
      };
    })()
  `);
}

/** Stronger than `ringCarriesForcedColorsOverride`: a class string in `className` stays true even if Tailwind never compiled the rule.
 * `document.styleSheets` is unusable here (`sheet.cssRules` throws for Tauri-served sheets), so this reads the built
 * `out/tauri-web/assets/*.css` from disk, newest match first so a stale file is never used. It fuzzy-matches
 * `group-data-[state=checked]/radio-item` and `border-[Highlight]` rather than Tailwind's version-dependent selector syntax,
 * then counts brace depth to confirm the rule is nested in a forced-colors media block and sets `border-color: highlight`. */
export function forcedColorsRuleCompiled(repoRoot) {
  const assetsDir = path.join(repoRoot, 'out', 'tauri-web', 'assets');
  let cssFiles;
  try {
    cssFiles = readdirSync(assetsDir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => ({ file: f, full: path.join(assetsDir, f), mtime: statSync(path.join(assetsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    return { error: `could not read ${assetsDir}: ${err.message}`, selectorFound: false, insideForcedColorsMedia: false, declaresHighlightBorder: false };
  }
  if (cssFiles.length === 0) {
    return { error: `no .css file found under ${assetsDir}`, selectorFound: false, insideForcedColorsMedia: false, declaresHighlightBorder: false };
  }
  const targetSelector = '.forced-colors:group-data-[state=checked]/radio-item:border-[Highlight]';
  // Vite may split the CSS output, so scan every file and use the one that holds the rule.
  const scanned = cssFiles.map(({ file, full }) => ({ file, normalized: readFileSync(full, 'utf8').replace(/\\(.)/g, '$1') }));
  const { file, normalized } = scanned.find((entry) => entry.normalized.includes(targetSelector)) ?? scanned[0];
  const selIdx = normalized.indexOf(targetSelector);
  if (selIdx === -1) {
    return { cssFile: file, totalChars: normalized.length, selectorFound: false, insideForcedColorsMedia: false, declaresHighlightBorder: false };
  }
  // Walk back from the match collecting the headers of every block that ENCLOSES it (a closed
  // sibling `@media` before the match must not count, and an unrelated nested one must not hide
  // the real forced-colors parent).
  const enclosingHeaders = [];
  for (let i = selIdx - 1, depth = 0; i >= 0; i--) {
    const ch = normalized[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        const headerStart = Math.max(normalized.lastIndexOf('}', i - 1), normalized.lastIndexOf('{', i - 1), normalized.lastIndexOf(';', i - 1)) + 1;
        enclosingHeaders.push(normalized.slice(headerStart, i).trim());
      } else depth--;
    }
  }
  const mediaHeader = enclosingHeaders.find((h) => /^@media[^{]*forced-colors/i.test(h)) ?? enclosingHeaders.find((h) => h.startsWith('@media')) ?? '';
  const insideForcedColorsMedia = /^@media[^{]*forced-colors/i.test(mediaHeader);
  const bodyStart = normalized.indexOf('{', selIdx);
  const bodyEnd = normalized.indexOf('}', bodyStart);
  const body = bodyStart !== -1 && bodyEnd !== -1 ? normalized.slice(bodyStart, bodyEnd) : '';
  const declaresHighlightBorder = /border(-color)?:\s*highlight/i.test(body);
  return { cssFile: file, selectorFound: true, mediaHeader, insideForcedColorsMedia, body, declaresHighlightBorder };
}

/** Reads the checked row's dot computed style/rect/colour and its contrast against the popover: a dot nested inside
 * `ItemIndicator` stayed `display: inline` and painted 0x0 despite being mounted, so DOM presence alone is not enough. */
export async function readDotRenderState(cdp) {
  return cdp.evaluate(`
    (() => {
      const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
      const checkedRow = rows.find((r) => r.getAttribute('aria-checked') === 'true');
      const uncheckedRow = rows.find((r) => r.getAttribute('aria-checked') !== 'true');
      function describe(row) {
        if (!row) return null;
        const ring = row.children[0];
        const dot = ring ? ring.querySelector('span') : null;
        const ringCs = ring ? getComputedStyle(ring) : null;
        if (!dot) return { present: false, ringBackgroundColor: ringCs ? ringCs.backgroundColor : null };
        const rect = dot.getBoundingClientRect();
        const cs = getComputedStyle(dot);
        return {
          present: true,
          width: rect.width,
          height: rect.height,
          display: cs.display,
          opacity: cs.opacity,
          backgroundColor: cs.backgroundColor
        };
      }
      const popoverEl = document.querySelector('[role="menu"][data-state="open"]') || document.body;
      return {
        checked: describe(checkedRow),
        unchecked: describe(uncheckedRow),
        popoverBackground: getComputedStyle(popoverEl).backgroundColor
      };
    })()
  `);
}

/** True only when the checked dot paints: rect over 2px (a 0x0 box fails), not `display:none`/transparent, and 3:1 WCAG 1.4.11 contrast against the popover. */
export function dotIsVisuallyVisible(dotState) {
  const d = dotState?.checked;
  if (!d || !d.present) return { visible: false, ratio: null, reason: 'not mounted' };
  if (d.width <= 2 || d.height <= 2) return { visible: false, ratio: null, reason: `collapsed rect ${d.width}x${d.height}` };
  if (d.display === 'none') return { visible: false, ratio: null, reason: 'display:none' };
  if (parseFloat(d.opacity) < 0.5) return { visible: false, ratio: null, reason: `opacity ${d.opacity}` };
  const ratio = measuredContrastRatio(d.backgroundColor, dotState.popoverBackground);
  if (ratio === null) return { visible: false, ratio: null, reason: `unparseable colour ${d.backgroundColor}` };
  return { visible: ratio >= 3, ratio, reason: ratio >= 3 ? null : `only ${ratio.toFixed(2)}:1 against popover` };
}

/** The landscape swatch chip (`ProfileMenu.tsx`) is one CSS `linear-gradient`; its computed `background-image` must contain both of the theme's `swatch`/`swatchPrimary` values. */
export async function readSwatchGradient(cdp, themeName) {
  return cdp.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim() === ${JSON.stringify(themeName)});
      const chip = row ? row.children[2] : null;
      if (!chip) return { present: false };
      return { present: true, backgroundImage: getComputedStyle(chip).backgroundImage };
    })()
  `);
}
