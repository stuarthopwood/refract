#!/usr/bin/env node
// Live CDP check for the Pull requests Filter tabs/Filters disclosure (#499) and the resizable list column (#930).
// Read-only against GitHub via a scratch clone; a failed clone or zero settled rows is a hard failure, never "not exercised".

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getFreePort,
  stopLauncher,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository, pressKey } from './verify-tauri-session-list-helpers.mjs';
import {
  assertBundleContainsStory499930Marker,
  checkDraggedWidthSurvivesRelaunch,
  checkResetToDefaultSurvivesRelaunch,
  checkSidebarDblClickDoesNotAffectPrColumn,
  connectCdp,
  dragHandleBy,
  driveStateFilter,
  makeGithubScratchClone,
  stateFilterDiagnostic
} from './verify-tauri-499-930-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Requires the shared CARGO_TARGET_DIR; refuses rather than using a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_499_930_SHOTS_DIR || path.join(tmpdir(), 'refract-499-930-shots');
const TAB_GEOMETRY_WIDTHS = [360, 380, 440, 520];
const DEFAULT_WIDTH_PX = 320;
// Mirrors `PULL_REQUESTS_LIST_MIN_WIDTH_PX` in pull-requests-layout-store.ts; this Node script cannot import the TS module.
const MIN_WIDTH_PX = 280;

