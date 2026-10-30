// Session-list-specific CDP driving helpers shared by `verify-tauri-735.mjs` (and any future
// session-list live-check script) -- extracted from that file to keep it under the #806 600-line
// file-size cap (`scripts/check-file-size.mjs`). Depends only on a `CdpSession`-shaped `cdp`
// (see `verify-tauri-cdp.mjs`), never on anything specific to the #735 story itself.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function assertTrue(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Isolated proof of the trailing slot's opacity swap (time at rest, the row's "..." trigger on
 * hover) -- gate round 2 fix, High, N1 (three independent reviewers plus the facilitator's own
 * disclosed spot-check): round 1's fix scoped every reveal rule, even the base visibility,
 * inside `[@media(hover:hover)]`, so a touch-only pointer could never reveal or tap the "..."
 * trigger at all, regressing decision 12's "Under hover:none, both show". Also statically
 * verifies the fix's own `@media(hover:none)` CSS rule exists (a live touch-emulation proof was
 * attempted and found not possible in this harness -- see the function body's own comment).
 * Extracted from `verify-tauri-567.mjs` to keep it under the #806 600-line file-size cap. */
export async function proveTrailingSlotSwapAndHoverNone(cdp, evidenceDir, log, { rowFinder, ellipsisFinder }) {
  // Clears any lingering keyboard focus too, not just the pointer: `group-focus-within` (the
  // same reveal rule Tab/Shift+Tab focus on the open button legitimately uses) would otherwise
  // still show the "..." here, since the Focus ring check just before this one leaves the open
  // button focused via real Shift+Tab.
  await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  const trailingCellFinder = `${ellipsisFinder}.closest('span.relative')`;
  const trailingTimeFinder = `${trailingCellFinder}.querySelector('span[aria-hidden]')`;
  await cdp.waitFor(`parseFloat(getComputedStyle(${ellipsisFinder}).opacity) < 0.5`, { timeoutMs: 5_000, label: '"..." hidden at rest (hover cleared)' });
  const trailingAtRest = await cdp.evaluate(`(() => ({ buttonOpacity: getComputedStyle(${ellipsisFinder}).opacity, timeVisibility: getComputedStyle(${trailingTimeFinder}).visibility }))()`);
  log(`verify-tauri-567: trailing slot AT REST: ${JSON.stringify(trailingAtRest)}`);
  assertTrue(parseFloat(trailingAtRest.buttonOpacity) < 0.5 && trailingAtRest.timeVisibility === 'visible', `at rest the time must show and "..." must hide (decision 12), got ${JSON.stringify(trailingAtRest)}`);
  const rowRect = await cdp.waitFor(
    `(() => { const el = ${rowFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${rowFinder}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
  await cdp.waitFor(`parseFloat(getComputedStyle(${ellipsisFinder}).opacity) > 0.5`, { timeoutMs: 5_000, label: '"..." revealed on hover' });
  const trailingOnHover = await cdp.evaluate(`(() => ({ buttonOpacity: getComputedStyle(${ellipsisFinder}).opacity, timeVisibility: getComputedStyle(${trailingTimeFinder}).visibility }))()`);
  log(`verify-tauri-567: trailing slot ON HOVER: ${JSON.stringify(trailingOnHover)}`);
  assertTrue(parseFloat(trailingOnHover.buttonOpacity) > 0.5 && trailingOnHover.timeVisibility === 'hidden', `on hover "..." must show and the time must hide (decision 12's swap), got ${JSON.stringify(trailingOnHover)}`);
  log('STEP PASS: trailing slot opacity swap isolated and proven both ways (time at rest, "..." on hover).');
  await cdp.screenshot(path.join(evidenceDir, '03-row-hover-trailing-slot.png'));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

  // `Emulation.setEmulatedMedia`'s `features` parameter (the documented way to emulate
  // `(hover: none)`/`(pointer: coarse)`) is accepted without error by WebView2's own CDP
  // endpoint (confirmed live: the command returns `{}`, no CDP error) but has no observable
  // effect here -- `window.matchMedia('(hover: none)').matches` stayed `false` even 500ms after
  // the call, so a live behavioural proof under an emulated touch pointer is not possible with
  // this harness. Falls back to a static proof instead: finds the actual `@media` rule the
  // running page's own bundled CSS generated for this exact button (by class-selector match,
  // independent of which media condition currently applies), and asserts it is scoped to a
  // `hover: none` condition and sets `pointer-events: auto` (decision 12's "both show" requires
  // the button be tappable, not merely visible) -- proving the rule exists and is correctly
  // wired, even though the live rendered behaviour under a real touch pointer could not be
  // driven end-to-end in this environment.
  const hoverNoneRule = await cdp.evaluate(
    `(() => { const el = ${ellipsisFinder}; function walk(rules) { for (const rule of rules || []) { if (rule.media && /hover\\s*:\\s*none/.test(rule.media.mediaText)) { for (const inner of rule.cssRules || []) { try { if (inner.selectorText && el.matches(inner.selectorText) && /pointer-events\\s*:\\s*auto/.test(inner.style.cssText)) return { media: rule.media.mediaText, selector: inner.selectorText, css: inner.style.cssText }; } catch {} } } if (rule.cssRules) { const found = walk(rule.cssRules); if (found) return found; } } return null; } for (const sheet of document.styleSheets) { try { const found = walk(sheet.cssRules); if (found) return found; } catch {} } return null; })()`
  );
  writeFileSync(path.join(evidenceDir, 'hover-none-css-rule.json'), JSON.stringify(hoverNoneRule, null, 2));
  log(`verify-tauri-567: static (hover:none) CSS rule for the "..." trigger: ${JSON.stringify(hoverNoneRule)}`);
  assertTrue(
    hoverNoneRule && /pointer-events\s*:\s*auto/.test(hoverNoneRule.css),
    `the "..." trigger's own bundled CSS must carry an @media(hover:none)-scoped pointer-events:auto rule (decision 12's regression fix, N1), found ${JSON.stringify(hoverNoneRule)}`
  );
  log(
    'STEP PASS (code-verified, not live-driven -- see the comment above): the "..." trigger\'s own @media(hover:none) CSS rule exists and sets pointer-events:auto.'
  );
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Computed accessible name of the FIRST element matching `finderExpr`, via CDP Accessibility
 * domain -- never textContent, which is not what a screen reader announces and would not
 * distinguish the combined aria-label this story builds (label + marker + "contains open
 * session"). `null` when nothing matches or it carries no AX node. */
export async function getAccessibleName(cdp, finderExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: finderExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  return nodes?.[0]?.name?.value ?? null;
}

export async function getActiveElementAccessibleName(cdp) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return { name: null, role: null };
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  const node = nodes?.[0];
  return { name: node?.name?.value ?? null, role: node?.role?.value ?? null };
}

export async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

export async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}

/** Moves a real pointer over the centre of the element matched by `finderExpr`, without
 * clicking -- the only reliable way to trigger a `:hover`/`group-hover` CSS reveal over CDP
 * (`Input.dispatchMouseEvent` with no press). Extracted from `verify-tauri-567.mjs` to keep it
 * under the #806 600-line file-size cap. */
export async function hoverRow(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
}

/** A single real keydown/keyup pair with an explicit DOM `key`/`code` (Chromium only moves
 * focus, or fires the right synthetic key, when both are set -- a bare `windowsVirtualKeyCode`
 * is not enough). `modifiers` is CDP's own bitmask (Shift=8). */
export async function pressKey(cdp, windowsVirtualKeyCode, key, code, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode, key, code, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode, key, code, modifiers });
}

