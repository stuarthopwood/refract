// Shared helpers and Launch 1's check body for verify-741-role-chip.mjs, split out to stay under
// the file-size soft cap. `findings`/`failures`/`notExercised` are mutated in place.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getAccessibleNameAndRole, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { parseComputedColorToEntry, compositeOverLinear, resolvedLinear, relativeLuminance, contrastRatio, clamp01 } from './contrast-math.mjs';

/** Measures the chip's text colour against its real effective background. The chip has no fill
 * of its own, so `bgLayersOuterToInner` (ancestor `background-color`s, `<html>` first) are
 * composited in order, skipping transparent layers; the composer can carry alpha (#927).
 * `fgOpacity` folds CSS `opacity` (own times ancestors') into the foreground alpha, because
 * `opacity` is a compositing step, not a colour channel: the disabled composer row's `opacity-60`
 * would otherwise be missed. */
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

// `pressTab`'s Shift-modified counterpart: CDP's modifier bitmask has Shift at value 8.
export async function pressShiftTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
}

// Resizes the real viewport so the composer's available width genuinely narrows.
export async function setWindowWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 400));
}

// All 5 built-in theme presets (`src/shared/themes.ts`); #741 wants every preset where the UI changes.
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

/** The role chip sits immediately before the Model picker in the composer bottom row. With no
 * other stable marker, it is the one bottom-row button whose explicit `aria-label` ends with
 * ", role" (a visible-text-plus-sr-only join measured an extra space live). */
export const ROLE_CHIP_FINDER = `Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').endsWith(', role'))`;

// The visible label is the button's plain `textContent`; the accessible name comes from `aria-label`.
export const ROLE_CHIP_LABEL_EXPR = `(() => { const b = (${ROLE_CHIP_FINDER}); return b ? b.textContent.trim() : null; })()`;

export async function readRoleChip(cdp) {
  const exists = await cdp.evaluate(`!!(${ROLE_CHIP_FINDER})`);
  if (!exists) return null;
  return cdp.evaluate(ROLE_CHIP_LABEL_EXPR);
}

/** Shared contrast probe (chip text vs real effective background, ancestor opacity folded in).
 * `fgOpacityOverride` replaces the live-read opacity in the maths only: forcing a dimmed render
 * via an inline `opacity` style read back "1" from `getComputedStyle` (cause never isolated). */
export async function measureChipContrast(cdp, fgOpacityOverride) {
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
  if (!probe) return null;
  const opacity = fgOpacityOverride === undefined ? probe.opacity : fgOpacityOverride;
  return resolveEffectiveTextContrast(probe.fg, probe.bgLayers, opacity);
}

/** Probes the composer row (`data-composer-row`), its model/reasoning/attach triggers and the role
 * chip's truncating span, at full and narrow widths. Measures against the real row, never
 * `document.body` (there is no `data-slot="card"` ancestor, so a `body` fallback would make every
 * "fully inside" assertion vacuous). Throws if the row is missing rather than fall back. */
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

/** Waited for before asserting "no chip": proves the renderer's Sessions store received the model
 * snapshot, so the assertion cannot pass only because nothing had rendered yet. */
export const SIXTY_CHAR_MODEL_ID = 'claude-fable-5-the-sixty-plus-character-example-model-name';
export const MODEL_TRIGGER_FOUND_EXPR = `!!Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('claude-fable-5') || (b.getAttribute('aria-label') || '').startsWith('Claude Fable Five'))`;

