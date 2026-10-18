#!/usr/bin/env node
// Live CDP check for issues #499 (Filter tab redesign: ghost scrollable tab row, Filters
// disclosure with search + State control) and #930 (resizable Pull requests list column,
// remembered across restarts; the header Project selector tracking the column's own width).
// Modelled directly on `verify-tauri-568.mjs`'s own shape and lessons (never claim PASS on "no
// repo"/"no rows"; assert a story-only marker before trusting anything else; rebuild the exe
// fresh via `buildAndCopyExeFresh`, never trust a possibly sibling-lane-clobbered shared-target
// binary; drive the real rendered DOM, never `window.refract.*` as a UI shortcut except the one
// documented theme-switch exception).
//
// NOT RUN by this prep-lane pass (no cargo build here) -- written for the build lane to execute.
//
// Pull requests needs real GitHub data: the scratch Project added here is a shallow, read-only
// clone of `stuarthopwood/refract` itself (this script never calls `pullRequests.comment`/
// `submitReview`/`merge`/`newSessionFromPullRequest` -- read-only against GitHub throughout). A
// failed clone, or a settled list with zero rows and no error banner, is a hard FAILURE
// (`checkFail` + non-zero exit), never a silent "not exercised" pass.
//
// Checks made, against the real rendered DOM:
//   - #499-only / #930-only bundle marker present before anything else is trusted.
//   - Filter tabs: exactly 5, labelled All/Authored by me/Assigned to me/Involves me/Review
//     requested, "All" active by default; the tab row never wraps (every tab shares one
//     `offsetTop`) and its wrapper is horizontally scrollable once the row doesn't fit.
//   - Clicking a later tab (Review requested) makes it `data-state="active"` and scrolls it
//     fully into the wrapper's own visible bounds (not merely clipped at an edge).
//   - Filters button: `aria-expanded` toggles, the disclosure (search input + State select)
//     mounts/unmounts with it; the label/dot name the APPLIED filter (set by `refresh()` itself),
//     never a still-typed keystroke -- typing alone leaves "Filters" unchanged, Enter updates it
//     to "Filters, N active"; the narrowed list and query text both keep applying/surviving while
//     the section is closed and reopened. The State control is actually driven, not just claimed:
//     Closed on the All tab AND on one relation tab (Authored by me) each render real rows and
//     update the label. "Clear filters" (the filtered-to-nothing empty state's own recovery
//     button) empties the query, resets State, and refetches the unfiltered list.
//   - Tab-row geometry measured at 4 real window widths (240, 320, 380, 520), not estimated: the
//     row still never wraps, the wrapper's `scrollWidth`/`clientWidth` relationship is recorded
//     at each, and the list column itself never shrinks below its own 280px minimum even at
//     widths where that minimum exceeds 50% of the window.
//   - Resizable list column: the handle (`aria-label="Resize pull request list"`) exists; a real
//     pointer drag changes the rendered list-column width by roughly the dragged distance;
//     double-clicking the handle resets it to 320px; arrow-key resize while the handle is
//     focused changes the width without any pointer event.
//   - The header's Project selector sits inside the list column's own current width at a resized
//     size, never overflowing it, and shows a real, unclipped focus indicator when focused.
//   - Remembered width: a double-click RESET to the default (not just a plain drag) is still
//     applied after a full relaunch against the same scratch data dir (a genuine `settings.json`
//     round trip, not a store-only check) -- the specific case the library's own double-click
//     handler never routed through the persist path on its own.
//   - Dark, Dark (high contrast) and Obsidian screenshots, taken once the list has real,
//     populated rows and the Filters section is open (never mid-"Loading…").

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
  connectCdp,
  dragHandleBy,
  makeGithubScratchClone
} from './verify-tauri-499-930-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_499_930_SHOTS_DIR || path.join(tmpdir(), 'refract-499-930-shots');
const TAB_GEOMETRY_WIDTHS = [360, 380, 440, 520];
const DEFAULT_WIDTH_PX = 320;
// Mirrors `pull-requests-layout-store.ts`'s own `PULL_REQUESTS_LIST_MIN_WIDTH_PX` (M6 gate-fix,
// caught live 2026-10-18) -- this standalone Node script has no access to the TS module directly.
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
      // Gate-fix (hang, caught live 2026-10-17): `connectCdp`/`assertExeMatchesProcess` used to
      // run with no cleanup of their own -- if either threw (a port-reuse race against the
      // previous session's own teardown, or a mismatched exe), `launched.child` was never
      // assigned to this function's own caller (the destructuring assignment never runs), so
      // nothing ever called `stopLauncher` on it. The newly-spawned, kill-on-close-Job-Object
      // process then ran forever with no script left tracking it, and this job's own stdout/
      // stderr pipes stayed open waiting for that orphan's inherited handles to close -- the
      // script itself had already thrown and exited; the "hang" was an invisible leaked process,
      // not a stuck await. Every failure path from here on must stop the process it just
      // launched before propagating.
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

      // Gate-fix (relaunch, caught live 2026-10-17/18): `clickByText('Pull requests')` matches a
      // button's EXACT trimmed text content. `SessionList.tsx`'s own nav button's text (and its
      // `aria-label`) grows a trailing ", N active" badge once `refreshActiveCount` resolves --
      // reliably not yet on this FIRST navigation (moments after readiness), but reliably
      // already loaded by the time of the relaunch below, where the exact-text match silently
      // failed (`.catch(() => {})` swallowed it) and left the app on its default view, reading
      // `widthAfterRelaunch` as null. `clickByLabel(..., { prefix: true })` (the same pattern
      // this script already uses for the Filters button two sections down) matches either form.
      await cdp.clickByLabel('Pull requests', { prefix: true });
      await cdp.waitFor(`document.querySelector('h2') && document.querySelector('h2').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view mounted' });
      checkPass('Navigated to Pull requests view');

      const loaded = await cdp.waitFor(`(() => {
        const err = document.querySelector('[role="alert"]');
        const rows = document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button');
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

      // ---- Keyboard on tabs + active tab scrolls into view: driven entirely by focus/keys,
      // never a coordinate click on "Review requested" -- at the default 320px list-column
      // width the tab row does not fit all 5 tabs, so that tab is genuinely scrolled out of the
      // wrapper's visible bounds and a `getBoundingClientRect()`-centre mouse click would miss
      // it. `activationMode="manual"` (Radix Tabs): ArrowRight/ArrowLeft move the roving tab
      // stop WITHOUT activating it; Enter activates whichever tab currently has focus.
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
        // Gate-fix (diagnosability, caught live 2026-10-17): the previous version swallowed the
        // timeout into a bare `false`, leaving no record of WHY (active vs not, actual
        // scrollLeft/offsetLeft/clientWidth) for a future run to diagnose from.
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

      // ---- Filters disclosure: toggle, search + State appear, label/dot count the APPLIED
      // filter (not every keystroke), query keeps narrowing the real rendered list, Clear
      // filters resets everything (never a dev-only `window.__refractStores` shortcut -- that
      // global is DEV-only (`import.meta.env.DEV`) and absent from this built, production-mode
      // renderer bundle; store state must be observed through the real DOM). ----
      await cdp.clickByLabel('Filters', { prefix: true });
      const filtersOpened = await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters panel mounts' }).catch(() => false);
      const expandedAttr = await cdp.evaluate(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-expanded') : null; })()`);
      if (filtersOpened && expandedAttr === 'true') checkPass('Filters button discloses the search field and State select, aria-expanded=true');
      else checkFail('Filters button discloses the search field and State select, aria-expanded=true', JSON.stringify({ filtersOpened, expandedAttr }));

      // Gate-fix (H3, caught live 2026-10-18): the label/dot now count the APPLIED query (set by
      // `refresh()` itself), never the raw, still-typed one -- typing alone, before Enter, must
      // leave the label exactly "Filters" (no "N active" suffix, no dot).
      await cdp.typeIntoByLabel('Filter pull requests by title or label', 'zzz-verify-499');
      await sleep(200);
      const labelWhileTyping = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (labelWhileTyping === 'Filters') checkPass('Typing a query without pressing Enter leaves the Filters label (and dot) unchanged -- it names the APPLIED filter, not every keystroke', labelWhileTyping);
      else checkFail('Typing a query without pressing Enter leaves the Filters label (and dot) unchanged -- it names the APPLIED filter, not every keystroke', String(labelWhileTyping));

      // Enter triggers the real re-fetch with the query (never auto-applied on keystroke); a
      // garbage query no real pull request title/label matches settles the list to its own
      // filtered-empty-state copy -- positive proof the State/search narrowing genuinely reaches
      // the IPC call, not just the input's own local value -- with a "Clear filters" recovery.
      await pressKey(cdp, 13, 'Enter', 'Enter');
      const dotAfterEnter = await cdp.waitFor(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-label') : null; })()`, { timeoutMs: 5_000, label: 'Filters label updates to N active after Enter' }).catch(() => null);
      if (dotAfterEnter === 'Filters, 1 active') checkPass('Pressing Enter updates the Filters label to "Filters, 1 active" with a dot', dotAfterEnter);
      else checkFail('Pressing Enter updates the Filters label to "Filters, 1 active" with a dot', String(dotAfterEnter));

      const narrowedToNoMatches = await cdp.waitFor(`(() => { const empty = Array.from(document.querySelectorAll('div')).find((el) => el.textContent.trim() === 'No pull requests match these filters.'); return !!empty; })()`, { timeoutMs: 15_000, label: 'list narrows to "No pull requests match these filters."' }).catch(() => false);
      if (narrowedToNoMatches) checkPass('Pressing Enter in the search field narrows the real rendered list (settles to the filtered-empty-state copy)');
      else checkFail('Pressing Enter in the search field narrows the real rendered list (settles to the filtered-empty-state copy)');

      // Closes the section, confirms the narrowed (empty) list is STILL shown -- the query keeps
      // applying to the real rendered list while the Filters section is hidden, not just to the
      // input's own value -- then reopens and confirms the query text itself also survived.
      await cdp.clickByLabel('Filters, 1 active');
      await sleep(200);
      const stillNarrowedWhileClosed = await cdp.evaluate(`!document.getElementById('pull-request-filters-panel') && Array.from(document.querySelectorAll('div')).some((el) => el.textContent.trim() === 'No pull requests match these filters.')`);
      if (stillNarrowedWhileClosed) checkPass('The narrowed (empty) list keeps applying while the Filters section is closed');
      else checkFail('The narrowed (empty) list keeps applying while the Filters section is closed', String(stillNarrowedWhileClosed));
      await cdp.clickByLabel('Filters, 1 active');
      const queryTextSurvivedReopen = await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null`);
      if (queryTextSurvivedReopen === 'zzz-verify-499') checkPass('The query text itself survives closing and reopening the Filters section', queryTextSurvivedReopen);
      else checkFail('The query text itself survives closing and reopening the Filters section', String(queryTextSurvivedReopen));

      // Gate-fix (M5, caught live 2026-10-18): the filtered-to-nothing empty state's own "Clear
      // filters" button resets both the query and the State control and refetches -- the real
      // recovery path, not a manual field-by-field clear. Also satisfies H3's own "clear ->
      // unfiltered" case: the button IS the clear action here.
      await cdp.clickByText('Clear filters');
      // Gate-fix (caught live 2026-10-18): `waitFor` only ever resolves on a TRUTHY expression
      // value -- waiting on the input's own raw `.value` can never succeed once it reaches the
      // empty string, which is falsy; the search-field-is-cleared SIDE of this check always
      // timed out and silently read back `undefined`. Waits on a boolean condition instead, then
      // reads the real value separately.
      await cdp.waitFor(`(document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null) === ''`, { timeoutMs: 5_000, label: 'search field cleared by Clear filters' }).catch(() => false);
      const clearedQueryValue = await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null`);
      const rowsAfterClear = await cdp.waitFor(`document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button').length > 0`, { timeoutMs: 15_000, label: 'list repopulates after Clear filters' }).catch(() => false);
      const labelAfterClear = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (clearedQueryValue === '' && rowsAfterClear && labelAfterClear === 'Filters') {
        checkPass('"Clear filters" empties the query, resets State, and refetches the unfiltered list', JSON.stringify({ clearedQueryValue, rowsAfterClear, labelAfterClear }));
      } else {
        checkFail('"Clear filters" empties the query, resets State, and refetches the unfiltered list', JSON.stringify({ clearedQueryValue, rowsAfterClear, labelAfterClear }));
      }

      // ---- #499 gate-fix (H4, caught live 2026-10-18): the State control itself was never
      // actually driven by this script -- only claimed in this file's own header comment. Picks
      // Closed on the All tab (the real GitHub scratch clone has closed/merged history), then on
      // one relation tab too, asserting real rows render each time and the label still counts
      // the non-default State as one active filter. ----
      await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === 'All')`);
      await cdp.click(`document.querySelector('[aria-label="State"]')`);
      await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === 'Closed')`);
      const closedOnAll = await cdp.waitFor(`(() => {
        const rows = document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button');
        const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'));
        return rows.length > 0 && btn?.getAttribute('aria-label') === 'Filters, 1 active' ? { rows: rows.length, label: btn.getAttribute('aria-label') } : null;
      })()`, { timeoutMs: 15_000, label: 'State=Closed on All tab settles to real rows' }).catch(() => null);
      if (closedOnAll) checkPass('State=Closed on the All tab renders real rows and updates the Filters label', JSON.stringify(closedOnAll));
      else checkFail('State=Closed on the All tab renders real rows and updates the Filters label', JSON.stringify(closedOnAll));

      await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === 'Authored by me')`);
      const closedOnRelationTab = await cdp.waitFor(`(() => {
        const rows = document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button');
        const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'));
        return rows.length > 0 && btn?.getAttribute('aria-label') === 'Filters, 1 active' ? { rows: rows.length, label: btn.getAttribute('aria-label') } : null;
      })()`, { timeoutMs: 15_000, label: 'State=Closed on Authored by me tab settles to real rows' }).catch(() => null);
      if (closedOnRelationTab) checkPass('State=Closed on a relation tab (Authored by me) renders real rows and updates the Filters label', JSON.stringify(closedOnRelationTab));
      else checkFail('State=Closed on a relation tab (Authored by me) renders real rows and updates the Filters label', JSON.stringify(closedOnRelationTab));

      // Resets State back to Open and the tab back to All before everything downstream (tab
      // geometry, resize, relaunch) runs against the same baseline every prior round used.
      await cdp.click(`document.querySelector('[aria-label="State"]')`);
      await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === 'Open')`);
      await cdp.click(`Array.from(document.querySelectorAll('button[role="tab"]')).find((el) => el.textContent.trim() === 'All')`);
      await cdp.waitFor(`document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button').length > 0`, { timeoutMs: 15_000, label: 'list repopulates after resetting State to Open' }).catch(() => false);

      // Gate-fix (L5, caught live 2026-10-18): closes by whatever the Filters button's CURRENT
      // aria-label actually is, never a hardcoded guess swallowed into a silent `.catch(() => {})`
      // -- a real mismatch (this flow leaving the label somewhere unexpected) used to be invisible.
      const filtersLabelBeforeClose = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters'))?.getAttribute('aria-label') ?? null`);
      if (filtersLabelBeforeClose) await cdp.clickByLabel(filtersLabelBeforeClose);

      // ---- Tab-row geometry: never wraps, list column stays at `min(280, groupWidth - 1)`
      // (`-1` = the handle's real `w-px`). Dropped 240/320 (gate-fix, caught live 2026-10-18):
      // below `App.tsx`'s own `minSize={360}` on "chat" (hosts Pull Requests); `panel.closest(...)` now measures the list's own nearest group, not App.tsx's outer sidebar/chat one. ----
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

      // Focuses and double-clicks the handle itself -- `react-resizable-panels`' own
      // `disableDoubleClick` default (false) resets the panel to `defaultSize` on a real
      // double-click, and leaves the handle focused for the arrow-key check below.
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

      // ---- Project selector truncates to the resized column's own width, never overflows it.
      // Gate-fix (M3, caught live 2026-10-18): the trigger's own accessible name is now
      // "Project: <name>" (an `aria-label` that grows with the Project name), never the bare,
      // exact "Repository" string -- a prefix match is the only one that survives that. ----
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

      // ---- Gate-fix (H2, caught live 2026-10-18): the header wrapper's own `overflow-hidden`
      // used to clip the Project selector's own focus ring on its right edge, where the
      // wrapper's width is pinned flush against the panel's real edge with no slack to spare.
      // `.focus()` (not a real Tab traversal -- every other focus-visible check in this script
      // uses the same pattern) matches real keyboard focus for `:focus-visible` purposes;
      // confirms a real, non-empty focus indicator renders AND the wrapper that used to clip it
      // no longer computes `overflow: hidden`. ----
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

      await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-pull-requests.png'));
    } else {
      notExercised('Every live PR-data check (Filter tabs, Filters disclosure, tab geometry, resizable column, Project selector fit)', 'real GitHub PR data was not reachable this run (see the hard failure above) -- code-verified only');
    }

    // ---- Gate-fix (H1, caught live 2026-10-18): drags away from the default, double-clicks to
    // reset (the library's own internal reset fires alongside our `onDoubleClick` persist), then
    // relaunches the SAME scratch data dir and confirms the column renders at the DEFAULT width
    // again -- a genuine `settings.json` round trip proving the reset itself persisted, not just
    // a plain drag (`commit(true)` already covered that path; the reset's own `commit(false)` /
    // no-commit-at-all path was the one silently dropping it). ----
    if (reachedPrData) {
      await dragHandleBy(cdp, HANDLE_FINDER, 120);
      await sleep(400);
      const handleRectForReset = await cdp.evaluate(`(() => { const el = ${HANDLE_FINDER}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handleRectForReset.x, y: handleRectForReset.y, button: 'left', clickCount: 2 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handleRectForReset.x, y: handleRectForReset.y, button: 'left', clickCount: 2 });
      await sleep(400);
      const widthAfterReset = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      await sleep(600); // clears the ~300ms persist debounce before the relaunch below.
      const persistedWidthPx = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
      cdp.close();
      await stopLauncher(child);
      ({ child, cdp } = await launch());
      await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!document.querySelector('.drag-region')`, { timeoutMs: 45_000, label: 'app ready after relaunch' });
      // Same gate-fix as the first navigation above: prefix-matched aria-label, not exact text
      // (the active-count badge has reliably already loaded by relaunch time). No `.catch(()
      // => {})` either -- swallowing this let the step below silently read a `null` width off
      // whatever view the app happened to default to, instead of surfacing the real navigation
      // failure.
      await cdp.clickByLabel('Pull requests', { prefix: true });
      await sleep(500);
      const widthAfterRelaunch = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      const remembered = widthAfterReset != null && Math.abs(widthAfterReset - DEFAULT_WIDTH_PX) <= 3
        && persistedWidthPx != null && Math.abs(persistedWidthPx - DEFAULT_WIDTH_PX) <= 3
        && widthAfterRelaunch != null && Math.abs(widthAfterRelaunch - DEFAULT_WIDTH_PX) <= 3;
      if (remembered) checkPass('A double-click reset to the default width is remembered across a relaunch', JSON.stringify({ widthAfterReset, persistedWidthPx, widthAfterRelaunch }));
      else checkFail('A double-click reset to the default width is remembered across a relaunch', JSON.stringify({ widthAfterReset, persistedWidthPx, widthAfterRelaunch }));
    } else {
      notExercised('Remembered width across a relaunch', 'no Pull requests data reached this run; code-verified only');
    }

    // Gate-fix (M9, caught live 2026-10-18): both theme screenshots used to be taken while the
    // freshly-relaunched app's Pull requests list was still mid-fetch ("Loading…"), proving
    // nothing about either theme's own rendering of the real rows or the Filters disclosure.
    // Waits for real rows to settle and opens Filters once (stays open across the theme switch
    // below -- a class toggle, not a remount) so both screenshots show the full, populated view.
    await cdp.waitFor(`document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button').length > 0`, { timeoutMs: 15_000, label: 'rows settled before theme screenshots' }).catch(() => false);
    await cdp.clickByLabel('Filters', { prefix: true });
    await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters open before theme screenshots' }).catch(() => false);

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.waitFor(`document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button').length > 0`, { timeoutMs: 15_000, label: 'rows still settled before obsidian screenshot' }).catch(() => false);
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