/** A real right-click (press then release the right button) at the centre of the element
 * matched by `finderExpr`, the one way to trigger a native `contextmenu` event over CDP. */
export async function rightClick(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `right-click target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
}

export function groupTriggerFinder(repoName) {
  // Repository headers are wrapped in a Tooltip (`asChild`), whose own `data-slot`/`data-state`
  // overwrite the inner CollapsibleTrigger's (GroupHeader.tsx's own documented reason for keying
  // off `aria-expanded` instead, never `data-state`, once a trigger is a Tooltip's child too) --
  // so finding by `aria-label` (always starts with the repo name) and reading `aria-expanded`
  // is the only selector immune to that override. Archived carries no tooltip, so its own
  // `data-slot="collapsible-trigger"` is untouched and still the more specific match.
  return `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(repoName)}))`;
}
export const ARCHIVED_TRIGGER_FINDER = `document.querySelector('[data-archived-group] [data-slot="collapsible-trigger"]')`;

export async function groupState(cdp, finderExpr) {
  return cdp.evaluate(`(() => { const el = ${finderExpr}; if (!el) return null; return el.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'; })()`);
}

/** Whether the Repository group's (or Archived's) own 2px `bg-active-indicator` header bar is
 * present in the DOM right now -- the gate round 1 regression target: an archived Session must
 * never leave this bar on its OLD Repository's header. */
export async function hasActiveBar(cdp, repoName) {
  return cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); return !!group?.querySelector('[class*="bg-active-indicator"]'); })()`
  );
}
export async function archivedHasActiveBar(cdp) {
  return cdp.evaluate(`!!document.querySelector('[data-archived-group] [class*="bg-active-indicator"]')`);
}

export async function clickQuickCreate(cdp, repoName) {
  // The header "+" quick-create button stays rendered (and clickable) even while the group is
  // collapsed -- only CollapsibleContent (the row list) is conditionally mounted by Radix.
  const finder = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('[data-quick-create-session]')`;
  await cdp.click(finder);
}

/** Clicks the header "+" quick-create button and waits for BOTH a new row to actually appear in
 * that Repository's own list AND the composer to be enabled. The composer-only wait alone
 * passes even when the click was silently dropped (e.g. by the in-flight `creatingRepositoryIds`
 * guard), because an earlier Session's own composer already satisfies it -- gate round 2 fix,
 * test-reviewer Medium: a dropped second create went undetected exactly this way in round 1. */
