// Session-list CDP driving helpers shared by `verify-tauri-735.mjs` and other session-list live checks; depends only on a `CdpSession`-shaped `cdp`.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function assertTrue(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Proves the trailing slot's opacity swap (time at rest, "..." trigger on hover) and statically that a `@media(hover:none)` rule keeps the trigger tappable. */
export async function proveTrailingSlotSwapAndHoverNone(cdp, evidenceDir, log, { rowFinder, ellipsisFinder }) {
  // Also clears keyboard focus: `group-focus-within` would otherwise keep the "..." visible after the preceding Shift+Tab check.
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

  // `Emulation.setEmulatedMedia` is accepted by WebView2 but has no effect (`matchMedia('(hover: none)')` stays false), so a live touch
  // proof is impossible; instead assert the bundled CSS has a `hover: none` rule setting `pointer-events: auto` on this button.
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

/** Computed accessible name (CDP Accessibility domain, not textContent) of the first element matching `finderExpr`; `null` when none or no AX node. */
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

/** Moves a real pointer over the element's centre without clicking, the only way to trigger a `:hover`/`group-hover` reveal over CDP. */
export async function hoverRow(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
}

/** Real keydown/keyup pair; Chromium needs both `key` and `code` set, not just `windowsVirtualKeyCode`. `modifiers` is CDP's bitmask (Shift=8). */
export async function pressKey(cdp, windowsVirtualKeyCode, key, code, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode, key, code, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode, key, code, modifiers });
}

/** Real right-click at the element's centre, the way to fire a native `contextmenu` event over CDP. */
export async function rightClick(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `right-click target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
}

export function groupTriggerFinder(repoName) {
  // A Tooltip (`asChild`) overwrites the trigger's `data-slot`/`data-state`, so key off `aria-label` and `aria-expanded`. Archived has no tooltip, so its `data-slot` is intact.
  return `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(repoName)}))`;
}
export const ARCHIVED_TRIGGER_FINDER = `document.querySelector('[data-archived-group] [data-slot="collapsible-trigger"]')`;

export async function groupState(cdp, finderExpr) {
  return cdp.evaluate(`(() => { const el = ${finderExpr}; if (!el) return null; return el.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'; })()`);
}

/** Whether the group's 2px `bg-active-indicator` header bar is in the DOM; an archived Session must never leave it on its old Repository's header. */
export async function hasActiveBar(cdp, repoName) {
  return cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); return !!group?.querySelector('[class*="bg-active-indicator"]'); })()`
  );
}
export async function archivedHasActiveBar(cdp) {
  return cdp.evaluate(`!!document.querySelector('[data-archived-group] [class*="bg-active-indicator"]')`);
}

export async function clickQuickCreate(cdp, repoName) {
  // The "+" stays rendered while the group is collapsed; only the row list is conditionally mounted.
  const finder = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('[data-quick-create-session]')`;
  await cdp.click(finder);
}

/** Clicks the header "+" and waits for both a new row and the enabled composer; the composer alone passes even if the click was dropped (e.g. by the in-flight `creatingRepositoryIds` guard). */
export async function createSessionViaQuickCreate(cdp, repoName) {
  const rowSelector = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelectorAll('li').length ?? 0`;
  const before = await cdp.evaluate(rowSelector);
  await clickQuickCreate(cdp, repoName);
  await cdp.waitFor(
    `(() => { const count = ${rowSelector}; const msg = document.querySelector('[aria-label="Message"]'); return count > ${before} && !!msg && !msg.disabled; })()`,
    { timeoutMs: 60_000, label: `Session created in ${repoName} (row count ${before} -> ${before + 1}), composer enabled` }
  );
}

/** Finder for the first (most recent) Session row's "..." trigger in the named Project's group. */
export function firstRowActionsFinder(repoName) {
  return `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button[aria-label^="More actions for "]')`;
}

