// Shared constants and DOM-driving/reading helpers for verify-1043-theme-radio.mjs, split out
// (#806 file-size cap) the same way verify-741-role-chip.mjs/verify-569 etc. split their own
// bulk check bodies into a companion `-helpers.mjs` file.
import { sleep } from './verify-tauri-cdp.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import { pressKey, pressEscape, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

// The 5 built-in presets (`src/shared/themes.ts`'s own declaration order) -- every one the
// Theme submenu lists, each exercised as the "current" preset in turn.
export const THEMES_1043 = [
  { id: 'dark', name: 'Dark', swatch: '#0a0a0a', swatchPrimary: '#e5e5e5' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', swatch: '#000000', swatchPrimary: '#ffffff' },
  { id: 'obsidian', name: 'Obsidian', swatch: '#0F1014', swatchPrimary: '#5A5EEE' },
  { id: 'nordic-frost', name: 'Nordic Frost', swatch: '#060f1e', swatchPrimary: '#007a7c' },
  { id: 'cyber-amber', name: 'Cyber Amber', swatch: '#0f0703', swatchPrimary: '#c14100' }
];

// `src/shared/themes.ts`'s own literal hex values -- this live-check compares against the
// REAL computed `background-image` (which Chromium normalises to `rgb(r, g, b)` regardless of
// how the author wrote it), so the hex here must convert to that exact format to compare.
export function hexToRgbTuple(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// A second hand-maintained copy of `src/renderer/lib/modelDisplay.ts`'s own `THINKING_LEVELS`/
// `THINKING_LEVEL_LABEL` (a .mjs script cannot import a .ts module here) -- same convention
// `verify-741-role-chip.mjs`'s own header comment already documents for this exact situation.
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

/** Pointer-driven open of the Theme submenu WITHOUT selecting anything -- a read-only inspect
 * pass (mirrors `verify-tauri-scratch-helpers.mjs`'s own `switchTheme` open sequence, minus the
 * final item click), so every preset's radio state can be read before any selection happens. */
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
  // #1043 fix: this script reopens/recloses the SAME profile menu far more densely than any
  // existing caller of `switchTheme` (5x open+inspect+close per theme, then more for keyboard
  // nav) -- `document.querySelector('[role="menu"]')` going away proves the ELEMENT unmounted,
  // not that Radix's own closing transition/focus-return has genuinely finished settling, and a
  // reopen fired immediately after could otherwise race it (a live failure this script actually
  // hit: the very next `switchTheme` call's own click on the Theme trigger found nothing,
  // despite an immediately-prior `waitFor` confirming the trigger existed). A short settle
  // closes that gap.
  await sleep(400);
}

/** Reads every `[role="menuitemradio"]` row currently in the DOM (used for BOTH the Theme
 * submenu -- 3 Element children per row, ring/name/swatch -- and the Reasoning picker -- 1
 * Element child, the ring, label is a bare text node read via `textContent`). `ring` is the
 * leading `RADIO_RING_CLASS` span (`dropdown-menu.tsx`); `hasDot` is whether its own
 * `DropdownMenuPrimitive.ItemIndicator` actually mounted the `RADIO_DOT_CLASS` child (Radix only
 * mounts it while checked) -- the real, structural "is the dot visible" proof, not merely
 * trusting `aria-checked`. */
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

/** The Reasoning picker's own trigger (`ComposerPickers.tsx`): its `aria-label` either ENDS with
 * ", reasoning" (the common case) or itself STARTS with "Reasoning" (the two unset-level
 * labels) -- same two-branch rule that file's own comment documents. */
export const REASONING_TRIGGER_FINDER = `Array.from(document.querySelectorAll('button')).find((b) => { const al = b.getAttribute('aria-label') || ''; return al.endsWith(', reasoning') || /^reasoning\\b/i.test(al); })`;

export async function openReasoningPicker(cdp) {
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Every menu closed before opening the Reasoning picker' });
  await cdp.click(REASONING_TRIGGER_FINDER);
  await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= ${THINKING_LEVELS_1043.length}`, {
    timeoutMs: 10_000,
    label: 'Reasoning picker open with every level listed'
  });
}

/** Navigates an already-open `[role="menuitemradio"]` group by keyboard from WHEREVER focus
 * currently sits to the row labelled `targetLabel`, then presses Enter to select it. Radix does
 * NOT reliably refocus the CHECKED item on a plain menu reopen -- only `ProfileMenu.tsx`'s
 * `ThemeSubmenu` has its own bespoke `activeItemRef`/`requestAnimationFrame` logic for that,
 * which `ComposerPickers.tsx`'s Reasoning picker does not duplicate -- so this reads the real
 * current focus via the AX tree and computes the exact arrow-press count, rather than assuming
 * a fixed starting row (a fixed assumption is what made an earlier cut of this script seed
 * `registry.json` directly instead; dropped once that seed turned out to race the real
 * session-settle resync that persists `lastThinkingLevel` back onto the Session row -- a real
 * pointer/keyboard selection through the actual UI has no such race). `labels` is the group's
 * rows in on-screen order. */
export async function navigateRadioGroupByKeyboardTo(cdp, labels, targetLabel) {
  // Radix's own open-auto-focus reliably lands on a real menu row for the Theme submenu's plain
  // `DropdownMenuSubTrigger` (confirmed live), but NOT for the Reasoning picker's trigger -- a
  // `<button>` doubly wrapped in `TooltipTrigger asChild` + `DropdownMenuTrigger asChild`
  // (`ComposerPickers.tsx`), where focus was confirmed live to stay on the trigger itself after
  // open, indefinitely (not merely a slow settle -- waiting longer never changed it). Rather
  // than depend on a Radix open-auto-focus quirk this issue's own scope does not touch, this
  // explicitly focuses a known row (the checked one if any, else the first) as the navigation's
  // deterministic starting point when open-auto-focus did not land on one -- the keyboard PATH
  // under test (arrow keys + Enter, the real selection) is unaffected; only the starting point
  // is made deterministic.
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

/** Focuses the active radio row's own leading ring, reads its computed `border-color`
 * (`group-data-[state=checked]/radio-item:border-primary` only applies while checked) so the
 * forced-colors claim is at least STRUCTURALLY grounded (the `forced-colors:` utility class
 * really is on the element the browser would repaint) -- matches `verify-tauri-567.mjs`'s own
 * established fallback for a WebView2 CDP forced-colors limitation: "falls back to a static
 * check that the fix's own CSS rule exists" (full OS forced-colors MEDIA rendering is not
 * drivable over this harness's CDP endpoint at all, per that file's header comment). */
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

/** Stronger than `ringCarriesForcedColorsOverride` above (MEDIUM fix, #1043): that check only
 * confirms the `forced-colors:...` utility class string is literally present in the rendered
 * element's `className` attribute -- which would stay true even if Tailwind's JIT silently
 * failed to compile a matching CSS rule for this exact (group-variant inside a media-variant,
 * inside a `/radio-item`-named group) combination, since JSX never removes an unmatched class
 * name from the DOM. This instead walks the REAL compiled stylesheets (`document.styleSheets`,
 * recursing into every `CSSMediaRule`'s own nested `cssRules`), finds every rule sitting inside
 * an `@media (forced-colors: ...)` block, and fuzzy-matches each rule's `selectorText` (with
 * backslash escapes stripped, since Tailwind escapes `:`/`[`/`]`/`/` in a literal class-name
 * selector) against the ring's own two defining substrings -- `group-data-[state=checked]/
 * radio-item` (the group-variant key) and `border-[Highlight]` (the arbitrary value) -- rather
 * than reconstructing Tailwind's exact compiled selector syntax by hand (which differs across
 * versions and which group/media-variant nesting order it picks), so this does not depend on
 * guessing that syntax correctly. Confirms the matching rule's own declaration actually sets
 * `border-color: Highlight` (or a shorthand `border: ... Highlight`), not just that a rule with
 * a matching selector exists with some unrelated declaration. */
export async function forcedColorsRuleCompiled(cdp) {
  return cdp.evaluate(`
    (() => {
      function collectLeafRules(rule, acc) {
        if (rule.cssRules) {
          for (const child of Array.from(rule.cssRules)) collectLeafRules(child, acc);
        } else {
          acc.push(rule);
        }
      }
      const forcedColorsRules = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of Array.from(rules || [])) {
          const isForcedColorsMedia = typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule &&
            /forced-colors/i.test(rule.conditionText || rule.media?.mediaText || '');
          if (isForcedColorsMedia) collectLeafRules(rule, forcedColorsRules);
        }
      }
      const stripEscapes = (s) => (s || '').replace(/\\\\/g, '');
      const matching = forcedColorsRules.filter((r) => {
        const sel = stripEscapes(r.selectorText);
        return sel.includes('group-data-[state=checked]/radio-item') && sel.includes('border-[Highlight]');
      });
      const declaresHighlightBorder = matching.some((r) => /border(-color)?:\\s*[^;]*Highlight/i.test(r.style?.cssText || r.cssText || ''));
      return {
        totalForcedColorsRulesScanned: forcedColorsRules.length,
        matchingSelectorCount: matching.length,
        matchingSelectors: matching.map((r) => r.selectorText),
        declaresHighlightBorder
      };
    })()
  `);
}

/** Gate finding (Main, live pixel sample, 2026-10-20): the dot used to mount structurally
 * (`readRadioRows`'s own `hasDot` check passed) while painting at 0x0 -- a `<span>` nested one
 * level inside `DropdownMenuPrimitive.ItemIndicator` stayed `display: inline` (never
 * "blockified" the way a DIRECT CSS Grid item is), so its own `size-2` width/height never
 * applied (CSS2.1 10.3.1/10.6.1: width/height do not apply to a non-replaced inline box) --
 * invisible despite being mounted. Fixed in `dropdown-menu.tsx` by putting `RADIO_DOT_CLASS`
 * directly on `ItemIndicator` itself. This reads the REAL computed style/rect/colour of the
 * checked row's dot (never trusting mere DOM presence again) and the real contrast of its
 * `background-color` against the open menu's own popover background, so a mounted-but-invisible
 * dot fails here even if every structural check above still passes. */
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

/** `true` only when the checked row's dot genuinely PAINTS: a real rect (>2px either side, so a
 * collapsed 0x0 box fails), `display` is not `none`, `opacity` is not transparent, and its own
 * `background-color` clears a real 3:1 WCAG 1.4.11 non-text contrast against the popover it
 * renders on (never just "some rgba() string exists" -- a fully transparent fill would still
 * report SOME colour string and pass a bare truthiness check). */
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

/** #1043 (ui-architect-v3 swatch ruling, 2026-10-20): the two-colour landscape chip
 * (`ProfileMenu.tsx`) is a literal CSS `linear-gradient`, not two separate elements -- reads the
 * SAME row's chip (the row's 3rd Element child: ring, name, swatch) and confirms its computed
 * `background-image` contains both of the theme's own `swatch`/`swatchPrimary` hex values. */
export async function readSwatchGradient(cdp, themeName) {
  return cdp.evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(themeName)}));
      const chip = row ? row.children[2] : null;
      if (!chip) return { present: false };
      return { present: true, backgroundImage: getComputedStyle(chip).backgroundImage };
    })()
  `);
}