export async function createSessionViaQuickCreate(cdp, repoName) {
  const rowSelector = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelectorAll('li').length ?? 0`;
  const before = await cdp.evaluate(rowSelector);
  await clickQuickCreate(cdp, repoName);
  await cdp.waitFor(
    `(() => { const count = ${rowSelector}; const msg = document.querySelector('[aria-label="Message"]'); return count > ${before} && !!msg && !msg.disabled; })()`,
    { timeoutMs: 60_000, label: `Session created in ${repoName} (row count ${before} -> ${before + 1}), composer enabled` }
  );
}

/** Finder for the FIRST (most-recently-active) Session row's own "... actions" trigger inside
 * the named Project's group. */
export function firstRowActionsFinder(repoName) {
  return `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button[aria-label$=" actions"]')`;
}

/** Opens a Session row's own "..." actions menu like a real user, fixing the flake Main
 * diagnosed (2026-10-16): the trigger is revealed by `group-hover`/`group-focus-within`
 * opacity (#567), so a bare synthetic click at a freshly-mounted row's own bounding rect can
 * land before the browser has actually run the hover style recalculation the trigger's own
 * interactivity depends on. Hovers the row first (a real `mouseMoved`, the only way to trigger
 * a `:hover`/`group-hover` CSS reveal over CDP), waits for the trigger to actually report
 * revealed (`opacity > 0.5`) AND closed (`aria-expanded="false"`), THEN clicks it (recomputing
 * the bounding rect at click time, since hovering can itself shift the row's own layout as
 * hidden actions reserve their column) and waits for the real `[role="menu"]` to mount -- never
 * a fixed sleep. On a timeout, captures a screenshot and the row's own DOM for diagnosis. */
export async function openRowActionsMenu(cdp, repoName, evidenceDir, log) {
  const triggerFinder = firstRowActionsFinder(repoName);
  const rowFinder = `${triggerFinder}?.closest('li')`;
  const rowRect = await cdp.waitFor(
    `(() => { const el = ${rowFinder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 15_000, label: `row to hover: ${rowFinder}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
  try {
    await cdp.waitFor(
      `(() => { const el = ${triggerFinder}; if (!el) return false; return parseFloat(getComputedStyle(el).opacity) > 0.5 && el.getAttribute('aria-expanded') === 'false'; })()`,
      { timeoutMs: 10_000, label: `row actions trigger revealed and closed: ${triggerFinder}` }
    );
    await cdp.click(triggerFinder);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'row actions menu opened' });
  } catch (err) {
    const diag = await cdp.evaluate(
      `(() => { const el = ${triggerFinder}; if (!el) return { triggerFound: false }; const cs = getComputedStyle(el); return { triggerFound: true, ariaExpanded: el.getAttribute('aria-expanded'), opacity: cs.opacity, pointerEvents: cs.pointerEvents, outerHTML: el.outerHTML?.slice(0, 600), rowHtml: el.closest('li')?.outerHTML?.slice(0, 2000) }; })()`
    );
    log(`verify-tauri-559: openRowActionsMenu FAILED for "${repoName}" -- diagnostics: ${JSON.stringify(diag, null, 2)}`);
    await cdp.screenshot(path.join(evidenceDir, '99-diag-row-actions-menu-failure.png'));
    throw err;
  }
}

export async function clickMenuItem(cdp, text) {
  const finder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
  await cdp.waitFor(finder + ' !== undefined', { timeoutMs: 10_000, label: `menu item "${text}" present` });
  await cdp.click(finder);
}

/** Archives the FIRST (most-recently-active, so the just-created one) Session row inside the
 * named Repository group's own `<li>` list, via its row menu. */
export async function archiveFirstRowIn(cdp, repoName) {
  await cdp.click(
    `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button[aria-label$=" actions"]')`
  );
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'Row menu open with Archive item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
}

/** Restores the ONLY Session row currently inside Archived, via its row menu. Opens Archived
 * first if it is closed. */
export async function restoreOnlyArchivedRow(cdp) {
  if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') {
    await cdp.click(ARCHIVED_TRIGGER_FINDER);
    await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened to reach the restore action' });
  }
  await cdp.click(`document.querySelector('[data-archived-group]')?.querySelector('li button[aria-label$=" actions"]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`, { timeoutMs: 10_000, label: 'Archived row menu open with Restore item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`);
}

/** Adds a scratch repository through the Add repository dialog -- the Readiness screen's own
 * primary button on an empty profile, or the session list footer's "Add repository" control
 * once at least one Repository already exists. */
export async function addRepository(cdp, dir) {
  await cdp.click(
    `document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository')`
  );
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: dir });
  await cdp.clickByText('Add repository', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'Add repository dialog closed' });
}

/** Removes a Repository (which must already own zero Sessions) via its header's "..." menu and
 * the confirmation dialog's "Remove" action -- decision 29's prune check: proves a removed
 * Repository's id actually leaves `settings.json`, not just that the renderer forgets it. */
