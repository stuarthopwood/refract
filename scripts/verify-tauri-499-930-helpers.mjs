#!/usr/bin/env node
// Helpers split out of verify-tauri-499-930.mjs (#806 file-size cap); specific to #499/#930, so not folded into the generic verify-tauri-* helpers.
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

/** Shallow read-only clone of `stuarthopwood/refract` into `dir` for real PR data; returns `null` on failure so the caller fails loudly. */
export function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-499-930: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

/** Asserts two #499/#930-only literals (the Filters disclosure id and the resize handle's accessible name) exist in the built bundle; `repoRoot` locates it. */
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

/** Real pointer drag of the resize handle via CDP: a hover `mouseMoved` first, then small steps carrying `buttons: 1`.
 * `button: 'left'` on `mouseMoved` records no held button, so `react-resizable-panels` ignores the move as a hover. */
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

/** Clicks tab `tabLabel`, optionally picks `optionLabel` in the State select, then waits until rows genuinely reflect it (no stale Open/Draft row, some Closed/Merged, label counts it).
 * `setStateFilter` updates the label synchronously while `refresh()` keeps stale rows mounted, so `rows.length > 0` alone passed on stale rows.
 * Reads state via `data-pr-state` (a class-based scrape also matched the parent container). `requireSingleAuthor` also requires one shared `data-pr-author`, since a relation tab can settle to the same shape as `All`.
 * Returns the settled `{ rows, label, authors }` or `null` on timeout. */
export async function driveStateFilter(cdp, tabLabel, optionLabel, { requireSingleAuthor = false } = {}) {
  await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === ${JSON.stringify(tabLabel)})`);
  if (optionLabel) {
    // The State select exists only while Filters is open, and an earlier check may leave it closed.
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

/** Diagnostic snapshot for a `driveStateFilter` timeout: a never-settling wait is a real product/data gap, not a script bug. */
export async function stateFilterDiagnostic(cdp) {
  return cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-pr-row]'));
    return { loading: document.querySelector('[aria-label="Refresh pull requests"]')?.getAttribute('aria-disabled'), rowCount: rows.length, states: rows.map((r) => r.getAttribute('data-pr-state')), authors: [...new Set(rows.map((r) => r.getAttribute('data-pr-author')))] };
  })()`);
}

/** A double-click on the session-list handle (a sibling Group) must not persist 320px for the PR column: the library's dblclick hit-testing is shared across Groups.
 * The PR width may drift a few px from a preserve-relative-size reflow, so compare `persisted` against `after`, not `before`,
 * and require `persisted` is never ~`defaultWidthPx` unless the width already was before the click (the original bug's signature).
 * `defaultWidthPx` is the caller's `PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX`. Returns `{ pass, detail }`. */
export async function checkSidebarDblClickDoesNotAffectPrColumn(cdp, listPanelFinder, defaultWidthPx) {
  const before = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  const rect = await cdp.evaluate(`(() => { const el = document.querySelector('[aria-label="Resize session list"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) return { pass: false, detail: 'session-list handle not found' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
  await sleep(700);
  const after = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  const persisted = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
  const detail = { prWidthBeforeSidebarDblClick: before, prWidthAfterSidebarDblClick: after, persistedAfterSidebarDblClick: persisted };
  const persistedMatchesRealWidth = after != null && persisted != null && Math.abs(persisted - after) <= 1;
  const suspiciousDefaultReset = persisted != null && Math.abs(persisted - defaultWidthPx) <= 1 && before != null && Math.abs(before - defaultWidthPx) > 1;
  const pass = persistedMatchesRealWidth && !suspiciousDefaultReset;
  return { pass, detail };
}

/** Shared by both relaunch checks: closes `cdp`, stops `child`, relaunches on the same scratch data dir, reopens Pull requests and reads the list column's DOM width.
 * Returns the new `{ child, cdp, widthAfterRelaunch }`; the old handles are invalid. */
async function relaunchAndReadListWidth(cdp, child, launch, stopLauncherFn, listPanelFinder) {
  cdp.close();
  await stopLauncherFn(child);
  const relaunched = await launch();
  await relaunched.cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!document.querySelector('.drag-region')`, { timeoutMs: 45_000, label: 'app ready after relaunch' });
  // Prefix-match the aria-label: the active-count badge has loaded by relaunch time.
  await relaunched.cdp.clickByLabel('Pull requests', { prefix: true });
  await sleep(500);
  const widthAfterRelaunch = await relaunched.cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  return { child: relaunched.child, cdp: relaunched.cdp, widthAfterRelaunch };
}

/** Mount-restore race check: drags to a width away from the default, relaunches, and confirms it survives. The reset-to-default check can't catch the Panel's initial `onResize(defaultSize)` clobbering the restored value, because the default equals a fresh settings.json.
 * Returns the new `{ child, cdp }` with `{ pass, detail }`. */
export async function checkDraggedWidthSurvivesRelaunch(cdp, child, launch, stopLauncherFn, handleFinder, listPanelFinder, defaultWidthPx) {
  await dragHandleBy(cdp, handleFinder, 80);
  await sleep(400);
  const widthAfterDrag = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  await sleep(600); // clears the ~300ms persist debounce before the relaunch below.
  const persistedAfterDrag = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
  const r = await relaunchAndReadListWidth(cdp, child, launch, stopLauncherFn, listPanelFinder);
  const pass = widthAfterDrag != null && Math.abs(widthAfterDrag - defaultWidthPx) > 20
    && persistedAfterDrag != null && Math.abs(persistedAfterDrag - widthAfterDrag) <= 2
    && r.widthAfterRelaunch != null && Math.abs(r.widthAfterRelaunch - widthAfterDrag) <= 2;
  return { pass, detail: { widthAfterDrag, persistedAfterDrag, widthAfterRelaunch: r.widthAfterRelaunch }, child: r.child, cdp: r.cdp };
}

/** Drags away, double-clicks to reset, relaunches the same scratch data dir and confirms the DEFAULT width returns. Returns the new `{ child, cdp }` with `{ pass, detail }`. */
export async function checkResetToDefaultSurvivesRelaunch(cdp, child, launch, stopLauncherFn, handleFinder, listPanelFinder, defaultWidthPx) {
  await dragHandleBy(cdp, handleFinder, 120);
  await sleep(400);
  const handleRect = await cdp.evaluate(`(() => { const el = ${handleFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handleRect.x, y: handleRect.y, button: 'left', clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handleRect.x, y: handleRect.y, button: 'left', clickCount: 2 });
  await sleep(400);
  const widthAfterReset = await cdp.evaluate(`${listPanelFinder}?.getBoundingClientRect().width ?? null`);
  await sleep(600); // clears the ~300ms persist debounce before the relaunch below.
  const persistedWidthPx = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
  const r = await relaunchAndReadListWidth(cdp, child, launch, stopLauncherFn, listPanelFinder);
  const pass = widthAfterReset != null && Math.abs(widthAfterReset - defaultWidthPx) <= 3
    && persistedWidthPx != null && Math.abs(persistedWidthPx - defaultWidthPx) <= 3
    && r.widthAfterRelaunch != null && Math.abs(r.widthAfterRelaunch - defaultWidthPx) <= 3;
  return { pass, detail: { widthAfterReset, persistedWidthPx, widthAfterRelaunch: r.widthAfterRelaunch }, child: r.child, cdp: r.cdp };
}
