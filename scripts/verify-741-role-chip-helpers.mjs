// Shared helpers and Launch 1's own check body for verify-741-role-chip.mjs, split out (gate
// round 1 fix, file-size): the main script crossed its own 600-line soft cap once the gate round
// 1 fixes (contrast, real keyboard path, real geometry, narrow-width pairing, mid-session
// fallback) were added. Launch 1 alone (by far the largest single launch) moved here as
// `runLaunch1Checks`, taking every shared value it needs as a parameter -- `findings`/`failures`/
// `notExercised` are mutated in place (arrays are passed by reference in JS), exactly as the
// inline version did.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getAccessibleNameAndRole, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { parseComputedColorToEntry, compositeOverLinear, resolvedLinear, relativeLuminance, contrastRatio, clamp01 } from './contrast-math.mjs';

/** Gate round 1 fix (HIGH #1): the chip's own text colour (`getComputedStyle(chip).color`) is
 * measured against its REAL effective background, not an assumed opaque one -- the chip itself
 * has no fill at rest (`PICKER_TRIGGER_CLASS`'s own `ghost` variant), so its visible background
 * is whichever ancestor actually paints one (the composer box, `bg-composer-background`, can
 * itself carry alpha per #927 "quiet composer"). `bgLayersOuterToInner` is the chip's own
 * ancestor chain's `background-color`, `<html>` first: each layer is composited over everything
 * BELOW it (the running `base`) in order, skipping fully transparent layers, so the final `base`
 * is the one true backdrop colour actually behind the chip's own text.
 *
 * Gate round 2 fix (HIGH #3): `fgOpacity` folds in CSS `opacity` (the element's own, times every
 * ancestor's, up to the painted background) into the foreground's EFFECTIVE alpha -- the chip's
 * own text colour alpha channel alone was never dimmed by `opacity-60`, since `opacity` is a
 * separate compositing step applied to the whole subtree, not a colour-channel property.
 * `MessageInput.tsx`'s own disabled-row wrapper (`disabled && 'opacity-60'`) dims the WHOLE
 * composer row independently of the chip's own `aria-disabled:opacity-100` -- a contrast probe
 * that never multiplied this in could read a genuinely dimmed chip as if it were fully opaque. */
export function resolveEffectiveTextContrast(fgRaw, bgLayersOuterToInner, fgOpacity = 1) {
  let base = null;
  for (const raw of bgLayersOuterToInner) {
    const entry = parseComputedColorToEntry(raw);
    if (!entry || entry.alpha <= 0) continue;
    base = base ? { alpha: 1, linear: compositeOverLinear(entry, base) } : { alpha: 1, linear: entry.alpha >= 1 ? entry.linear : entry.linear };
  }
  if (!base) return null;
  const fgEntry = parseComputedColorToEntry(fgRaw);
  if (!fgEntry) return null;
  const effectiveAlpha = clamp01(fgEntry.alpha * fgOpacity);
  const fgLinear = resolvedLinear({ ...fgEntry, alpha: effectiveAlpha }, base);
  return contrastRatio(relativeLuminance(fgLinear), relativeLuminance(base.linear));
}

// `pressTab`'s own Shift-modified counterpart (gate round 1 LOW #13c), matching the repo's own
// established pattern (`verify-558-blocker-callout.mjs`): CDP's `Input.dispatchKeyEvent`
// modifier bitmask has Shift at bit 3 (value 8).
export async function pressShiftTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
}

// Gate round 1 fix (HIGH #7): resizes the real rendered viewport (same mechanism `verify-554-
// chat-width.mjs`'s own `setWindowWidth` already uses) so the composer's own available width
// genuinely narrows, rather than guessing a width from a screenshot alone.
export async function setWindowWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 400));
}

// All 5 built-in theme presets (`src/shared/themes.ts`); #741 decision 3 names "every preset
// where the UI changes" for screenshots.
export const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