/** Opens a row's "..." menu like a real user: the trigger is revealed by `group-hover`/`group-focus-within`, so a bare click can land before the hover style recalculates. Hovers first, waits for the trigger to be revealed and closed, clicks at a freshly computed rect (hover can shift layout), then waits for the menu; screenshots on timeout. */
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

/** Archives the first (most recent) Session row in the Repository group's list via its row menu. */
export async function archiveFirstRowIn(cdp, repoName) {
  await cdp.click(
    `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button[aria-label^="More actions for "]')`
  );
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'Row menu open with Archive item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
}

/** Restores the only Session row in Archived via its row menu, opening Archived first if closed. */
export async function restoreOnlyArchivedRow(cdp) {
  if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') {
    await cdp.click(ARCHIVED_TRIGGER_FINDER);
    await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened to reach the restore action' });
  }
  await cdp.click(`document.querySelector('[data-archived-group]')?.querySelector('li button[aria-label^="More actions for "]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`, { timeoutMs: 10_000, label: 'Archived row menu open with Restore item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`);
}

/** Adds a scratch repository via the Readiness screen's primary button (empty profile) or the list footer's "Add project" menu (Local folder…). */
export async function addRepository(cdp, dir) {
  await cdp.click(
    `document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project')`
  );
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Local folder…')`, { timeoutMs: 10_000, label: 'Add project menu open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Local folder…')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: dir });
  await cdp.clickByText('Add project', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'Add repository dialog closed' });
}

