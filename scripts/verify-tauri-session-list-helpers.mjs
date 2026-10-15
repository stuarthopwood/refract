// Session-list-specific CDP driving helpers shared by `verify-tauri-735.mjs` (and any future
// session-list live-check script) -- extracted from that file to keep it under the #806 600-line
// file-size cap (`scripts/check-file-size.mjs`). Depends only on a `CdpSession`-shaped `cdp`
// (see `verify-tauri-cdp.mjs`), never on anything specific to the #735 story itself.

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
