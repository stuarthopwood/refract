#!/usr/bin/env node
// Split out of verify-tauri-499-930.mjs (#806 file-size cap, caught live 2026-10-18 during gate
// round 1 on PR #953 -- the main script crossed 600 lines adding the round's own live checks).
// Kept alongside (not folded into) verify-tauri-scratch-helpers.mjs/verify-tauri-cdp.mjs: these
// are specific to THIS story's own live check, not generic across every verify-tauri-*.mjs --
// the bundle marker string, the scratch clone URL, and the resize handle's own drag simulation
// all name #499/#930 directly.
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { waitForCdpTarget, CdpSession, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';

const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

export async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-499-930: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Clones `stuarthopwood/refract` itself, shallow and read-only, into `dir` -- real PR data
 * without ever writing to a real repository. Returns `null` (never throws) if the clone fails
 * (offline, rate-limited) so the caller fails the run loudly instead of faking a pass. */
export function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-499-930: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

/** Asserts a #499/#930-only marker exists in the built renderer bundle, per
 * `refract-ui-lane-gate-checklist`'s own rule, before trusting anything else. Two independent,
 * story-only literals (never introduced by any other issue): the Filters disclosure's own
 * fixed element id, and the resize handle's own accessible name. `repoRoot` is the caller's own
 * `REPO_ROOT` -- this file has no `import.meta.url` of its own worth resolving a bundle path from. */
export function assertBundleContainsStory499930Marker(repoRoot) {
  const bundleRoot = path.join(repoRoot, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-tauri-499-930: no built renderer bundle at ${bundleRoot} -- run \`pnpm tauri build --debug --no-bundle\` first (the exe build below rebuilds it, but this static check runs before launch).`);
  }
  const grep = spawnSync_('node', ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    function* walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); }
        else if (entry.name.endsWith('.js')) yield full;
      }
    }
    let found = false;
    for (const file of walk(${JSON.stringify(bundleRoot)})) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('pull-request-filters-panel') && text.includes('Resize pull request list')) { found = true; break; }
    }
    console.log(found ? 'FOUND' : 'MISSING');
  `]);
  assert(grep.stdout.includes('FOUND'), '#499/#930-only marker (Filters panel id + resize handle aria-label) not found in the built renderer bundle -- the exe under test may not actually contain this story\'s code');
}

/** Real pointer drag of the resize handle (CDP `Input.dispatchMouseEvent` press/move/release --
 * no library drag helper exists in this harness; a bare click/release pair never engages
 * `react-resizable-panels`' own pointer-drag state machine the way a real OS drag does). Moves
 * in several small steps, matching how a real user's pointer is sampled, not one large jump.
 * Mirrors `verify-tauri-session-list-helpers.mjs`'s own `dragResizeHandleBy`: an initial hover
 * `mouseMoved` (no button) before the press, then each drag-step `mouseMoved` carries `buttons:
 * 1` (the bitmask of currently-held buttons CDP uses to synthesize a real `pointermove` with
 * the button still down) -- NOT `button: 'left'` (CDP's singular `button` field only names
 * which button triggered a press/release/click event; passing it on `mouseMoved` leaves no
 * button recorded as held, so `react-resizable-panels`' `pointermove` listener sees an
 * unpressed hover and ignores it for resizing, the bug that shipped here first). */
export async function dragHandleBy(cdp, handleFinderExpr, deltaX) {
  const rect = await cdp.evaluate(`(() => { const el = ${handleFinderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  assert(rect, `resize handle not found for drag: ${handleFinderExpr}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = rect.x + (deltaX * i) / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: rect.y, buttons: 1 });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + deltaX, y: rect.y, button: 'left', clickCount: 1 });
}

/** Clicks tab `tabLabel`, optionally opens the State select and picks `optionLabel`, then waits
 * until loading has finished AND the rendered rows genuinely reflect it -- no stale Open/Draft
 * row survives, at least one Closed/Merged row does, and the Filters label counts it. Gate-fix
 * (C1, test-reviewer Critical, round 2): `setStateFilter` updates the label SYNCHRONOUSLY while
 * `refresh()` keeps the OLD (stale, still-Open) rows mounted until the fetch resolves -- waiting
 * on `rows.length > 0` alone (the previous version of this check) passed on those stale rows
 * every time. Reads each row's exact state via `data-pr-state` (`PullRequestRow.tsx`, round 3
 * gate-fix -- a class-based inner-span text scrape matched the row's own PARENT container too,
 * since CSS class selectors only require the listed classes to be a SUBSET, and being the parent
 * it then sorted FIRST in `querySelectorAll`'s document order; a real data attribute removes the
 * ambiguity entirely). `requireSingleAuthor` (round 3, Code Medium): a relation tab (Authored by
 * me) settling to the SAME shape (no Open/Draft, some Closed/Merged) the previous `All` tab call
 * already satisfied is not proof the tab switch itself took effect -- also requires every row's
 * `data-pr-author` to be the one, same login, which `All` (typically multi-author) would not be.
 * Returns the settled `{ rows, label, authors }` or `null` on timeout. */
export async function driveStateFilter(cdp, tabLabel, optionLabel, { requireSingleAuthor = false } = {}) {
  await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === ${JSON.stringify(tabLabel)})`);
  if (optionLabel) {
    // Gate-fix (round 3, caught live): a caller may run with the Filters section already
    // closed (an earlier check in the same run can leave it either way) -- the State select
    // only exists in the DOM while open, so a bare click used to hang on a null target and
    // crash the whole run with an uncaught timeout, not a graceful checkFail.
    const panelOpen = await cdp.evaluate(`!!document.getElementById('pull-request-filters-panel')`);
    if (!panelOpen) {
      await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))`);
      await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters panel opens for driveStateFilter' }).catch(() => false);
    }
    await cdp.click(`document.querySelector('[aria-label="State"]')`);
    await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === ${JSON.stringify(optionLabel)})`);
  }
  return cdp.waitFor(`(() => {
    const loadingNow = document.querySelector('[aria-label="Refresh pull requests"]')?.getAttribute('aria-disabled') === 'true';
    if (loadingNow) return false;
    const rows = Array.from(document.querySelectorAll('[data-pr-row]'));
    if (rows.length === 0) return false;
    const states = rows.map((r) => r.getAttribute('data-pr-state'));
    const hasOpenOrDraft = states.some((s) => s === 'open' || s === 'draft');
    const hasClosedOrMerged = states.some((s) => s === 'closed' || s === 'merged');
    const authors = [...new Set(rows.map((r) => r.getAttribute('data-pr-author')))];
    if (${requireSingleAuthor} && authors.length !== 1) return false;
    const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'));
    if (hasOpenOrDraft || !hasClosedOrMerged || btn?.getAttribute('aria-label') !== 'Filters, 1 active') return false;
    return { rows: rows.length, label: btn.getAttribute('aria-label'), authors };
  })()`, { timeoutMs: 15_000, label: `State on ${tabLabel} tab settles to real, non-stale rows` }).catch(() => null);
}