export async function removeRepository(cdp, repoName) {
  await cdp.click(`document.querySelector('[aria-label=${JSON.stringify(`Project actions for ${repoName}`)}]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`, {
    timeoutMs: 10_000,
    label: 'Row menu open with Remove project item'
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`);
  await cdp.waitFor(`!!document.querySelector('[data-slot="alert-dialog-content"]')`, { timeoutMs: 10_000, label: 'Remove project dialog open' });
  await cdp.click(`Array.from(document.querySelectorAll('[data-slot="alert-dialog-action"]')).find((el) => el.textContent.trim() === 'Remove')`);
  await cdp.waitFor(`!document.querySelector('[data-slot="alert-dialog-content"]')`, { timeoutMs: 15_000, label: 'Remove project dialog closed' });
}

/** Opens the Settings screen via the profile item's own cog, then returns via its "Back to
 * chat" button -- decision 29's Settings round trip: `App.tsx` remounts the whole session list
 * on this view swap, so this proves the collapse state survives that remount, not just a plain
 * re-render. */
export async function openSettingsAndReturn(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Returned from Settings to chat' });
}

/** Builds the genuinely mixed, non-default collapse state (gate round 1's own fix for "a build
 * that saves nothing would pass too") AND runs decision 29's two remaining live checks on top of
 * it: the Settings round trip and the prune. Repository A ends closed, Repository B stays open
 * (the default), Archived ends open holding the one Session (A2) archived here. Repository C
 * (empty, already collapsed by `runChecks`) is removed as the prune target. Returns
 * `{ repoARecord }` (from registry.json) so the caller's own final pre-quit settings.json
 * assertion does not need to re-derive it. */
export async function buildMixedStateAndCheckDecision29(cdp, log, { repoAName, repoBName, repoCName, repoADir, repoCDir, dataDir }) {
  await archiveFirstRowIn(cdp, repoAName);
  await cdp.waitFor(`${groupTriggerFinder(repoAName)} !== undefined`, { timeoutMs: 15_000, label: 'Repository A still rendered after archiving Session A2' });
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group re-mounted after archiving Session A2' });
  if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') {
    await cdp.click(ARCHIVED_TRIGGER_FINDER);
    await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened for the mixed-state proof' });
  }
  assertTrue((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Repository A must still be open right after archiving Session A2');
  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository A collapsed for the mixed-state proof' });
  assertTrue((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B must be open for the mixed-state proof');
  assertTrue((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Archived must be open for the mixed-state proof');
  const archivedRowCount = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] ul[aria-label="Archived sessions"] li').length`);
  assertTrue(archivedRowCount === 1, `Archived must list exactly the one Session (A2) kept archived (got: ${archivedRowCount})`);
  log('STEP PASS: built the mixed collapse state (Repository A closed, Repository B open, Archived open with one Session archived, Repository C still closed).');

  // Decision 29, check 1: the Settings round trip -- `App.tsx` remounts the whole session list
  // on this view swap.
  await openSettingsAndReturn(cdp);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 30_000, label: 'Repository A group re-rendered after the Settings round trip' });
  assertTrue((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed after the Settings round trip (nothing re-expanded)');
  assertTrue((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B must still be open after the Settings round trip');
  assertTrue((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Archived must still be open after the Settings round trip');
  assertTrue((await groupState(cdp, groupTriggerFinder(repoCName))) === 'closed', 'Repository C must still be closed after the Settings round trip');
  log('STEP PASS: decision 29 Settings round trip -- the mixed collapse state survived opening Settings and returning to chat (a full list remount).');

  // Decision 29, check 2: the prune -- Repository C owns zero Sessions and is already collapsed.
  const registryBeforeRemove = readJson(path.join(dataDir, 'registry.json'));
  const repoARecord = registryBeforeRemove.repositories.find((r) => r.path === repoADir || path.basename(r.path) === repoAName);
  const repoCRecord = registryBeforeRemove.repositories.find((r) => r.path === repoCDir || path.basename(r.path) === repoCName);
  assertTrue(repoARecord, `registry.json must contain Repository A (searched path ${repoADir})`);
  assertTrue(repoCRecord, `registry.json must contain Repository C (searched path ${repoCDir})`);
  await removeRepository(cdp, repoCName);
  await cdp.waitFor(groupTriggerFinder(repoCName) + ' === undefined', { timeoutMs: 15_000, label: 'Repository C group gone from the DOM after removal' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const settingsAfterPrune = readJson(path.join(dataDir, 'settings.json'));
  const collapseAfterPrune = settingsAfterPrune.sessionListCollapse;
  assertTrue(
    Array.isArray(collapseAfterPrune.collapsedRepositoryIds) && !collapseAfterPrune.collapsedRepositoryIds.includes(repoCRecord.id),
    `Repository C's id must be pruned from settings.json after removal (got: ${JSON.stringify(collapseAfterPrune.collapsedRepositoryIds)}, Repository C id: ${repoCRecord.id})`
  );
  assertTrue(
    collapseAfterPrune.collapsedRepositoryIds.includes(repoARecord.id) && collapseAfterPrune.archivedOpen === true,
    `Repository C's removal must not disturb Repository A's own collapsed id or Archived's open flag (got: ${JSON.stringify(collapseAfterPrune)})`
  );
  log(`STEP PASS: decision 29 prune -- removing Repository C (id ${repoCRecord.id}) dropped its id from settings.json on disk without disturbing Repository A's or Archived's own saved state.`);

  return { repoARecord };
}

/** Gate round 3 fixes, live (four independent reviewers): the "..." trigger's vertical centring
 * on line 1 (`top-1/2 -translate-y-1/2`, was `inset-y-0`), and decision 25's 220px narrow-width
 * minimum -- a flat `pr-28` on line 1 had starved the title to about five characters there; now
 * sized to the real content (`pr-10`/`pr-16`, wider under `[@media(hover:none)]`). Measures the
 * session-list panel dragged to its own `minSize={220}` floor (`App.tsx`), asserting the title
 * never overlaps the absolutely-positioned trailing group. The "with Resume" case (`pr-16`/
 * `pr-24`) is checked statically instead of live: `canResumeSession` (`shared/
 * canResumeSession.ts`) requires `stopReason: 'agent-exited'` or `terminatedUnexpectedly`,
 * never a deliberate Stop agent action (confirmed by reading that source and then by a live
 * attempt: Stop agent leaves `canResume` false, so no Resume button ever mounts) -- a genuinely
 * resumable Session needs an actual crash, which this harness's real-`omp` driver has no safe
 * way to simulate (the fake-omp engine's own `__exit__`/`exit.jsonl` crash directive exists for
 * exactly this, but is wired only into fake-omp-driven scripts, not this real-`omp` one).
 * Extracted from `verify-tauri-567.mjs` to keep it under the #806 600-line file-size cap. */
export async function proveCenteringAndNarrowWidth(cdp, log, { repoName, rowFinder }) {
  const resizeHandleFinder = `document.querySelector('[aria-label="Resize session list"]')`;
  async function dragResizeHandleBy(deltaX) {
    const rect = await cdp.waitFor(
      `(() => { const el = ${resizeHandleFinder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeoutMs: 10_000, label: 'session list resize handle' }
    );
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + (deltaX * i) / steps, y: rect.y, buttons: 1 });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + deltaX, y: rect.y, button: 'left' });
  }
  function measureLine1() {
    return cdp.evaluate(
      `(() => { const row = ${rowFinder}; const surface = row.querySelector(':scope > div'); const nameSpan = row.querySelector('.session-open-button > span:first-child span.truncate'); const trailingGroup = surface.querySelector('.absolute.right-2.top-1'); const sr = surface.getBoundingClientRect(); const nr = nameSpan.getBoundingClientRect(); const tr = trailingGroup ? trailingGroup.getBoundingClientRect() : null; return { surfaceWidth: sr.width, titleWidth: nr.width, overlap: tr ? nr.right > tr.left : false }; })()`
    );
  }
  await createSessionViaQuickCreate(cdp, repoName);
  const baselineWidth = await cdp.evaluate(`${rowFinder}.querySelector(':scope > div').getBoundingClientRect().width`);
  // Drag by exactly the measured amount needed to reach just above the 220px `minSize` floor --
  // a large, imprecise drag (for example -400px) overshoots the floor and triggers the panel's
  // own `collapsible`/`collapsedSize={0}` snap instead of clamping at 220px (gate round 3 fix,
  // live harness bug found while adding this check).
  await dragResizeHandleBy(-(baselineWidth - 230));
  await cdp.waitFor(
    `(() => { const w = ${rowFinder}.querySelector(':scope > div').getBoundingClientRect().width; return w > 150 && w < 250; })()`,
    { timeoutMs: 10_000, label: 'session list clamped near its 220px minSize floor (150-250px, not collapsed)' }
  );
  const narrowNoResume = await measureLine1();
  log(`verify-tauri-567: 220px-minimum measurement, no Resume: ${JSON.stringify(narrowNoResume)}`);
  assertTrue(!narrowNoResume.overlap, `the title must never overlap the trailing group at the 220px minimum, no Resume, got ${JSON.stringify(narrowNoResume)}`);
  assertTrue(narrowNoResume.titleWidth > 40, `the title must keep meaningfully more than decision 25's old ~36px floor without Resume, got ${narrowNoResume.titleWidth}px`);
  log('STEP PASS: line 1 never overlaps the trailing group at the 220px minimum (no Resume, live-measured).');

  // Static check for the "with Resume" sizing (see the function's own doc comment for why this
  // is not live): confirms `pr-16`/`pr-24` actually compiled into the running bundle's CSS at
  // the expected pixel values, rather than merely trusting the source literal.
  const resumePaddingRules = await cdp.evaluate(
    `(() => { const out = []; function walk(rules) { for (const rule of rules || []) { if (!rule.media && rule.selectorText === '.pr-16') out.push({ selector: rule.selectorText, media: null, css: rule.style.cssText }); if (rule.media && /hover\\s*:\\s*none/.test(rule.media.mediaText)) { for (const inner of rule.cssRules || []) { if (inner.selectorText && inner.selectorText.endsWith('pr-24')) out.push({ selector: inner.selectorText, media: rule.media.mediaText, css: inner.style.cssText }); } } if (rule.cssRules) walk(rule.cssRules); } } for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} } return out; })()`
  );
  log(`verify-tauri-567: static pr-16/pr-24 rules: ${JSON.stringify(resumePaddingRules)}`);
  const pr16 = resumePaddingRules.find((r) => r.selector === '.pr-16' && !r.media);
  const pr24 = resumePaddingRules.find((r) => r.selector.endsWith('pr-24') && r.media && /hover\s*:\s*none/.test(r.media));
  assertTrue(pr16 && /calc\(var\(--spacing\)\s*\*\s*16\)/.test(pr16.css), `.pr-16 (the "with Resume" hover:hover reservation) must compile to 16 spacing units (64px), got ${JSON.stringify(pr16)}`);
  assertTrue(pr24 && /calc\(var\(--spacing\)\s*\*\s*24\)/.test(pr24.css), `the (hover:none) "with Resume" reservation must compile to 24 spacing units (96px), got ${JSON.stringify(pr24)}`);
  log('STEP PASS (code-verified, not live-driven -- see the function\'s own comment above): the "with Resume" pr-16/pr-24 reservations compiled to the expected 64px/96px.');

  // Vertical centring (gate round 3 fix, Low): the "..." trigger used to hang about 4px below
  // line 1's own centre (`inset-y-0` stretching a `size-6` button inside a shorter `min-h-4`
  // cell, top-anchored); now `top-1/2 -translate-y-1/2`, measured against line 1's own icon/
  // title span (always visible, unlike the time it replaces on hover).
  const rowRect = await cdp.waitFor(
    `(() => { const el = ${rowFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${rowFinder}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
  const ellipsisFinder = `${rowFinder}.querySelector('button[aria-label$="actions"]')`;
  await cdp.waitFor(`getComputedStyle(${ellipsisFinder}).opacity > 0.5`, { timeoutMs: 5_000, label: '"..." visible before centring measurement' });
  const centering = await cdp.evaluate(
    `(() => { const btn = ${ellipsisFinder}; const line1 = ${rowFinder}.querySelector('.session-open-button > span:first-child'); const br = btn.getBoundingClientRect(); const lr = line1.getBoundingClientRect(); const buttonCentre = br.top + br.height / 2; const line1Centre = lr.top + lr.height / 2; return { buttonCentre, line1Centre, deltaPx: Math.abs(buttonCentre - line1Centre) }; })()`
  );
  log(`verify-tauri-567: "..." vertical centring vs line 1: ${JSON.stringify(centering)}`);
  assertTrue(centering.deltaPx <= 1, `the "..." trigger must sit within 1px of line 1's own vertical centre (gate round 3 fix, Low), measured delta=${centering.deltaPx}px`);
  log('STEP PASS: the "..." trigger is vertically centred on line 1 within 1px (gate round 3 fix, live-verified).');

  // Restore the session list to its normal width before the theme screenshots below.
  await dragResizeHandleBy(400);
  await cdp.waitFor(`${rowFinder}.querySelector(':scope > div').getBoundingClientRect().width > 250`, { timeoutMs: 10_000, label: 'session list restored to normal width' });
}

// Issue #559's own session search field -- generic markers any future session-list live check
// can reuse without re-deriving the selector (#806 file-size split: moved out of
// `verify-tauri-559.mjs` once it grew past the cap, gate round 2). Gate round 3 fix (finding
// 11): the SAME `data-session-search-input` attribute the real app's own `SessionList.tsx`
// (`inputProps`) and `quickCreateFallback.ts`/`useFocusSearchOnStrandedUnmount.ts`
// (`sessionSearchSelector.ts`'s `SESSION_SEARCH_INPUT_SELECTOR`) already use, not a
// descendant-structure lookup through the region wrapper that could drift from the app's own
// selector unnoticed.
export const SEARCH_INPUT_FINDER = `document.querySelector('[data-session-search-input]')`;

/** Types into the search field via a real click plus `Input.insertText`. Clears any EXISTING
 *  text first via real key events (Ctrl+A then Backspace) -- `Input.insertText` only ever
 *  INSERTS at the caret, so two calls in a row would otherwise silently concatenate onto
 *  whatever a previous step left behind, not replace it. */
export async function typeIntoSessionSearch(cdp, text) {
  await cdp.click(SEARCH_INPUT_FINDER);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select all existing text
  await pressKey(cdp, 8, 'Backspace', 'Backspace'); // delete the selection
  await cdp.waitFor(SEARCH_INPUT_FINDER + `.value === ''`, { timeoutMs: 5_000, label: 'search field cleared before typing' });
  await cdp.send('Input.insertText', { text });
}

/** Finds a Session row's own open button by the START of its accessible name (the display name,
 *  before the first comma -- see `SessionRow.tsx`'s own `aria-label` convention). */
export function sessionOpenButtonFinder(name) {
  return `Array.from(document.querySelectorAll('[data-repository-id] li [data-session-open]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(name)}))`;
}

/** Renames a Session via F2 (real key events throughout): focuses `currentFinder` (an
 *  open-button finder expression, e.g. from `sessionOpenButtonFinder`), presses F2, clears the
 *  rename input (Ctrl+A, Backspace), types `newName`, and commits with Enter. */
export async function renameSessionViaF2(cdp, currentFinder, newName) {
  await cdp.evaluate(`(${currentFinder})?.focus()`);
  await cdp.waitFor(`document.activeElement === (${currentFinder})`, { timeoutMs: 5_000, label: `open button focused before renaming to ${JSON.stringify(newName)}` });
  await pressKey(cdp, 113, 'F2', 'F2');
  await cdp.waitFor(`!!document.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 5_000, label: 'rename input mounted after F2' });
  await cdp.click(`document.querySelector('input[aria-label="Session name"]')`);
  await pressKey(cdp, 65, 'a', 'KeyA', 2);
  await pressKey(cdp, 8, 'Backspace', 'Backspace');
  await cdp.send('Input.insertText', { text: newName });
  await pressKey(cdp, 13, 'Enter', 'Enter'); // commits
}

/** Issue #559 gate round 2 (ui-architect-v3/a11y-auditor High/Medium), all from one setup. A1's
 *  own branch still equals `sessionA1Name` (spec 001 Assumptions: "the same generated name is
 *  used for the session's branch and as its initial display name"; renaming never changes it).
 *  Renaming A1 ONCE decouples name from branch, so searching the ORIGINAL value afterward can
 *  only match via BRANCH -- real proof of decision 12's "name OR branch OR Project name" rule,
 *  not a coincidence of the two being identical, and the same query upper-cased proves case-
 *  insensitivity. A SECOND rename, to something matching neither the new name, the unchanged
 *  branch, nor either Project's own name, makes the row (and Project A, its own only remaining
 *  match) actually unmount -- proving the #900 focus-redirect fix (`useSessionRowActions.ts`'s
 *  `useLayoutEffect` cleanup) moves focus to the search field, never `<body>`. Finally proves
 *  the query survives switching to Project B's own open Session, not just a Settings round
 *  trip. Returns the Session's final name, reused by the caller for an Archived-reverse check
 *  afterward. */
export async function proveRenameMatchingAndSessionSwitch(cdp, log, { repoAName, repoBName, sessionA1Name, CLEAR_BUTTON }) {
  await renameSessionViaF2(cdp, sessionOpenButtonFinder(sessionA1Name), 'alpha-renamed-once');
  const renamedOnceFinder = sessionOpenButtonFinder('alpha-renamed-once');
  await cdp.waitFor(renamedOnceFinder + ' !== undefined', { timeoutMs: 15_000, label: 'Session A1 shows its new name after the first rename' });

  await typeIntoSessionSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A still matches its own renamed Session by BRANCH' });
  let rows = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id] li')).map((el) => el.textContent).join('|')`);
  assertTrue(rows.includes('alpha-renamed-once'), `the renamed row must still show, matching via its unchanged branch (got ${JSON.stringify(rows)})`);
  log(`STEP PASS: branch matching -- Session A1, renamed to "alpha-renamed-once", still matches a query for its own unchanged branch ("${sessionA1Name}").`);

  await typeIntoSessionSearch(cdp, sessionA1Name.toUpperCase());
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'an upper-cased query still matches (case-insensitive)' });
  rows = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id] li')).map((el) => el.textContent).join('|')`);
  assertTrue(rows.includes('alpha-renamed-once'), `an upper-cased query must match case-insensitively (got ${JSON.stringify(rows)})`);
  log('STEP PASS: case-insensitive matching confirmed with an upper-cased query.');

  await typeIntoSessionSearch(cdp, 'alpha-renamed-once');
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A matches its own just-renamed Session by NAME' });
  const renamedTwiceName = 'zzz-unmatched-after-second-rename-zzz';
  await renameSessionViaF2(cdp, renamedOnceFinder, renamedTwiceName);
  await cdp.waitFor(`document.activeElement === (${SEARCH_INPUT_FINDER})`, {
    timeoutMs: 15_000,
    label: 'focus redirected to the search field once the renamed row (and its own now-matchless Project) unmounts (#900 pattern)'
  });
  assertTrue((await cdp.evaluate(groupTriggerFinder(repoAName) + ' === undefined')) === true, 'Project A must actually be gone -- its only Session no longer matches by name, branch, or Project name');
  log('STEP PASS: renaming a Session out of the active filter (new name matching neither name, branch, nor Project) moves focus to the search field instead of <body>, once the row and its now-matchless Project actually unmount.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the rename-focus check' });

  await typeIntoSessionSearch(cdp, repoBName);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' === undefined', { timeoutMs: 10_000, label: 'Project A hidden before the Session-switch check' });
  const projectBOpenButtonFinder = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoBName)}))?.querySelector('li [data-session-open]')`;
  await cdp.click(projectBOpenButtonFinder);
  await cdp.waitFor(`(${projectBOpenButtonFinder})?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: "Project B's own Session opened (switched to)" });
  assertTrue((await cdp.evaluate(SEARCH_INPUT_FINDER + '.value')) === repoBName, 'the query text must survive switching to a different Session, not just a Settings round trip');
  log('STEP PASS: the search query survives switching to a different open Session.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the Session-switch check' });

  return { renamedTwiceName };
}

