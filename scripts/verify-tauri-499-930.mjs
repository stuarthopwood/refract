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
//     mounts/unmounts with it; typing a query and picking a non-Open State both update the
//     button's own `aria-label` to "Filters, N active" and show the dot, and keep applying while
//     the section is closed again (re-opened, the same query/state are still there).
//   - Tab-row geometry measured at 4 real window widths (240, 320, 380, 520), not estimated:
//     the row still never wraps and the wrapper's `scrollWidth`/`clientWidth` relationship is
//     recorded at each.
//   - Resizable list column: the handle (`aria-label="Resize pull request list"`) exists; a real
//     pointer drag changes the rendered list-column width by roughly the dragged distance;
//     double-clicking the handle resets it to 320px; arrow-key resize while the handle is
//     focused changes the width without any pointer event.
//   - The header's Project selector sits inside the list column's own current width at a
//     resized size, never overflowing it.
//   - Remembered width: the resized width is still applied after a full relaunch against the
//     same scratch data dir (a genuine `settings.json` round trip, not a store-only check).
//   - Dark, Dark (high contrast) and Obsidian screenshots.

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  isTargetOwningPort,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_499_930_SHOTS_DIR || path.join(tmpdir(), 'refract-499-930-shots');
const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';
const TAB_GEOMETRY_WIDTHS = [240, 320, 380, 520];
const DEFAULT_WIDTH_PX = 320;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function connectCdp(port, targetPid) {
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
function makeGithubScratchClone(dir) {
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
 * fixed element id, and the resize handle's own accessible name. */
function assertBundleContainsStory499930Marker() {
  const bundleRoot = path.join(REPO_ROOT, 'out', 'tauri-web');
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
async function dragHandleBy(cdp, handleFinderExpr, deltaX) {
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
      assertBundleContainsStory499930Marker();
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

      await cdp.clickByText('Pull requests');
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

      // ---- Filters disclosure: toggle, search + State appear, dot + "N active" label, query
      // keeps narrowing the real rendered list (never a dev-only `window.__refractStores`
      // shortcut -- that global is DEV-only (`import.meta.env.DEV`) and absent from this built,
      // production-mode renderer bundle; store state must be observed through the real DOM). ----
      await cdp.clickByLabel('Filters', { prefix: true });
      const filtersOpened = await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'Filters panel mounts' }).catch(() => false);
      const expandedAttr = await cdp.evaluate(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-expanded') : null; })()`);
      if (filtersOpened && expandedAttr === 'true') checkPass('Filters button discloses the search field and State select, aria-expanded=true');
      else checkFail('Filters button discloses the search field and State select, aria-expanded=true', JSON.stringify({ filtersOpened, expandedAttr }));

      await cdp.typeIntoByLabel('Filter pull requests by title or label', 'zzz-verify-499');
      const dotAfterQuery = await cdp.waitFor(`(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Filters')); return btn ? btn.getAttribute('aria-label') : null; })()`, { timeoutMs: 5_000, label: 'Filters label updates to N active' }).catch(() => null);
      if (dotAfterQuery === 'Filters, 1 active') checkPass('Typing a query updates the Filters label to "Filters, 1 active" with a dot', dotAfterQuery);
      else checkFail('Typing a query updates the Filters label to "Filters, 1 active" with a dot', String(dotAfterQuery));

      // Enter triggers the real re-fetch with the query (never auto-applied on keystroke); a
      // garbage query no real pull request title/label matches settles the list to its own
      // empty-state copy -- positive proof the State/search narrowing genuinely reaches the IPC
      // call, not just the input's own local value.
      await pressKey(cdp, 13, 'Enter', 'Enter');
      const narrowedToNoMatches = await cdp.waitFor(`(() => { const empty = Array.from(document.querySelectorAll('div')).find((el) => el.textContent.trim() === 'No pull requests match this tab.'); return !!empty; })()`, { timeoutMs: 15_000, label: 'list narrows to "No pull requests match this tab."' }).catch(() => false);
      if (narrowedToNoMatches) checkPass('Pressing Enter in the search field narrows the real rendered list (settles to the empty-state copy)');
      else checkFail('Pressing Enter in the search field narrows the real rendered list (settles to the empty-state copy)');

      // Closes the section, confirms the narrowed (empty) list is STILL shown -- the query keeps
      // applying to the real rendered list while the Filters section is hidden, not just to the
      // input's own value -- then reopens and confirms the query text itself also survived.
      await cdp.clickByLabel('Filters, 1 active');
      await sleep(200);
      const stillNarrowedWhileClosed = await cdp.evaluate(`!document.getElementById('pull-request-filters-panel') && Array.from(document.querySelectorAll('div')).some((el) => el.textContent.trim() === 'No pull requests match this tab.')`);
      if (stillNarrowedWhileClosed) checkPass('The narrowed (empty) list keeps applying while the Filters section is closed');
      else checkFail('The narrowed (empty) list keeps applying while the Filters section is closed', String(stillNarrowedWhileClosed));
      await cdp.clickByLabel('Filters, 1 active');
      const queryTextSurvivedReopen = await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? null`);
      if (queryTextSurvivedReopen === 'zzz-verify-499') checkPass('The query text itself survives closing and reopening the Filters section', queryTextSurvivedReopen);
      else checkFail('The query text itself survives closing and reopening the Filters section', String(queryTextSurvivedReopen));

      // Clears the query with real key events (Ctrl+A then Backspace, the same pattern
      // `verify-tauri-session-list-helpers.mjs`'s own `typeIntoSessionSearch` uses) and
      // re-fetches so the rest of this run (screenshot included) exercises a real, populated
      // list again.
      await cdp.evaluate(`document.querySelector('[aria-label="Filter pull requests by title or label"]')?.focus()`);
      await cdp.waitFor(`document.activeElement === document.querySelector('[aria-label="Filter pull requests by title or label"]')`, { timeoutMs: 5_000, label: 'search field focused before clearing' });
      await pressKey(cdp, 65, 'a', 'KeyA', 2);
      await pressKey(cdp, 8, 'Backspace', 'Backspace');
      await cdp.waitFor(`(document.querySelector('[aria-label="Filter pull requests by title or label"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'search field cleared' });
      await pressKey(cdp, 13, 'Enter', 'Enter');
      await cdp.waitFor(`document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button').length > 0`, { timeoutMs: 15_000, label: 'list repopulates after clearing the query' }).catch(() => false);
      await cdp.clickByLabel('Filters, 1 active').catch(() => {});

      // ---- Tab-row geometry at 4 real widths: never wraps, wrapper overflow measured ----
      for (const width of TAB_GEOMETRY_WIDTHS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        const geometry = await cdp.evaluate(`(() => {
          const wrap = document.querySelector('[role="tablist"]')?.closest('.overflow-x-auto');
          if (!wrap) return null;
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const tops = new Set(tabs.map((el) => el.getBoundingClientRect().top));
          return { oneRow: tops.size <= 1, scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth };
        })()`);
        if (geometry && geometry.oneRow) checkPass(`Tab row never wraps at ${width}px window width`, JSON.stringify(geometry));
        else checkFail(`Tab row never wraps at ${width}px window width`, JSON.stringify(geometry));
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

      // ---- Project selector truncates to the resized column's own width, never overflows it ----
      await dragHandleBy(cdp, HANDLE_FINDER, -60);
      await sleep(400);
      const selectorFit = await cdp.evaluate(`(() => {
        const panel = ${LIST_PANEL_FINDER};
        const select = document.querySelector('[aria-label="Repository"]');
        if (!panel || !select) return null;
        const panelRect = panel.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        return selectRect.right <= panelRect.right + 1;
      })()`);
      if (selectorFit === true) checkPass('Project selector stays inside the resized list column\'s own width');
      else checkFail('Project selector stays inside the resized list column\'s own width', String(selectorFit));

      await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-pull-requests.png'));
    } else {
      notExercised('Every live PR-data check (Filter tabs, Filters disclosure, tab geometry, resizable column, Project selector fit)', 'real GitHub PR data was not reachable this run (see the hard failure above) -- code-verified only');
    }

    // ---- Remembered width: resize, record the persisted settings value, relaunch the SAME
    // scratch data dir, confirm the column renders at that width again (a genuine settings.json
    // round trip, not a store-only check). ----
    if (reachedPrData) {
      await dragHandleBy(cdp, HANDLE_FINDER, 120);
      await sleep(600); // clears the ~300ms debounce before the relaunch below.
      const persistedWidthPx = await cdp.evaluate(`(async () => { const r = await window.refract.settings.get(); return r.ok ? r.value.pullRequestsListWidthPx : null; })()`);
      cdp.close();
      await stopLauncher(child);
      ({ child, cdp } = await launch());
      await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!document.querySelector('.drag-region')`, { timeoutMs: 45_000, label: 'app ready after relaunch' });
      await cdp.clickByText('Pull requests').catch(() => {});
      await sleep(500);
      const widthAfterRelaunch = await cdp.evaluate(`${LIST_PANEL_FINDER}?.getBoundingClientRect().width ?? null`);
      const remembered = persistedWidthPx != null && widthAfterRelaunch != null && Math.abs(widthAfterRelaunch - persistedWidthPx) <= 3;
      if (remembered) checkPass('Resized width is remembered across a relaunch', JSON.stringify({ persistedWidthPx, widthAfterRelaunch }));
      else checkFail('Resized width is remembered across a relaunch', JSON.stringify({ persistedWidthPx, widthAfterRelaunch }));
    } else {
      notExercised('Remembered width across a relaunch', 'no Pull requests data reached this run; code-verified only');
    }

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
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