/** Diagnostic snapshot for a `driveStateFilter` timeout -- a never-settling wait (no Closed/
 * Merged row ever appears) is a real product/data gap, not a script bug, surfaced here rather
 * than silently passed on stale rows. */
export async function stateFilterDiagnostic(cdp) {
  return cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-pr-row]'));
    return { loading: document.querySelector('[aria-label="Refresh pull requests"]')?.getAttribute('aria-disabled'), rowCount: rows.length, states: rows.map((r) => r.getAttribute('data-pr-state')), authors: [...new Set(rows.map((r) => r.getAttribute('data-pr-author')))] };
  })()`);
}

/** Gate-fix (round 3, item 8, Code Medium -- see `PullRequestsView.tsx`'s own M3/item-2 fix): a
 * double-click on the SESSION-LIST's own handle (a sibling Group entirely, not a descendant of
 * the Pull Requests view) used to persist 320px for the PR column too -- the library's dblclick
 * hit-testing is shared across every Group on the page (its own ~10px hit region reaches ~5px
 * into this column), so it can set `defaultPrevented` on the bubbling event for an UNRELATED
 * Group's own reset. Confirms neither the PR column's own rendered width nor its persisted
 * `settings.json` value changed. Returns `{ pass, detail }`. */
export async function checkSidebarDblClickDoesNotAffectPrColumn(cdp, listPanelFinder) {
  const before = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  const rect = await cdp.evaluate(`(() => { const el = document.querySelector('[aria-label="Resize session list"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) return { pass: false, detail: 'session-list handle not found' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
  await sleep(700);
  const after = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  const persisted = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
  const detail = { prWidthBeforeSidebarDblClick: before, prWidthAfterSidebarDblClick: after, persistedAfterSidebarDblClick: persisted };
  const pass = before != null && after != null && Math.abs(after - before) <= 1 && persisted != null && Math.abs(persisted - before) <= 1;
  return { pass, detail };
}