/** Issue #559 gate round 3 (ui-architect-v3 finding 1): the Project half of the #900 focus-
 *  redirect fix -- a rename that makes a WHOLE Project group stop matching an active
 *  Project-NAME query (the only way renaming can make a group, not just one row, its own sole
 *  match) unmounts the group on a later render; proves `RepositoryGroup.tsx`'s own
 *  `useFocusSearchOnStrandedUnmount(groupRootRef)` call moves focus to the search field, the
 *  same as the Session row's own half already proved by `proveRenameMatchingAndSessionSwitch`
 *  above. Renames `repoBName`'s own Project permanently (nothing after this call in
 *  `verify-tauri-559.mjs` depends on that name any more). */
export async function proveProjectRenameFocusRedirect(cdp, log, { repoBName }) {
  await typeIntoSessionSearch(cdp, repoBName);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B matches its own Project-name query before the Project-rename check' });
  const triggerFinder = groupTriggerFinder(repoBName);
  await cdp.evaluate(`(${triggerFinder})?.focus()`);
  await cdp.waitFor(`document.activeElement === (${triggerFinder})`, { timeoutMs: 5_000, label: 'Project B trigger focused before renaming' });
  await pressKey(cdp, 113, 'F2', 'F2');
  await cdp.waitFor(`!!document.querySelector('input[aria-label="Project name"]')`, { timeoutMs: 5_000, label: 'repository rename input mounted after F2' });
  await cdp.click(`document.querySelector('input[aria-label="Project name"]')`);
  await pressKey(cdp, 65, 'a', 'KeyA', 2);
  await pressKey(cdp, 8, 'Backspace', 'Backspace');
  await cdp.send('Input.insertText', { text: 'zzz-project-renamed-out-of-filter-zzz' });
  await pressKey(cdp, 13, 'Enter', 'Enter');
  await cdp.waitFor(`document.activeElement === (${SEARCH_INPUT_FINDER})`, {
    timeoutMs: 15_000,
    label: 'focus redirected to the search field once the renamed Project (and its whole group) unmounts (#900 pattern, Project half)'
  });
  assertTrue((await cdp.evaluate(groupTriggerFinder(repoBName) + ' === undefined')) === true, 'Project B must actually be gone -- its new name no longer matches the active Project-name query');
  log('STEP PASS: renaming a Project out of the active filter (a Project-name query) moves focus to the search field instead of <body>, once the whole group actually unmounts.');
  await typeIntoSessionSearch(cdp, '');
}