/** Removes an empty Repository via its header menu and the confirmation dialog; the prune check proves its id leaves `settings.json`, not just the renderer. */
export async function removeRepository(cdp, repoName) {
  await cdp.click(`document.querySelector('[aria-label=${JSON.stringify(`More actions for ${repoName}`)}]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`, {
    timeoutMs: 10_000,
    label: 'Row menu open with Remove project item'
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Remove project…')`);
  await cdp.waitFor(`!!document.querySelector('[data-slot="alert-dialog-content"]')`, { timeoutMs: 10_000, label: 'Remove project dialog open' });
  await cdp.click(`Array.from(document.querySelectorAll('[data-slot="alert-dialog-action"]')).find((el) => el.textContent.trim() === 'Remove')`);
  await cdp.waitFor(`!document.querySelector('[data-slot="alert-dialog-content"]')`, { timeoutMs: 15_000, label: 'Remove project dialog closed' });
}

/** Opens Settings via the profile cog and returns via "Back to chat"; `App.tsx` remounts the session list on the swap, so collapse state must survive a remount. */
export async function openSettingsAndReturn(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Returned from Settings to chat' });
}

/** Builds a mixed, non-default collapse state (so a build that saves nothing fails), then runs the Settings round trip and the prune. A closed, B open, Archived open with A2; C is removed. Returns `{ repoARecord }` from registry.json. */
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

  // Settings round trip: `App.tsx` remounts the whole session list on the view swap.
  await openSettingsAndReturn(cdp);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 30_000, label: 'Repository A group re-rendered after the Settings round trip' });
  assertTrue((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed after the Settings round trip (nothing re-expanded)');
  assertTrue((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B must still be open after the Settings round trip');
  assertTrue((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Archived must still be open after the Settings round trip');
  assertTrue((await groupState(cdp, groupTriggerFinder(repoCName))) === 'closed', 'Repository C must still be closed after the Settings round trip');
  log('STEP PASS: decision 29 Settings round trip -- the mixed collapse state survived opening Settings and returning to chat (a full list remount).');

  // Prune: Repository C owns zero Sessions and is already collapsed.
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

/** Live check at the panel's 220px `minSize` floor that the "..." trigger is vertically centred on line 1 and the title never overlaps the trailing group.
 * The "with Resume" sizing (`pr-16`/`pr-24`) is checked statically: a resumable Session needs `stopReason: 'agent-exited'` or
 * `terminatedUnexpectedly` (`canResumeSession.ts`), and this real-`omp` harness has no safe way to simulate a crash. */
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
  // A large drag overshoots the 220px floor and triggers the `collapsedSize={0}` snap, so drag the exact amount.
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

  // Static check: confirms `pr-16`/`pr-24` compiled into the running bundle's CSS.
  const resumePaddingRules = await cdp.evaluate(
    `(() => { const out = []; function walk(rules) { for (const rule of rules || []) { if (!rule.media && rule.selectorText === '.pr-16') out.push({ selector: rule.selectorText, media: null, css: rule.style.cssText }); if (rule.media && /hover\\s*:\\s*none/.test(rule.media.mediaText)) { for (const inner of rule.cssRules || []) { if (inner.selectorText && inner.selectorText.endsWith('pr-24')) out.push({ selector: inner.selectorText, media: rule.media.mediaText, css: inner.style.cssText }); } } if (rule.cssRules) walk(rule.cssRules); } } for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} } return out; })()`
  );
  log(`verify-tauri-567: static pr-16/pr-24 rules: ${JSON.stringify(resumePaddingRules)}`);
  const pr16 = resumePaddingRules.find((r) => r.selector === '.pr-16' && !r.media);
  const pr24 = resumePaddingRules.find((r) => r.selector.endsWith('pr-24') && r.media && /hover\s*:\s*none/.test(r.media));
  assertTrue(pr16 && /calc\(var\(--spacing\)\s*\*\s*16\)/.test(pr16.css), `.pr-16 (the "with Resume" hover:hover reservation) must compile to 16 spacing units (64px), got ${JSON.stringify(pr16)}`);
  assertTrue(pr24 && /calc\(var\(--spacing\)\s*\*\s*24\)/.test(pr24.css), `the (hover:none) "with Resume" reservation must compile to 24 spacing units (96px), got ${JSON.stringify(pr24)}`);
  log('STEP PASS (code-verified, not live-driven -- see the function\'s own comment above): the "with Resume" pr-16/pr-24 reservations compiled to the expected 64px/96px.');

  // Vertical centring is measured against line 1's icon/title span, which is always visible (unlike the time it replaces on hover).
  const rowRect = await cdp.waitFor(
    `(() => { const el = ${rowFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${rowFinder}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
  const ellipsisFinder = `${rowFinder}.querySelector('button[aria-label^="More actions for "]')`;
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

// Matches the app's own `data-session-search-input` attribute (`SESSION_SEARCH_INPUT_SELECTOR`) so the selector cannot drift unnoticed.
export const SEARCH_INPUT_FINDER = `document.querySelector('[data-session-search-input]')`;

/** Types into the search field via a real click plus `Input.insertText`; clears first because `insertText` only inserts at the caret. */
export async function typeIntoSessionSearch(cdp, text) {
  await cdp.click(SEARCH_INPUT_FINDER);
  await pressKey(cdp, 65, 'a', 'KeyA', 2); // Ctrl+A: select all existing text
  await pressKey(cdp, 8, 'Backspace', 'Backspace'); // delete the selection
  await cdp.waitFor(SEARCH_INPUT_FINDER + `.value === ''`, { timeoutMs: 5_000, label: 'search field cleared before typing' });
  await cdp.send('Input.insertText', { text });
}

/** Finds a Session row's open button by the start of its accessible name (the display name before the first comma). */
export function sessionOpenButtonFinder(name) {
  return `Array.from(document.querySelectorAll('[data-repository-id] li [data-session-open]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(name)}))`;
}

/** Renames a Session via F2 with real key events: focuses `currentFinder`, clears the input, types `newName`, commits with Enter. */
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

/** Rename matching: after one rename the old value matches only via branch (proving name OR branch OR Project name, case-insensitively); a second non-matching rename unmounts the row and focus must move to the search field (#900), never `<body>`. The query must also survive switching Sessions. Returns the final name. */
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

/** Project half of the #900 focus fix: a rename that makes a whole Project group stop matching the query must move focus to the search field. Renames `repoBName`'s Project permanently. */
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

/** Hidden-create announcement: a new Session that matches no active query must be announced as hidden. Uses bare `clickQuickCreate` because no new row ever appears here; confirms via the composer and the announcement text. */
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