export const DEFAULT_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5-the-sixty-plus-character-example-model-name',
  role: 'default',
  resolvedModelIsFallback: false
});
export const FALLBACK_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5',
  role: 'default',
  resolvedModelIsFallback: true
});
export const UNKNOWN_ROLE_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5',
  role: 'a-role-no-chat-role-map-recognises',
  resolvedModelIsFallback: false
});

export async function openScratchSession(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted (story DOM marker)' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness checklist green' }
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
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
    timeoutMs: 60_000,
    label: 'Session opened, composer enabled'
  });
  const list = await cdp.evaluate(`window.refract.sessions.list()`);
  if (!list.ok || list.value.length !== 1) throw new Error(`openScratchSession: expected exactly 1 session, got ${JSON.stringify(list)}`);
  return list.value[0].id;
}

/** #741: the role chip sits immediately before the Model picker in the composer bottom row.
 * Both render inside the same `aria-disabled` ghost-button family with no other stable marker,
 * so the chip is found structurally: the one button in the bottom row whose own `aria-label`
 * ENDS with ", role" (gate round 1 fix MEDIUM #6, round 2: an explicit `aria-label`, not a
 * visible-text-plus-sr-only-span join, which measured an extra space live -- see
 * `ComposerPickers.tsx`'s own comment). */
export const ROLE_CHIP_FINDER = `Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').endsWith(', role'))`;

// The chip's VISIBLE label is now the button's plain `textContent` (no sr-only span to strip
// any more -- the accessible name is driven entirely by `aria-label`, round 2 fix).
export const ROLE_CHIP_LABEL_EXPR = `(() => { const b = (${ROLE_CHIP_FINDER}); return b ? b.textContent.trim() : null; })()`;

export async function readRoleChip(cdp) {
  const exists = await cdp.evaluate(`!!(${ROLE_CHIP_FINDER})`);
  if (!exists) return null;
  return cdp.evaluate(ROLE_CHIP_LABEL_EXPR);
}

/** Gate round 2 fix (HIGH #3): shared contrast-measurement probe (chip's own text colour against
 * its REAL effective background, folding every ancestor's CSS `opacity` into the foreground's
 * alpha) -- used by the per-theme measurement loop AND the in-run sensitivity self-check, so
 * both exercise the exact same measurement path. */
export async function measureChipContrast(cdp) {
  const probe = await cdp.evaluate(`
    (() => {
      const chip = ${ROLE_CHIP_FINDER};
      if (!chip) return null;
      const fg = getComputedStyle(chip).color;
      const bgLayers = [];
      let opacity = 1;
      let el = chip;
      while (el) {
        opacity *= parseFloat(getComputedStyle(el).opacity) || 1;
        bgLayers.push(getComputedStyle(el).backgroundColor);
        el = el.parentElement;
      }
      bgLayers.reverse();
      return { fg, bgLayers, opacity };
    })()
  `);
  return probe ? resolveEffectiveTextContrast(probe.fg, probe.bgLayers, probe.opacity) : null;
}

/** Gate round 2 fix (HIGH #2/#4): the composer bottom row's own `data-composer-row` marker
 * (`MessageInput.tsx`), the model/reasoning/attach triggers found WITHIN it, and the role chip's
 * own truncating span -- one shared probe used both at full width and inside the narrow-width
 * (380/520px) loop, so "fully inside the row" is always measured against the REAL composer row,
 * never `document.body` (there is no `data-slot="card"` ancestor around the composer at all, so
 * the old `.closest('[data-slot="card"]') || document.body` fallback silently always took the
 * `document.body` branch, making every "fully inside" assertion vacuous). Throws if the row
 * cannot be found at all, rather than silently falling back to a container that can never
 * meaningfully overflow. */
