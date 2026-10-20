// Shared constants and DOM-driving/reading helpers for verify-1043-theme-radio.mjs, split out
// (#806 file-size cap) the same way verify-741-role-chip.mjs/verify-569 etc. split their own
// bulk check bodies into a companion `-helpers.mjs` file.
import { sleep } from './verify-tauri-cdp.mjs';
import { pressKey, pressEscape, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

// The 5 built-in presets (`src/shared/themes.ts`'s own declaration order) -- every one the
// Theme submenu lists, each exercised as the "current" preset in turn.
export const THEMES_1043 = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

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
      swatchBg: swatch ? swatch.style.backgroundColor : null
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
  // Radix's own open-auto-focus (moving focus from the trigger into the first/checked menu
  // item) lands a frame or two after the menu's rows already exist in the DOM -- the same
  // "needs a frame to actually commit" gap `verify-tauri-569.mjs`'s own comment documents for
  // the Theme submenu's keyboard-open focus. Waiting for focus to land ON a real row (not the
  // trigger button, whose own accessible name coincidentally differs) avoids a race rather than
  // guessing a fixed settle delay.
  await cdp.waitFor(`document.activeElement?.getAttribute('role') === 'menuitemradio'`, { timeoutMs: 5_000, label: 'Open-auto-focus lands on a real menuitemradio row' });
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