/** Launch 1's full check body (Default chip through the mid-session fallback-while-pinned
 * transition). `findings`/`failures`/`notExercised` are mutated in place. */
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

  // A real keyboard path, not `.focus()`: Tab from the message box (bounded, no exact count)
  // until the chip is focused, confirm `:focus-visible` and the Tooltip, Escape closes the
  // Tooltip without moving focus, then Shift+Tab moves away.
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

  // Real geometry: the model trigger must be truncated (`scrollWidth > clientWidth`), Reasoning
  // keeps its natural width, and Reasoning/Attach stay fully inside the composer row.
  // `COMPOSER_GEOMETRY_EXPR` measures against `[data-composer-row]` and throws if it is missing.
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

  // Session details card: move the pointer away first so hovering the row is a genuine "enter"
  // (Radix HoverCard trigger), wait the 750ms openDelay (8s window), read the "via {provider}" line.
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
  // `textContent` holds the full name, but `truncate` may still render an ellipsis, so this
  // asserts "contains", not "shows".
  const detailsNameVisible = await cdp1.evaluate(`document.body.textContent.includes('Claude Fable Five, an Example Model Name Over Sixty Characters Long')`);
  if (detailsNameVisible) findings.push('Session details card\'s DOM text contains the model\'s full, untruncated name (CSS may still render it ellipsis-truncated at this width).');
  else failures.push('Session details card does not show the model display name text.');
  await cdp1.screenshot(path.join(SHOTS_DIR, '06-details-card.png'));
  await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); // move away, close the card

  for (const theme of THEMES) {
    await switchTheme(cdp1, theme.id, theme.name);
    // `switchTheme` returns before the dropdown's closing animation ends, with the pointer still
    // over the menu item; a stray menu or Tooltip could land in the screenshot.
    await cdp1.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: `Theme menu closed after switching to ${theme.name}` });
    // `switchTheme` leaves the profile button focused and hovered; Radix keeps its Tooltip open
    // on focus alone, so click a neutral element (the message box, never the chip) to blur it,
    // then wait for no Tooltip rather than use a fixed delay.
    await cdp1.click(`document.querySelector('[aria-label="Message"]')`).catch(() => {});
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await cdp1.waitFor(`!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `[${theme.name}] stray profile-menu tooltip closed before screenshot` }).catch((err) => failures.push(err.message));
    // Contrast is measured in all five themes through the shared `measureChipContrast` probe.
    const themeContrastRatio = await measureChipContrast(cdp1);
    if (themeContrastRatio !== null && themeContrastRatio >= 4.5) {
      findings.push(`Role chip text contrast is ${themeContrastRatio.toFixed(2)}:1 against its real effective background under the ${theme.name} theme (>= 4.5:1 required).`);
    } else {
      failures.push(`Role chip text contrast under the ${theme.name} theme was ${themeContrastRatio === null ? 'unmeasurable' : themeContrastRatio.toFixed(2) + ':1'}, expected >= 4.5:1.`);
    }
    if (theme === THEMES[0]) {
      // Sensitivity self-check: `resolveEffectiveTextContrast` must react to a lower opacity.
      // The opacity is substituted into the maths (`fgOpacityOverride`) because a real inline
      // `opacity` mutation never changed `getComputedStyle` here (cause never isolated).
      const dimmedRatio = await measureChipContrast(cdp1, 0.6);
      if (dimmedRatio !== null && themeContrastRatio !== null && dimmedRatio < themeContrastRatio && dimmedRatio < 4.5) {
        findings.push(`Contrast probe sensitivity self-check: substituting opacity 0.6 into the same live-read colours drops the measured ratio from ${themeContrastRatio.toFixed(2)}:1 to ${dimmedRatio.toFixed(2)}:1 (< 4.5, confirms the probe reacts to opacity).`);
      } else {
        failures.push(`Contrast probe sensitivity self-check failed: opacity 0.6 measured ${dimmedRatio === null ? 'unmeasurable' : dimmedRatio.toFixed(2) + ':1'} against a baseline of ${themeContrastRatio === null ? 'unmeasurable' : themeContrastRatio.toFixed(2) + ':1'}, expected the dimmed ratio lower and < 4.5:1.`);
      }
    }
    const shotName = `01-chip-default-${theme.id}.png`;
    await cdp1.screenshot(path.join(SHOTS_DIR, shotName));
    findings.push(`Screenshot captured: composer strip with the Default role chip under the ${theme.name} theme (${shotName}).`);
  }

  // At a narrow width the role chip and Model picker must wrap together (`RoleAndModelPicker`),
  // measured by their shared `top`.
  for (const width of [380, 520]) {
    await setWindowWidth(cdp1, width);
    await cdp1.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 10_000, label: `Role chip still rendered at ${width}px` });
    // The shared `COMPOSER_GEOMETRY_EXPR` probe also runs at narrow widths.
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
    // The chip's label span must render in full (`shrink-0`) and equal the full label captured earlier.
    if (pairGeometry?.chipLabelNotClipped === true && pairGeometry?.chipVisibleText === defaultChipText) {
      findings.push(`At ${width}px, the role chip's own label renders in full (scrollWidth <= clientWidth) and the visible text equals the full label "${defaultChipText}".`);
    } else {
      failures.push(`At ${width}px, the role chip's label is clipped or incomplete: chipLabelNotClipped=${pairGeometry?.chipLabelNotClipped}, chipVisibleText=${JSON.stringify(pairGeometry?.chipVisibleText)}, expected "${defaultChipText}".`);
    }
    // Containment checks (Reasoning/Attach inside the composer row) run at narrow widths too.
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

  // Real backend hand-pick via `model.setModel` (session-scoped RPC, #454); #741's pin/Custom
  // contract is a Rust/registry concern no DOM click exercises more directly.
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

  // With the Session still pinned, append a fallback `model_change` line to the conversation
  // file (mimicking an autonomous OMP write) and let the tape emit `retry_fallback_succeeded`;
  // the chip must flip to Fallback with no restart (`model.rs`: fallback outranks a pin).
  // `sessions.list()`'s `pinned` is the displayed `effective_pinned` and reads false under a
  // fallback, so the registry's real pin is checked by reading `registry.json` off disk. The 45s
  // wait covers the tape's 3s `__delay__` plus poll/render latency.
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