/** Issue #559 gate round 3 (ui-architect-v3 finding 5): proves the hidden-create announcement
 *  live -- creates a Session from a VISIBLE Project's own quick-create "+" while a query
 *  matching only an existing row (never the Project's own name) is active, so the new Session's
 *  own generated name matches neither the query, its branch, nor the Project name, and must be
 *  announced as hidden rather than silently dropped. Uses the bare `clickQuickCreate` (not
 *  `createSessionViaQuickCreate`), which waits for a new ROW to appear -- it never would here,
 *  by design -- confirming success via the composer enabling and the announcement text itself
 *  instead. */
export async function proveCreatedSessionHiddenAnnouncement(cdp, log, { repoAName, query, chatAreaAnnounceRegionFinder }) {
  await typeIntoSessionSearch(cdp, query);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A visible for the hidden-create announcement check' });
  await clickQuickCreate(cdp, repoAName);
  await cdp.waitFor(`(() => { const msg = document.querySelector('[aria-label="Message"]'); return !!msg && !msg.disabled; })()`, { timeoutMs: 60_000, label: 'new Session created (composer enabled), even though hidden by the filter' });
  const text = await cdp.waitFor(
    `(() => { const t = (${chatAreaAnnounceRegionFinder})?.textContent?.trim() || ''; return /hidden by the session filter/.test(t) ? t : false; })()`,
    { timeoutMs: 10_000, label: 'announcer reads "Created session ..., hidden by the session filter"' }
  );
  log(`STEP PASS: creating a Session from a visible Project's own quick-create "+" while active query does not match it announces ${JSON.stringify(text)}.`);
  await typeIntoSessionSearch(cdp, '');
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the hidden-create announcement check' });
}