export const COMPOSER_GEOMETRY_EXPR = `
  (() => {
    const row = document.querySelector('[data-composer-row]');
    if (!row) throw new Error('data-composer-row not found -- the composer bottom row selector is broken');
    const rowRect = row.getBoundingClientRect();
    const chip = ${ROLE_CHIP_FINDER};
    const buttons = Array.from(row.querySelectorAll('button'));
    const modelButton = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('claude-fable-5') || (b.getAttribute('aria-label') || '').startsWith('Claude Fable Five'));
    const reasoningButton = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('Medium') && b !== modelButton);
    const attachButton = buttons.find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes('attach'));
    const modelSpan = modelButton ? modelButton.querySelector('span.truncate') : null;
    const chipLabelSpan = chip ? chip.querySelector('span.truncate') : null;
    const fullyInside = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= rowRect.left - 1 && r.right <= rowRect.right + 1 && r.top >= rowRect.top - 1 && r.bottom <= rowRect.bottom + 1;
    };
    return {
      chipTop: chip ? Math.round(chip.getBoundingClientRect().top) : null,
      modelTop: modelButton ? Math.round(modelButton.getBoundingClientRect().top) : null,
      modelTruncated: modelSpan ? modelSpan.scrollWidth > modelSpan.clientWidth : null,
      chipLabelNotClipped: chipLabelSpan ? chipLabelSpan.scrollWidth <= chipLabelSpan.clientWidth : null,
      chipVisibleText: chip ? chip.textContent.trim() : null,
      reasoningNotTruncated: reasoningButton ? reasoningButton.scrollWidth <= reasoningButton.clientWidth : null,
      reasoningFullyInside: fullyInside(reasoningButton),
      attachFullyInside: fullyInside(attachButton)
    };
  })()
`;

/** Gate round 2 fix (MEDIUM #7): waited for by launches 4/5 before asserting "no chip" -- proves
 * the renderer's OWN Sessions store (not just Rust state) actually received the post-`get_state`
 * model snapshot, so a no-chip assertion that only passed because nothing had rendered YET can no
 * longer pass vacuously. */
export const SIXTY_CHAR_MODEL_ID = 'claude-fable-5-the-sixty-plus-character-example-model-name';
export const MODEL_TRIGGER_FOUND_EXPR = `!!Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('claude-fable-5') || (b.getAttribute('aria-label') || '').startsWith('Claude Fable Five'))`;

/** Launch 1's full check body (Default chip through the mid-session fallback-while-pinned
 * transition) -- see `verify-741-role-chip.mjs`'s own header comment for the full launch list.
 * `findings`/`failures`/`notExercised` are mutated in place. */