const LIST_PANEL_FINDER = `document.getElementById('pull-requests-list')`;
const HANDLE_FINDER = `document.querySelector('[aria-label="Resize pull request list"]')`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const report = { gitHead: gitHead(REPO_ROOT), checks: [], failures: [], notExercised: [] };
  log(`verify-tauri-499-930: git HEAD under test: ${report.gitHead}`);

  function checkPass(name, detail) {
    report.checks.push({ name, status: 'PASS', detail });
    log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function checkFail(name, detail) {
    report.checks.push({ name, status: 'FAIL', detail });
    report.failures.push(name);
    log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function notExercised(name, reason) {
    report.notExercised.push({ name, reason });
    log(`NOT EXERCISED: ${name} -- ${reason}`);
  }

  let dataDir, importSourceDir, shimDir, exeDir, repoClone;
  let child;
  let cdp;
  try {
    try {
      assertBundleContainsStory499930Marker(REPO_ROOT);
      checkPass('#499/#930-only DOM/bundle marker present');
    } catch (err) {
      checkFail('#499/#930-only DOM/bundle marker present', err.message);
      throw err;
    }

    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-499-930-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-499-930-import-src-'));
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-499-930-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-499-930-exe-'));
    const cloneParent = mkdtempSync(path.join(tmpdir(), 'refract-499-930-repo-'));
    repoClone = makeGithubScratchClone(path.join(cloneParent, 'refract'));

    log(`verify-tauri-499-930: data dir ${dataDir}`);
    log(`verify-tauri-499-930: evidence/screenshot dir ${SHOTS_DIR}`);
    log(`verify-tauri-499-930: GitHub scratch clone ${repoClone ?? '(FAILED -- see below)'}`);

    if (!repoClone) {
      checkFail('GitHub scratch clone of stuarthopwood/refract succeeded', 'git clone failed (offline, or the ambient gh/git credentials are not reachable from this sandboxed shell) -- cannot prove anything about real PR data without it');
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-499-930' });

    async function launch() {
      const port = await getFreePort();
      const launched = await launchBuiltExe(launcherExe, exePath, {
        port,
        dataDir,
        importSourceDir,
        logFile: path.join(SHOTS_DIR, 'app-run.log')
      });
      // If connect/assert throws, the caller never receives `launched.child`, so the orphaned process
      // keeps the job's stdout pipes open and hangs it; stop it before propagating.
      try {
        const c = await connectCdp(port, launched.targetPid);
        assertExeMatchesProcess(launched.targetPid, exePath, exeHash);
        return { child: launched.child, cdp: c };
      } catch (err) {
        await stopLauncher(launched.child).catch(() => {});
        throw err;
      }
    }

    ({ child, cdp } = await launch());
    log(`verify-tauri-499-930: launched, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready for Add repository (readiness checks passed, button enabled)' });

    let reachedPrData = false;

    if (repoClone) {
      await addRepository(cdp, repoClone);
      checkPass('Added scratch stuarthopwood/refract clone as a Project');

      // The nav label gains a ", N active" suffix after first load, so match by prefix.
      await cdp.clickByLabel('Pull requests', { prefix: true });
      await cdp.waitFor(`document.querySelector('h2') && document.querySelector('h2').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view mounted' });
      checkPass('Navigated to Pull requests view');

      const loaded = await cdp.waitFor(`(() => {
        const err = document.querySelector('[role="alert"]');
        const rows = document.querySelectorAll('[data-pr-row]');
        return rows.length > 0 ? 'rows' : (err ? 'error' : null);
      })()`, { timeoutMs: 30_000, label: 'pull request list settles' });

      if (loaded !== 'rows') {
        const errorText = loaded === 'error' ? await cdp.evaluate(`document.querySelector('[role="alert"]').textContent`) : '(list never settled within 30s)';
        checkFail('Pull request list settles to real rows', errorText);
      } else {
        reachedPrData = true;
      }
    }

    if (reachedPrData) {
      // ---- #499: the 5 Filter tabs, "All" active by default, never wrapping ----
      const tabShape = await cdp.evaluate(`(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter((el) => ['All', 'Authored by me', 'Assigned to me', 'Involves me', 'Review requested'].includes(el.textContent.trim()));
        const tops = new Set(tabs.map((el) => el.getBoundingClientRect().top));
        const active = tabs.find((el) => el.getAttribute('data-state') === 'active');
        return { count: tabs.length, oneRow: tops.size <= 1, activeLabel: active ? active.textContent.trim() : null };
      })()`);
      if (tabShape.count === 5 && tabShape.oneRow && tabShape.activeLabel === 'All') {
        checkPass('5 Filter tabs present, one row, "All" active by default', JSON.stringify(tabShape));
      } else {
        checkFail('5 Filter tabs present, one row, "All" active by default', JSON.stringify(tabShape));
      }

      // Keys only, no coordinate click: at 320px "Review requested" is scrolled out of view.
      // Manual activation: arrows move focus without activating; Enter activates.
      await cdp.evaluate(`(() => { const active = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.getAttribute('data-state') === 'active'); active?.focus(); })()`);
      for (let i = 0; i < 4; i++) {
        await pressKey(cdp, 39, 'ArrowRight', 'ArrowRight');
        await sleep(80);
      }
      const focusMovedForward = await cdp.evaluate(`(() => ({
        focused: document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent.trim() : null,
        active: Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.getAttribute('data-state') === 'active')?.textContent.trim() ?? null
      }))()`);
      if (focusMovedForward.focused === 'Review requested' && focusMovedForward.active === 'All') {
        checkPass('ArrowRight x4 moves tab roving focus to the last tab without activating it (manual activation mode)', JSON.stringify(focusMovedForward));
      } else {
        checkFail('ArrowRight x4 moves tab roving focus to the last tab without activating it (manual activation mode)', JSON.stringify(focusMovedForward));
      }
      const wrapScrollLeftBeforeEnter = await cdp.evaluate(`document.querySelector('[role="tab"]')?.closest('.overflow-x-auto')?.scrollLeft ?? null`);
      await pressKey(cdp, 13, 'Enter', 'Enter');
      let scrollDiagnostic = null;
      const scrolledIntoView = await cdp.waitFor(`(() => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'Review requested');
        if (!tab || tab.getAttribute('data-state') !== 'active') return null;
        const wrap = tab.closest('.overflow-x-auto');
        if (!wrap) return null;
        const tabLeft = tab.offsetLeft, tabRight = tabLeft + tab.offsetWidth;
        return tabLeft >= wrap.scrollLeft - 1 && tabRight <= wrap.scrollLeft + wrap.clientWidth + 1;
      })()`, { timeoutMs: 10_000, label: 'Review requested becomes active and scrolls into view' }).catch(async () => {
        scrollDiagnostic = await cdp.evaluate(`(() => {
          const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'Review requested');
          if (!tab) return { tabFound: false };
          const wrap = tab.closest('.overflow-x-auto');
          const tabOffsetLeft = tab.offsetLeft, tabOffsetWidth = tab.offsetWidth;
          const wrapScrollLeft = wrap ? wrap.scrollLeft : null;
          const wrapClientWidth = wrap ? wrap.clientWidth : null;
          return {
            tabFound: true,
            dataState: tab.getAttribute('data-state'),
            tabOffsetLeft,
            tabOffsetWidth,
            wrapFound: !!wrap,
            wrapScrollLeft,
            wrapClientWidth,
            // Diagnosability (issue #499 gate-fix, 2026-10-17): distinguishes "the layout effect
            // never ran" (scrollLeft unchanged from before Enter was pressed) from "it ran but
            // computed/applied the wrong value" (changed, but not to the expected target) --
            // the expected target is the same formula PullRequestList.tsx's own effect uses.
            // (No surrounding backticks here on purpose: this whole block is itself the body of
            // an outer template literal -- a literal backtick in this comment would terminate it.)
            effectRan: wrapScrollLeft !== null && wrapScrollLeft !== ${JSON.stringify(wrapScrollLeftBeforeEnter)},
            expectedScrollLeft: wrapClientWidth !== null ? tabOffsetLeft + tabOffsetWidth - wrapClientWidth : null
          };
        })()`).catch((err) => ({ evaluateFailed: err.message }));
        return false;
      });
      if (scrolledIntoView) checkPass('Enter activates the keyboard-focused last tab, which scrolls fully into the wrapper\'s own visible bounds');
      else checkFail('Enter activates the keyboard-focused last tab, which scrolls fully into the wrapper\'s own visible bounds', JSON.stringify(scrollDiagnostic));

      for (let i = 0; i < 4; i++) {
        await pressKey(cdp, 37, 'ArrowLeft', 'ArrowLeft');
        await sleep(80);
      }
      const focusMovedBack = await cdp.evaluate(`(() => ({
        focused: document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent.trim() : null,
        active: Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.getAttribute('data-state') === 'active')?.textContent.trim() ?? null
      }))()`);
      if (focusMovedBack.focused === 'All' && focusMovedBack.active === 'Review requested') {
        checkPass('ArrowLeft x4 moves tab roving focus back to the first tab without activating it (manual activation mode)', JSON.stringify(focusMovedBack));
      } else {
        checkFail('ArrowLeft x4 moves tab roving focus back to the first tab without activating it (manual activation mode)', JSON.stringify(focusMovedBack));
      }
      await pressKey(cdp, 13, 'Enter', 'Enter');
      await sleep(300);
      const activeAfterEnter = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.getAttribute('data-state') === 'active')?.textContent.trim() ?? null`);
      if (activeAfterEnter === 'All') checkPass('Enter activates the keyboard-focused first tab (manual activation mode), restoring All', activeAfterEnter);
      else checkFail('Enter activates the keyboard-focused first tab (manual activation mode), restoring All', String(activeAfterEnter));

      // ---- Filters disclosure: label/dot count the APPLIED filter, not keystrokes ----
      // Observe store state through the real DOM: `window.__refractStores` is DEV-only, absent from this bundle.
      await cdp.clickByLabel('Filters', { prefix: true });
      const filtersOpened = await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters panel mounts' }).catch(() => false);
      const expandedAttr = await cdp.evaluate(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-expanded') : null; })()`);
      if (filtersOpened && expandedAttr === 'true') checkPass('Filters button discloses the search field and State select, aria-expanded=true');
      else checkFail('Filters button discloses the search field and State select, aria-expanded=true', JSON.stringify({ filtersOpened, expandedAttr }));

      // The label/dot count the applied query, so typing before Enter must leave the label exactly "Filters".
      await cdp.typeIntoByLabel('Filter pull requests by title or label', 'zzz-verify-499');
      await sleep(200);
      const labelWhileTyping = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (labelWhileTyping === 'Filters') checkPass('Typing a query without pressing Enter leaves the Filters label (and dot) unchanged -- it names the APPLIED filter, not every keystroke', labelWhileTyping);
      else checkFail('Typing a query without pressing Enter leaves the Filters label (and dot) unchanged -- it names the APPLIED filter, not every keystroke', String(labelWhileTyping));

      // A garbage query settling to the filtered-empty state proves the query reaches the IPC call, not just the input.
      await pressKey(cdp, 13, 'Enter', 'Enter');
      const dotAfterEnter = await cdp.waitFor(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-label') : null; })()`, { timeoutMs: 5_000, label: 'Filters label updates to N active after Enter' }).catch(() => null);
      if (dotAfterEnter === 'Filters, 1 active') checkPass('Pressing Enter updates the Filters label to "Filters, 1 active" with a dot', dotAfterEnter);
      else checkFail('Pressing Enter updates the Filters label to "Filters, 1 active" with a dot', String(dotAfterEnter));

      const narrowedToNoMatches = await cdp.waitFor(`(() => { const empty = Array.from(document.querySelectorAll('div')).find((el) => el.textContent.trim() === 'No pull requests match these filters.'); return !!empty; })()`, { timeoutMs: 15_000, label: 'list narrows to "No pull requests match these filters."' }).catch(() => false);
      if (narrowedToNoMatches) checkPass('Pressing Enter in the search field narrows the real rendered list (settles to the filtered-empty-state copy)');
      else checkFail('Pressing Enter in the search field narrows the real rendered list (settles to the filtered-empty-state copy)');

      // The query must keep applying while Filters is closed, and its text must survive reopen.
      await cdp.clickByLabel('Filters, 1 active');
      await sleep(200);
      const stillNarrowedWhileClosed = await cdp.evaluate(`!document.getElementById('pull-request-filters-panel') && Array.from(document.querySelectorAll('div')).some((el) => el.textContent.trim() === 'No pull requests match these filters.')`);
      if (stillNarrowedWhileClosed) checkPass('The narrowed (empty) list keeps applying while the Filters section is closed');
      else checkFail('The narrowed (empty) list keeps applying while the Filters section is closed', String(stillNarrowedWhileClosed));
      await cdp.clickByLabel('Filters, 1 active');
      const queryTextSurvivedReopen = await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null`);
      if (queryTextSurvivedReopen === 'zzz-verify-499') checkPass('The query text itself survives closing and reopening the Filters section', queryTextSurvivedReopen);
      else checkFail('The query text itself survives closing and reopening the Filters section', String(queryTextSurvivedReopen));

      // The empty state's "Clear filters" button resets query and State and refetches.
      await cdp.clickByText('Clear filters');
      // `waitFor` resolves only on a truthy value, so an empty-string `.value` would time out; wait on a boolean instead.
      await cdp.waitFor(`(document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null) === ''`, { timeoutMs: 5_000, label: 'search field cleared by Clear filters' }).catch(() => false);
      const clearedQueryValue = await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null`);
      const rowsAfterClear = await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 15_000, label: 'list repopulates after Clear filters' }).catch(() => false);
      const labelAfterClear = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (clearedQueryValue === '' && rowsAfterClear && labelAfterClear === 'Filters') {
        checkPass('"Clear filters" empties the query, resets State, and refetches the unfiltered list', JSON.stringify({ clearedQueryValue, rowsAfterClear, labelAfterClear }));
      } else {
        checkFail('"Clear filters" empties the query, resets State, and refetches the unfiltered list', JSON.stringify({ clearedQueryValue, rowsAfterClear, labelAfterClear }));
      }

      // ---- Clear filters with Filters CLOSED: no search field, so focus falls back to the Filters button ----
      await cdp.typeIntoByLabel('Filter pull requests by title or label', 'zzz-verify-499');
      await pressKey(cdp, 13, 'Enter', 'Enter');
      await cdp.waitFor(`(() => { const empty = Array.from(document.querySelectorAll('div')).find((el) => el.textContent.trim() === 'No pull requests match these filters.'); return !!empty; })()`, { timeoutMs: 15_000, label: 'list narrows to no matches before the closed-Filters Clear check' }).catch(() => false);
      await cdp.clickByLabel('Filters, 1 active');
      await cdp.clickByText('Clear filters');
      await sleep(200);
      const activeElementAfterClearClosed = await cdp.evaluate(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'));
        return document.activeElement === btn;
      })()`);
      if (activeElementAfterClearClosed) checkPass('Clear filters with the Filters section closed moves focus to the Filters button');
      else checkFail('Clear filters with the Filters section closed moves focus to the Filters button', String(activeElementAfterClearClosed));

      // ---- Drive the State control; `driveStateFilter` waits for rows to reflect the filter, not stale ones ----
      const closedOnAll = await driveStateFilter(cdp, 'All', 'Closed');
      if (closedOnAll) checkPass('State=Closed on the All tab renders real rows and updates the Filters label', JSON.stringify(closedOnAll));
      else checkFail('State=Closed on the All tab renders real rows and updates the Filters label', JSON.stringify(await stateFilterDiagnostic(cdp)));

      const closedOnRelationTab = await driveStateFilter(cdp, 'Authored by me', undefined, { requireSingleAuthor: true });
      if (closedOnRelationTab) checkPass('State=Closed on a relation tab (Authored by me) renders real rows and updates the Filters label', JSON.stringify(closedOnRelationTab));
      else checkFail('State=Closed on a relation tab (Authored by me) renders real rows and updates the Filters label', JSON.stringify(await stateFilterDiagnostic(cdp)));

      // Reset to State Open / tab All so downstream checks share one baseline.
      // Wait for the State popover to close first, or the All-tab click lands on its overlay.
      await cdp.click(`document.querySelector('[aria-label="State"]')`);
      await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === 'Open')`);
      await cdp.waitFor(`document.querySelector('[role="listbox"]') === null`, { timeoutMs: 5_000, label: 'State popover closes before switching tabs' }).catch(() => false);
      await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === 'All')`);
      await cdp.waitFor(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === 'All')?.getAttribute('data-state') === 'active'`, { timeoutMs: 5_000, label: 'All tab genuinely becomes active' }).catch(() => false);
      await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 15_000, label: 'list repopulates after resetting State to Open' }).catch(() => false);

      // Close via the button's CURRENT aria-label rather than a hardcoded guess.
      const filtersLabelBeforeClose = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (filtersLabelBeforeClose) await cdp.clickByLabel(filtersLabelBeforeClose);

      // ---- Tab-row geometry: never wraps; list column stays at `min(280, groupWidth - 1)` (`-1` = handle `w-px`) ----
      // Widths stay >= App.tsx's `minSize={360}` on "chat"; `panel.closest(...)` measures the list's own nearest group.
      for (const width of TAB_GEOMETRY_WIDTHS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        const geometry = await cdp.evaluate(`(() => {
          const wrap = document.querySelector('[role="tablist"]')?.closest('.overflow-x-auto');
          if (!wrap) return null;
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const tops = new Set(tabs.map((el) => el.getBoundingClientRect().top));
          const panel = ${LIST_PANEL_FINDER};
          const group = panel ? panel.closest('[data-slot="resizable-panel-group"]') : null;
          return { oneRow: tops.size <= 1, scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth, panelWidth: panel ? panel.getBoundingClientRect().width : null, groupWidth: group ? group.getBoundingClientRect().width : null };
        })()`);
        const effectiveMin = geometry?.groupWidth != null ? Math.min(MIN_WIDTH_PX, geometry.groupWidth - 1) : MIN_WIDTH_PX;
        const panelAtLeastMin = geometry != null && geometry.panelWidth != null && geometry.panelWidth >= effectiveMin - 1;
        if (geometry && geometry.oneRow && panelAtLeastMin) checkPass(`Tab row never wraps at ${width}px window width, list column stays at least 280px`, JSON.stringify(geometry));
        else checkFail(`Tab row never wraps at ${width}px window width, list column stays at least 280px`, JSON.stringify(geometry));
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);

      // ---- #930: resizable list column -- drag, double-click reset, arrow-key resize ----
      const widthBeforeDrag = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      await dragHandleBy(cdp, HANDLE_FINDER, 100);
      await sleep(400);
      const widthAfterDrag = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      const dragWorked = widthBeforeDrag != null && widthAfterDrag != null && widthAfterDrag - widthBeforeDrag >= 60;
      if (dragWorked) checkPass('Dragging the handle resizes the list column', JSON.stringify({ widthBeforeDrag, widthAfterDrag }));
      else checkFail('Dragging the handle resizes the list column', JSON.stringify({ widthBeforeDrag, widthAfterDrag }));

      // A real double-click resets to `defaultSize` (react-resizable-panels) and leaves the handle focused for the arrow-key check.
      const handleRect = await cdp.evaluate(`(() => { const el = ${HANDLE_FINDER}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handleRect.x, y: handleRect.y, button: 'left', clickCount: 2 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handleRect.x, y: handleRect.y, button: 'left', clickCount: 2 });
      await sleep(400);
      const widthAfterDoubleClick = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      if (widthAfterDoubleClick != null && Math.abs(widthAfterDoubleClick - DEFAULT_WIDTH_PX) <= 3) {
        checkPass('Double-clicking the handle resets the column to 320px', String(widthAfterDoubleClick));
      } else {
        checkFail('Double-clicking the handle resets the column to 320px', String(widthAfterDoubleClick));
      }

      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
      await sleep(300);
      const widthAfterArrowKey = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      if (widthAfterArrowKey != null && widthAfterArrowKey > widthAfterDoubleClick) {
        checkPass('Arrow-key resize on the focused handle changes the column width', JSON.stringify({ widthAfterDoubleClick, widthAfterArrowKey }));
      } else {
        checkFail('Arrow-key resize on the focused handle changes the column width', JSON.stringify({ widthAfterDoubleClick, widthAfterArrowKey }));
      }

      // See `checkSidebarDblClickDoesNotAffectPrColumn` in the helpers module. ----
      const sidebarDblClickResult = await checkSidebarDblClickDoesNotAffectPrColumn(cdp, LIST_PANEL_FINDER, DEFAULT_WIDTH_PX);
      if (sidebarDblClickResult.pass) checkPass('Double-clicking the session-list handle never persists a stale width for the PR column', JSON.stringify(sidebarDblClickResult.detail));
      else checkFail('Double-clicking the session-list handle never persists a stale width for the PR column', JSON.stringify(sidebarDblClickResult.detail));

      // ---- Project selector truncates to the column width. Its name is "Project: <name>", so match by prefix. ----
      await dragHandleBy(cdp, HANDLE_FINDER, -60);
      await sleep(400);
      const selectorFit = await cdp.evaluate(`(() => {
        const panel = ${LIST_PANEL_FINDER};
        const select = Array.from(document.querySelectorAll('[aria-label]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Project'));
        if (!panel || !select) return null;
        const panelRect = panel.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        return selectRect.right <= panelRect.right + 1;
      })()`);
      if (selectorFit === true) checkPass('Project selector stays inside the resized list column\'s own width');
      else checkFail('Project selector stays inside the resized list column\'s own width', String(selectorFit));

      // ---- Focus ring must not be clipped: the header wrapper is flush against the panel edge ----
      // `.focus()` stands in for Tab and still matches `:focus-visible`; the wrapper must not compute `overflow: hidden`. ----
      const focusRingState = await cdp.evaluate(`(() => {
        const select = Array.from(document.querySelectorAll('[aria-label]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Project'));
        if (!select) return null;
        select.focus();
        const style = getComputedStyle(select);
        const wrapper = select.closest('.drag-region > div');
        const wrapperOverflow = wrapper ? getComputedStyle(wrapper).overflow : null;
        return {
          focused: document.activeElement === select,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow,
          wrapperOverflow
        };
      })()`);
      const hasVisibleFocusIndicator = focusRingState?.focused && (focusRingState.outlineWidth !== '0px' || (focusRingState.boxShadow && focusRingState.boxShadow !== 'none'));
      const wrapperNoLongerClips = focusRingState?.wrapperOverflow !== 'hidden';
      if (hasVisibleFocusIndicator && wrapperNoLongerClips) {
        checkPass('Project selector shows a real, unclipped focus indicator (the former overflow-hidden wrapper no longer clips it)', JSON.stringify(focusRingState));
      } else {
        checkFail('Project selector shows a real, unclipped focus indicator (the former overflow-hidden wrapper no longer clips it)', JSON.stringify(focusRingState));
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '04-project-selector-focus.png'));

      // Blur first: a focused Project selector opens its tooltip, which overlaps the tabs row.
      await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10, button: 'none' });
      await sleep(200);
      await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-pull-requests.png'));
    } else {
      notExercised('Every live PR-data check (Filter tabs, Filters disclosure, tab geometry, resizable column, Project selector fit)', 'real GitHub PR data was not reachable this run (see the hard failure above) -- code-verified only');
    }

    if (reachedPrData) {
      const draggedResult = await checkDraggedWidthSurvivesRelaunch(cdp, child, launch, stopLauncher, HANDLE_FINDER, LIST_PANEL_FINDER, DEFAULT_WIDTH_PX);
      ({ child, cdp } = draggedResult);
      (draggedResult.pass ? checkPass : checkFail)('A dragged (non-default) width survives a relaunch, not clobbered by the mount-restore race', JSON.stringify(draggedResult.detail));
    } else {
      notExercised('Dragged width survives a relaunch', 'no Pull requests data reached this run; code-verified only');
    }

    // See `checkResetToDefaultSurvivesRelaunch` in the helpers module. ----
    if (reachedPrData) {
      const resetResult = await checkResetToDefaultSurvivesRelaunch(cdp, child, launch, stopLauncher, HANDLE_FINDER, LIST_PANEL_FINDER, DEFAULT_WIDTH_PX);
      ({ child, cdp } = resetResult);
      (resetResult.pass ? checkPass : checkFail)('A double-click reset to the default width is remembered across a relaunch', JSON.stringify(resetResult.detail));
    } else {
      notExercised('Remembered width across a relaunch', 'no Pull requests data reached this run; code-verified only');
    }

    // Wait for real rows before screenshots; Filters stays open across the theme switch (a class toggle).
    await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 15_000, label: 'rows settled before theme screenshots' }).catch(() => false);
    await cdp.clickByLabel('Filters', { prefix: true });
    await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters open before theme screenshots' }).catch(() => false);

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 15_000, label: 'rows still settled before obsidian screenshot' }).catch(() => false);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-theme-obsidian.png'));
    checkPass('Obsidian theme screenshot captured');

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-tauri-499-930: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      log(`verify-tauri-499-930: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = 1;
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    if (dataDir) await safeRmSync(dataDir);
    if (importSourceDir) await safeRmSync(importSourceDir);
    if (shimDir) await safeRmSync(shimDir);
    if (exeDir) await safeRmSync(exeDir);
    if (repoClone) await safeRmSync(path.dirname(repoClone));
  }
}

main().catch((err) => {
  console.error('verify-tauri-499-930: FAIL');
  console.error(err);
  process.exitCode = 1;
});