export async function runLaunch1Checks(cdp1, sessionId1, conversationFile1, dataDir1, findings, failures, notExercised, SHOTS_DIR) {
  await cdp1.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 30_000, label: 'Role chip rendered' });
  const defaultChipText = await readRoleChip(cdp1);
  if (defaultChipText === 'Default') {
    findings.push('Role chip reads "Default" for a Session whose latest model_change entry carries role:"default".');
  } else {
    failures.push(`Role chip text was ${JSON.stringify(defaultChipText)}, expected "Default".`);
  }
  const chipAx = await getAccessibleNameAndRole(cdp1, `(${ROLE_CHIP_FINDER})`);
  if (chipAx.name === 'Default, role') {
    findings.push('Role chip accessible name is "Default, role" (an explicit aria-label, not a sr-only span, confirmed via the AX tree).');
  } else {
    failures.push(`Role chip accessible name was ${JSON.stringify(chipAx.name)}, expected "Default, role".`);
  }
  const chipIconFound = await cdp1.evaluate(`!!(${ROLE_CHIP_FINDER}).querySelector('svg[aria-hidden]')`);
  if (chipIconFound) findings.push('Role chip renders an aria-hidden icon beside its text.');
  else failures.push('Role chip has no aria-hidden <svg> icon.');

  // Gate round 1 fix (LOW #13c): a REAL keyboard path, not a JS `.focus()` call -- Tab from
  // the message box (a known, stable starting point) until focus lands on the chip (bounded,
  // never an exact tab-count guess), confirm `:focus-visible` and the Tooltip opening, Escape
  // closes the Tooltip without moving focus off the chip, then Shift+Tab moves focus away.
  await cdp1.click(`document.querySelector('[aria-label="Message"]')`);
  let chipReachedByTab = false;
  for (let i = 0; i < 10 && !chipReachedByTab; i++) {
    await pressTab(cdp1);
    chipReachedByTab = await cdp1.evaluate(`(${ROLE_CHIP_FINDER}) === document.activeElement`);
  }
  if (chipReachedByTab) {
    findings.push('A real, bounded Tab sequence from the message box reaches the role chip.');
  } else {
    failures.push('A real, bounded (10-press) Tab sequence from the message box never reached the role chip.');
  }
  const chipFocusVisible = await cdp1.evaluate(`(${ROLE_CHIP_FINDER}).matches(':focus-visible')`);
  if (chipFocusVisible) findings.push('The role chip matches :focus-visible after a real keyboard Tab.');
  else failures.push('The role chip does not match :focus-visible after a real keyboard Tab.');
  await new Promise((r) => setTimeout(r, 300)); // Tooltip open delay
  const chipTooltipOpenOnFocus = await cdp1.evaluate(`document.body.textContent.includes('Role: Default.')`);
  if (chipTooltipOpenOnFocus) findings.push('The role chip\'s Tooltip opens on real keyboard focus ("Role: Default." visible).');
  else failures.push('The role chip\'s Tooltip did not open on real keyboard focus.');
  await pressEscape(cdp1);
  await new Promise((r) => setTimeout(r, 300));
  const chipStillFocusedAfterEscape = await cdp1.evaluate(`(${ROLE_CHIP_FINDER}) === document.activeElement`);
  const tooltipClosedAfterEscape = await cdp1.evaluate(`!document.body.textContent.includes('Role: Default.')`);
  if (chipStillFocusedAfterEscape && tooltipClosedAfterEscape) {
    findings.push('Escape closes the role chip\'s Tooltip without moving focus off the chip.');
  } else {
    failures.push(`Escape on the role chip: stillFocused=${chipStillFocusedAfterEscape}, tooltipClosed=${tooltipClosedAfterEscape}, expected both true.`);
  }
  await pressShiftTab(cdp1);
  const focusLeftChipOnShiftTab = await cdp1.evaluate(`(${ROLE_CHIP_FINDER}) !== document.activeElement`);
  if (focusLeftChipOnShiftTab) findings.push('Shift+Tab moves focus away from the role chip.');
  else failures.push('Shift+Tab did not move focus away from the role chip.');

  // Gate round 1 fix (HIGH #3a): real geometry, not a guessed selector that could pass on
  // broken code -- the model trigger must actually be truncated (`scrollWidth > clientWidth`);
  // the Reasoning (effort) trigger must keep its OWN natural width (never shrunk/truncated)
  // AND stay fully inside the composer row's own bounding rect; Attach must stay fully inside
  // the row too (not merely "found in the DOM", the old check's own vacuous `attachVisible`).
  // Gate round 2 fix (HIGH #4): the row used to resolve via `.closest('[data-slot="card"]') ||
  // document.body` -- there is no `data-slot="card"` ancestor around the composer at all, so
  // that selector always silently fell back to `document.body`, making every "fully inside"
  // assertion below vacuous (body is always big enough). `COMPOSER_GEOMETRY_EXPR` measures
  // against the real `[data-composer-row]` marker (`MessageInput.tsx`) instead, and throws
  // (caught below, turned into a failure) if that marker cannot be found at all.
  let geometryProbe;
  try {
    geometryProbe = await cdp1.evaluate(COMPOSER_GEOMETRY_EXPR);
  } catch (err) {
    failures.push(`Composer row geometry probe failed: ${err.message}`);
    geometryProbe = null;
  }
  if (geometryProbe?.modelTruncated === true) {
    findings.push('The 60-character-plus model name truncates (real geometry: scrollWidth > clientWidth on the Model picker trigger\'s own truncating span).');
  } else {
    failures.push(`Model trigger truncation check: modelTruncated=${geometryProbe?.modelTruncated}, expected true.`);
  }
  if (geometryProbe?.reasoningNotTruncated === true && geometryProbe?.reasoningFullyInside === true) {
    findings.push('The Reasoning (effort) trigger keeps its own natural width (never shrunk/truncated) and stays fully inside the composer row.');
  } else {
    failures.push(`Reasoning trigger geometry check: reasoningNotTruncated=${geometryProbe?.reasoningNotTruncated}, reasoningFullyInside=${geometryProbe?.reasoningFullyInside}, expected both true.`);
  }
  if (geometryProbe?.attachFullyInside === true) {
    findings.push('A 60-character-plus model name does not push the Attach button out of the composer row (real geometry: fully inside the row\'s own bounding rect).');
  } else {
    failures.push(`Attach button geometry check: attachFullyInside=${geometryProbe?.attachFullyInside}, expected true.`);
  }

  await cdp1.screenshot(path.join(SHOTS_DIR, '06-composer-row.png'));

  // Session details card: hover the session row, wait the real 750ms openDelay, read the
  // muted "via {provider}" line. Round 2 fix: move the pointer AWAY first and let it settle --
  // the keyboard-path test above never moved the mouse, but a defensive reset guarantees a
  // genuine "enter" transition into the row (Radix HoverCard's own open trigger) regardless;
  // the wait window also grew (3s -> 8s) to give the 750ms openDelay real margin.
  await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await new Promise((r) => setTimeout(r, 200));
  await cdp1.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...(await cdp1.evaluate(`(() => { const r = document.querySelector('[data-session-open]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`))
  });
  await cdp1.waitFor(`document.body.textContent.includes('via GitHub Copilot')`, { timeoutMs: 8_000, label: 'Details card "via GitHub Copilot" line visible' }).catch(() => {
    failures.push('Session details card never showed a "via GitHub Copilot" line after hovering the session row for its 750ms openDelay.');
  });
  if (failures.length === 0 || !failures[failures.length - 1].startsWith('Session details card')) {
    findings.push('Session details card shows a muted "via GitHub Copilot" second line under the model name.');
  }
  // Gate round 1 fix (LOW #14): the DOM contains the full, untruncated name string (asserted
  // here via `textContent`), but the card's own `truncate` class can still render it with a
  // visual ellipsis at this width -- "shows" would misleadingly imply it is visible in full.
  const detailsNameVisible = await cdp1.evaluate(`document.body.textContent.includes('Claude Fable Five, an Example Model Name Over Sixty Characters Long')`);
  if (detailsNameVisible) findings.push('Session details card\'s DOM text contains the model\'s full, untruncated name (CSS may still render it ellipsis-truncated at this width).');
  else failures.push('Session details card does not show the model display name text.');
  await cdp1.screenshot(path.join(SHOTS_DIR, '06-details-card.png'));
  await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); // move away, close the card

  for (const theme of THEMES) {
    await switchTheme(cdp1, theme.id, theme.name);
    // Gate round 1 fix (LOW #13b): `switchTheme` itself returns the instant the theme class
    // applies, before the profile dropdown's own closing animation finishes and while the
    // pointer still sits over the last-clicked menu item -- a stray closing menu or hover
    // Tooltip could otherwise land in the screenshot.
    await cdp1.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: `Theme menu closed after switching to ${theme.name}` });
    // Gate round 2 fix (LOW #9): `switchTheme` clicks `[data-profile-name-button]`, leaving it
    // both focused AND hovered -- Radix keeps that button's own Tooltip ("Stuart Hopwood", the
    // account name) open on focus alone, so a mere pointer move to a neutral spot never closes
    // it (the identical root cause `verify-937-advisor-chip.mjs`'s own fix already documents).
    // Clicking a neutral, always-present element (the message box, never the chip) blurs the
    // profile button instead, then an explicit wait confirms no Tooltip is left open at all
    // before the screenshot, rather than a fixed delay standing in for that real signal.
    await cdp1.click(`document.querySelector('[aria-label="Message"]')`).catch(() => {});
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await cdp1.waitFor(`!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `[${theme.name}] stray profile-menu tooltip closed before screenshot` }).catch((err) => failures.push(err.message));
    // Gate round 2 fix (HIGH #3): contrast measured in ALL FIVE themes (not Dark only), each
    // through the shared `measureChipContrast` probe (folds every ancestor's CSS `opacity` into
    // the foreground's effective alpha).
    const themeContrastRatio = await measureChipContrast(cdp1);
    if (themeContrastRatio !== null && themeContrastRatio >= 4.5) {
      findings.push(`Role chip text contrast is ${themeContrastRatio.toFixed(2)}:1 against its real effective background under the ${theme.name} theme (>= 4.5:1 required).`);
    } else {
      failures.push(`Role chip text contrast under the ${theme.name} theme was ${themeContrastRatio === null ? 'unmeasurable' : themeContrastRatio.toFixed(2) + ':1'}, expected >= 4.5:1.`);
    }
    if (theme === THEMES[0]) {
      // Gate round 2 fix (HIGH #3): an in-run sensitivity self-check -- forces the chip's own
      // inline `opacity` to 0.6 and re-measures, proving the probe actually REACTS to a
      // genuinely dimmed chip (rather than, say, always returning a number >= 4.5 regardless of
      // opacity due to a mistake in the compositing math), then removes the override.
      //
      // Round 2 fix (own bug, live-found): set/measure/restore used to be THREE separate
      // `cdp.evaluate` round-trips -- live-measured 7.63:1 both before AND after forcing
      // opacity:0.6 (mathematically impossible if the override had actually been read: blending
      // ANY fraction of a foreground colour toward its own backdrop strictly lowers contrast).
      // One atomic evaluate call (set, measure, restore, all in the SAME synchronous script
      // execution) removes any inter-call gap a remount/reconciliation could exploit; a direct
      // `appliedOpacity` readback confirms the override was actually observed by
      // `getComputedStyle`, independent of the contrast math, for a clearer failure if it isn't.
      const dimmedProbe = await cdp1.evaluate(`
        (() => {
          const chip = ${ROLE_CHIP_FINDER};
          if (!chip) return null;
          const previousOpacity = chip.style.opacity;
          chip.style.opacity = '0.6';
          const appliedOpacity = getComputedStyle(chip).opacity;
          const fg = getComputedStyle(chip).color;
          const bgLayers = [];
          let opacity = 1;
          let el = chip;
          while (el) {
            opacity *= parseFloat(getComputedStyle(el).opacity) || 1;
            bgLayers.push(getComputedStyle(el).backgroundColor);
            el = el.parentElement;
          }
          bgLayers.reverse();
          chip.style.opacity = previousOpacity;
          return { fg, bgLayers, opacity, appliedOpacity };
        })()
      `);
      const dimmedRatio = dimmedProbe ? resolveEffectiveTextContrast(dimmedProbe.fg, dimmedProbe.bgLayers, dimmedProbe.opacity) : null;
      if (dimmedProbe && dimmedProbe.appliedOpacity !== '0.6') {
        failures.push(`Contrast probe sensitivity self-check: forcing chip.style.opacity='0.6' did not take effect -- getComputedStyle read back "${dimmedProbe.appliedOpacity}".`);
      } else if (dimmedRatio !== null && dimmedRatio < 4.5) {
        findings.push(`Contrast probe sensitivity self-check: forcing the chip's own inline opacity to 0.6 drops the measured ratio to ${dimmedRatio.toFixed(2)}:1 (< 4.5, confirms the probe reacts to opacity).`);
      } else {
        failures.push(`Contrast probe sensitivity self-check failed: forcing opacity:0.6 (confirmed applied) measured ${dimmedRatio === null ? 'unmeasurable' : dimmedRatio.toFixed(2) + ':1'}, expected < 4.5:1.`);
      }
    }
    const shotName = `01-chip-default-${theme.id}.png`;
    await cdp1.screenshot(path.join(SHOTS_DIR, shotName));
    findings.push(`Screenshot captured: composer strip with the Default role chip under the ${theme.name} theme (${shotName}).`);
  }

  // Gate round 1 fix (HIGH #7): at a narrow chat width, the role chip and Model picker must
  // wrap TOGETHER as one unit (`RoleAndModelPicker`), never split across two lines -- measured
  // by their shared `top`, not guessed from a screenshot alone.
  for (const width of [380, 520]) {
    await setWindowWidth(cdp1, width);
    await cdp1.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 10_000, label: `Role chip still rendered at ${width}px` });
    // Gate round 2 fix (HIGH #2/#4): the shared `COMPOSER_GEOMETRY_EXPR` probe (real composer
    // row, never `document.body`) also runs at these narrow widths now, not only at full width.
    let pairGeometry;
    try {
      pairGeometry = await cdp1.evaluate(COMPOSER_GEOMETRY_EXPR);
    } catch (err) {
      failures.push(`[${width}px] Composer row geometry probe failed: ${err.message}`);
      pairGeometry = null;
    }
    if (pairGeometry && pairGeometry.chipTop === pairGeometry.modelTop) {
      findings.push(`At ${width}px, the role chip and Model picker share the same row (wrapped together, top=${pairGeometry.chipTop}).`);
    } else {
      failures.push(`At ${width}px, the role chip and Model picker did NOT share the same row: ${JSON.stringify(pairGeometry)}.`);
    }
    // Gate round 2 fix (HIGH #2): the chip's own label span must render in full at this width
    // (never clipped, now that it keeps `shrink-0`) and the visible text must equal the full
    // label captured earlier -- not merely "a span exists".
    if (pairGeometry?.chipLabelNotClipped === true && pairGeometry?.chipVisibleText === defaultChipText) {
      findings.push(`At ${width}px, the role chip's own label renders in full (scrollWidth <= clientWidth) and the visible text equals the full label "${defaultChipText}".`);
    } else {
      failures.push(`At ${width}px, the role chip's label is clipped or incomplete: chipLabelNotClipped=${pairGeometry?.chipLabelNotClipped}, chipVisibleText=${JSON.stringify(pairGeometry?.chipVisibleText)}, expected "${defaultChipText}".`);
    }
    // Gate round 2 fix (HIGH #4): the containment checks (Reasoning/Attach fully inside the
    // real composer row) now also run at these narrow widths, not only at full width.
    if (pairGeometry?.reasoningFullyInside === true && pairGeometry?.attachFullyInside === true) {
      findings.push(`At ${width}px, the Reasoning and Attach triggers both stay fully inside the composer row's own bounding rect.`);
    } else {
      failures.push(`At ${width}px, containment check failed: reasoningFullyInside=${pairGeometry?.reasoningFullyInside}, attachFullyInside=${pairGeometry?.attachFullyInside}, expected both true.`);
    }
    const shotFile = width === 380 ? '08-narrow-380.png' : '09-narrow-520.png';
    await cdp1.screenshot(path.join(SHOTS_DIR, shotFile));
    findings.push(`Screenshot captured: composer strip at ${width}px chat width (${shotFile}).`);
  }
  await cdp1.send('Emulation.clearDeviceMetricsOverride');
  await new Promise((r) => setTimeout(r, 400));

  // Real backend hand-pick: `model.setModel` (session-scoped RPC, #454) pins the Session --
  // matches `verify-rm-live-check.mjs`'s own established precedent for driving this exact IPC
  // surface directly; #741's pin/Custom-chip contract is a Rust/registry concern no DOM click
  // exercises any more directly than this call does.
  const setModelRes = await cdp1.evaluate(`window.refract.model.setModel(${JSON.stringify(sessionId1)}, 'github-copilot', 'claude-haiku-5.5')`);
  if (!setModelRes.ok) failures.push(`model.setModel failed: ${JSON.stringify(setModelRes)}`);
  await cdp1.waitFor(`${ROLE_CHIP_LABEL_EXPR} === 'Custom'`, { timeoutMs: 15_000, label: 'Role chip reads Custom after a hand-picked model' }).catch((err) => {
    failures.push(`Role chip never flipped to Custom after model.setModel: ${err.message}`);
  });
  const afterPinList = await cdp1.evaluate(`window.refract.sessions.list()`);
  const afterPinSummary = afterPinList.ok ? afterPinList.value.find((s) => s.id === sessionId1) : undefined;
  if (afterPinSummary?.pinned === true && afterPinSummary?.currentRole == null) {
    findings.push('sessions.list() reports pinned:true, currentRole:null after model.setModel -- the registry-level pin contract.');
  } else {
    failures.push(`sessions.list() after pin: ${JSON.stringify(afterPinSummary)}, expected pinned:true, currentRole:null.`);
  }
  await cdp1.screenshot(path.join(SHOTS_DIR, '02-chip-custom.png'));

  // Gate round 1 fix (MEDIUM #4): with the Session STILL pinned, append a fallback
  // `model_change` line to the SAME conversation file (an autonomous OMP write this script
  // mimics directly, since it would otherwise need a real retry-fallback transition) and let
  // the tape (`role-chip-741.jsonl`) autonomously emit a real `retry_fallback_succeeded` frame
  // a couple of seconds later -- the chip must flip to Fallback with NO restart (proving
  // `model.rs`'s own "fallback outranks a pin" fix). Round 2 fix: `sessions.list()`'s own
  // `pinned` field is the DISPLAYED `effective_pinned` (model.rs's `resolve_current_selection`),
  // which is DESIGNED to read false once a fallback overrides -- that is how the chip knows to
  // show Fallback instead of Custom. The actual claim ("the registry's own pin is never
  // cleared") can only be checked by reading `registry.json` directly off disk, bypassing the
  // effective-pinned wire field entirely. The wait window also grew (20s -> 45s): the fake-omp
  // tape's own 3s `__delay__` plus a real build's poll/render latency needs real margin.
  appendFileSync(conversationFile1, FALLBACK_MODEL_CHANGE_LINE + '\n');
  await cdp1.waitFor(`${ROLE_CHIP_LABEL_EXPR} === 'Fallback'`, { timeoutMs: 45_000, label: 'Role chip flips to Fallback while pinned, no restart' }).catch((err) => {
    failures.push(`Role chip never flipped to Fallback while pinned: ${err.message}`);
  });
  const registryDuringFallback = JSON.parse(readFileSync(path.join(dataDir1, 'registry.json'), 'utf8'));
  const registrySessionDuringFallback = registryDuringFallback.sessions?.find((s) => s.id === sessionId1);
  if (registrySessionDuringFallback?.pinnedModel === true) {
    findings.push('registry.json\'s own pinnedModel field still reads true while the chip shows Fallback -- the persisted pin is never cleared by a fallback (only the DISPLAYED, wire-level effective_pinned flips, by design).');
  } else {
    failures.push(`registry.json during mid-session fallback: pinnedModel=${registrySessionDuringFallback?.pinnedModel}, expected true (the persisted pin itself must survive).`);
  }
  await cdp1.screenshot(path.join(SHOTS_DIR, '07-chip-fallback-while-pinned.png'));
  findings.push('Launch 1 complete: Default chip, real-geometry truncation, details card, AX names, contrast, a real keyboard path, 5-theme and 2 narrow-width screenshots, the hand-pick-to-Custom transition, and the mid-session fallback-while-pinned transition all exercised.');
}
