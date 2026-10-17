#!/usr/bin/env node
// Session list search live check (issue #559) against the scratch Tauri debug build. Reuses the
// shared CDP primitives (verify-tauri-cdp.mjs) and session-list driving helpers
// (verify-tauri-session-list-helpers.mjs) the #735/#567 scripts already established; adds only
// what is new here -- driving the search field itself and reading its own announcement region.
//
// Proves, against the real rendered DOM (CDP Accessibility domain for accessible names, never
// textContent):
//   - Typing a query that matches nothing hides every Project group and Archived, and shows the
//     "No sessions match" empty state with a working Clear filter button.
//   - Typing a query matching one Session's name shows only that Session's own Project group
//     (its OTHER sibling Project hidden entirely), forced OPEN even though it was manually
//     collapsed before the search started -- and that collapse returns once the query clears.
//   - Typing a Project's own name shows that whole Project's group (every row), since every
//     Session in it matches on Project name.
//   - Esc and the in-field Clear button both restore the full list and the exact pre-search
//     collapsed/expanded state, asserted via settings.json on disk (byte-identical), not just
//     the DOM.
//   - Tab order: Pull requests -> search field -> (Clear filter, only while there is text) ->
//     Collapse all groups -- and Shift+Tab reverses the same path back to the field.
//   - The result count announcement (debounced while typing; immediate "Filter cleared").
//   - The query (and the filtering) survive a Settings round trip (App.tsx remounts the list)
//     AND switching to a different open Session (not just a view swap).
//   - Ctrl+N's own fallback, when the search hides every Project, focuses the search field
//     instead of the (now-absent) quick-create button.
//   - Branch matching and case-insensitivity: renaming a Session decouples its name from its
//     (unchanged) branch, and a query for the branch -- including upper-cased -- still matches.
//   - Renaming a Session out of the active filter (a second rename matching neither its new
//     name, its branch, nor either Project's own name) moves focus to the search field instead
//     of <body> once the row (and its own now-matchless Project) actually unmounts -- the #900
//     pattern.
//   - Archived is searched the same way, against each archived row's own Project name (run
//     LAST: this is the only block that needs an archived Session at all, per Main's
//     2026-10-16 review -- every other check above runs first so one flaky archive step cannot
//     block them); a query matching an active Session but no archived row hides Archived too
//     (the reverse case), and so does a totally non-matching query, now that Archived exists.
//
// Isolation (refract-tauri-live-check-isolation skill): same pattern as verify-tauri-735.mjs.

import { mkdtempSync, mkdirSync, copyFileSync, existsSync, createWriteStream, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  launchViaJobObject,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger
} from './verify-tauri-cdp.mjs';
import {
  getActiveElementAccessibleName,
  pressTab,
  pressEscape,
  pressKey,
  groupTriggerFinder,
  ARCHIVED_TRIGGER_FINDER,
  groupState,
  createSessionViaQuickCreate,
  addRepository,
  typeIntoSessionSearch as typeSearch,
  proveRenameMatchingAndSessionSwitch,
  proveProjectRenameFocusRedirect,
  proveCreatedSessionHiddenAnnouncement,
  SEARCH_INPUT_FINDER,
  readJson,
  firstRowActionsFinder,
  openRowActionsMenu,
  clickMenuItem
} from './verify-tauri-session-list-helpers.mjs';
import { gitHead, sha256OfFile, buildLauncher, makeScratchRepo, safeRmSync, citeScreenshots, clearKnownOutputFiles, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOT_DIR = process.env.REFRACT_559_SHOT_DIR || path.join(tmpdir(), 'refract-559-shots');

const SEARCH_INPUT = SEARCH_INPUT_FINDER;
const CLEAR_BUTTON = `document.querySelector('[data-session-search-region] button[aria-label="Clear filter"]')`;
const ANNOUNCE_REGION = `document.querySelector('[data-session-search-region] [aria-live="polite"]')`;
const EMPTY_TITLE = `Array.from(document.querySelectorAll('[data-slot="empty-title"]')).find((el) => el.textContent.trim() === 'No sessions match')`;
const CLEAR_FILTER_BUTTON = `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Clear filter')`;

function assert(cond, message) { if (!cond) throw new Error(`ASSERTION FAILED: ${message}`); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function spawnSync_(cmd, args, opts = {}) { return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }); }

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

// Issue #559 live-check hazard, confirmed live (2026-10-16): the shared `CARGO_TARGET_DIR` is
// rebuilt by whichever lane's own build runs next, overwriting `debug/refract-tauri.exe` out
// from under a script that re-reads it on every retry -- a second run here picked up a
// DIFFERENT exe hash than the first with no code change of its own and failed for an unrelated
// reason. `REFRACT_559_FROZEN_EXE`, when set, is copied from directly instead of the shared
// target dir: build once, freeze a copy immediately, then every retry reuses that exact exe.
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = process.env.REFRACT_559_FROZEN_EXE || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src} -- build it first (pnpm exec tauri build --debug --no-bundle)`);
  // Gate round 2 fix (Medium): the SOURCE file's own mtime -- when cargo actually produced this
  // exe -- not the copy's (which would just read "now", telling a reviewer nothing).
  const buildTime = statSync(src).mtime.toISOString();
  copyFileSync(src, dest);
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`verify-tauri-559: copied exe sha256 ${hash} (${dest}, source ${src}, built ${buildTime})`);
  return { dest, hash, buildTime };
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function worktreesDirFor(repoDir) { return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir)); }

// Both announcement checks below wait for the EXACT (or matching) text to appear, rather than
// reading "whatever is there now" -- a region that already holds a PREVIOUS announcement (for
// example this same search field's own earlier "Filter cleared") reads as non-empty the instant
// a poll runs, before the real, newly-debounced update has landed; waiting for the specific
// expected value removes that race instead of needing a hand-tuned sleep before every read.
async function waitForAnnouncementText(cdp, regionExpr, expected, { timeoutMs = 10_000 } = {}) {
  await cdp.waitFor(`((${regionExpr})?.textContent?.trim() || '') === ${JSON.stringify(expected)}`, {
    timeoutMs,
    label: `announcement reads ${JSON.stringify(expected)}`
  });
}
async function waitForAnnouncementMatch(cdp, regionExpr, regexSource, { timeoutMs = 10_000 } = {}) {
  return cdp.waitFor(
    `(() => { const t = (${regionExpr})?.textContent?.trim() || ''; return new RegExp(${JSON.stringify(regexSource)}).test(t) ? t : false; })()`,
    { timeoutMs, label: `announcement matches /${regexSource}/` }
  );
}

/** Ctrl+N's own fallback text (`announceQuickCreateFallback`, `lib/quickCreateFallback.ts`)
 *  goes through the APP-LEVEL `useChatAreaAnnouncer` (App.tsx's single global
 *  `aria-live="polite"` region, shared with #735's Collapse/Expand announcements) -- a
 *  DIFFERENT region from the search field's own local one, so it needs its own finder: the
 *  first `aria-live="polite"` region that is NOT nested inside the search field's own
 *  `data-session-search-region` wrapper. */
const CHAT_AREA_ANNOUNCE_REGION = `Array.from(document.querySelectorAll('[aria-live="polite"]')).find((el) => !el.closest('[data-session-search-region]'))`;

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-559: CDP target on port ${port} is not owned by this run's own process (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Wraps the shared `addRepository` helper with failure diagnostics (a screenshot plus the
 *  dialog's own DOM state at the moment the wait timed out) -- added after this exact step
 *  intermittently timed out on its second call with no app-side error logged, so the root
 *  cause needed more than a bare stack trace to isolate. */
async function addRepositoryDiag(cdp, dir, evidenceDir, log, label) {
  try {
    await addRepository(cdp, dir);
  } catch (err) {
    const diag = await cdp.evaluate(
      `(() => ({ dialogPresent: !!document.querySelector('[role="dialog"]'), dialogInputValue: document.querySelector('[role="dialog"] input')?.value ?? null, dialogButtons: Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent.trim()), footerAddButtons: Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === 'Add repository').length, activeElement: document.activeElement?.tagName }))()`
    );
    log(`verify-tauri-559: addRepository("${label}") FAILED -- diagnostics: ${JSON.stringify(diag, null, 2)}`);
    await cdp.screenshot(path.join(evidenceDir, `99-diag-add-repository-${label}-failure.png`));
    throw err;
  }
}

async function runChecks(cdp, evidenceDir, log, { repoA, repoB, repoAName, repoBName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepositoryDiag(cdp, repoA, evidenceDir, log, 'A');
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository A group rendered' });
  await addRepositoryDiag(cdp, repoB, evidenceDir, log, 'B');
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository B group rendered' });
  log('STEP PASS: both scratch Projects added.');
  // Gate round 5 (Main's finding 10): the search field's own `role="search"` landmark
  // (`SessionList.tsx` decision 3) is a real, rendered attribute, not just claimed in prose.
  assert((await cdp.evaluate(`!!document.querySelector('[role="search"][aria-label="Sessions"]')`)) === true, 'the session search field must sit inside a role="search" landmark');
  log('STEP PASS: the search field sits inside a role="search" landmark.');

  // ---- Ctrl+N fallback (run HERE, before any Session exists): App.tsx's own fallback target
  // resolution (no focused pane, 2+ Projects) only falls into the "no repository resolved"
  // branch this story changed when NO pane is already focused -- once a Session is created and
  // open later in this script, Ctrl+N instead targets that Session's own Project directly,
  // regardless of search, so this is the one point in the run where the fallback genuinely
  // applies. Without a search query, it would simply focus Project A's own "+" (both groups
  // render; decision 26 is untouched); with every Project hidden by search, "+" cannot be
  // found, and the new fallback text must fire instead. ----
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: 'empty state shown before the Ctrl+N fallback check' });
  await cdp.evaluate(`document.activeElement?.blur()`);
  await pressKey(cdp, 78, 'n', 'KeyN', 2); // Ctrl+N (modifiers bitmask: Ctrl = 2)
  await cdp.waitFor(`document.activeElement === (${SEARCH_INPUT})`, { timeoutMs: 10_000, label: 'Ctrl+N focuses the search field once it is the reason no Project is visible' });
  await waitForAnnouncementText(cdp, CHAT_AREA_ANNOUNCE_REGION, 'Clear the filter to choose a project for the new session');
  log('STEP PASS: Ctrl+N, when the search hides every Project (and no Session pane is open yet to resolve one directly), focuses the search field and announces the correct, filter-aware fallback text.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the Ctrl+N check' });

  // One Session per Project, enough for every check except Archived's own (that needs a second,
  // archived Session in Project A -- created and archived LAST, per Main's 2026-10-16 review,
  // so one flaky archive step can never block the checks above it).
  await createSessionViaQuickCreate(cdp, repoAName);
  const sessionA1Name = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoAName)})); const btn = group?.querySelector('li [data-session-open]'); return btn ? btn.getAttribute('aria-label').split(',')[0] : null; })()`
  );
  await createSessionViaQuickCreate(cdp, repoBName);
  assert(sessionA1Name, `Project A's own Session name must be captured (got ${JSON.stringify(sessionA1Name)})`);
  log(`STEP PASS: Session "${sessionA1Name}" created in Project A; a Session created in Project B.`);

  // Manually collapse Project A -- the state the search's own override must respect once the
  // query clears, and must NOT respect (forces it open) while a query matches it.
  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Project A collapsed by its own header click' });
  await sleep(400); // let the 300ms debounced persist land before reading settings.json below
  const dataDirForSettings = cdp.__dataDir;
  const settingsBeforeSearch = readJson(path.join(dataDirForSettings, 'settings.json'));
  const settingsBeforeSearchHash = sha256OfFile(path.join(dataDirForSettings, 'settings.json'));
  log(`STEP PASS: Project A collapsed before any search; settings.json: ${JSON.stringify(settingsBeforeSearch.sessionListCollapse)} (sha256 ${settingsBeforeSearchHash})`);

  // ---- Zero matches: "No sessions match" empty state, both groups and Archived gone ----
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: '"No sessions match" empty state shown' });
  assert((await cdp.evaluate(groupTriggerFinder(repoAName) + ' === undefined')) === true, 'Project A group must be gone from the DOM on zero matches');
  assert((await cdp.evaluate(groupTriggerFinder(repoBName) + ' === undefined')) === true, 'Project B group must be gone from the DOM on zero matches');
  await waitForAnnouncementText(cdp, ANNOUNCE_REGION, 'No sessions match');
  log('STEP PASS: a non-matching query shows the empty state, hides every group, and announces "No sessions match".');
  await cdp.screenshot(path.join(evidenceDir, '01-dark-no-matches.png'));

  // ---- Clear filter button inside the empty state restores everything, incl. Project A's own
  // pre-search collapsed state ----
  await cdp.click(CLEAR_FILTER_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A group back after Clear filter' });
  assert((await cdp.evaluate(SEARCH_INPUT + '.value')) === '', 'the field must be empty after the empty-state Clear filter button');
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Project A must return to CLOSED (its own pre-search state), not forced open, once the query clears');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Project B must return to open');
  log('STEP PASS: the empty state\'s own Clear filter button restores the full list and Project A\'s exact pre-search collapsed state.');

  // ---- A query matching one Session's name: only that Project renders, forced OPEN despite
  // being manually collapsed; the sibling Project is hidden entirely ----
  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'Project B hidden (no match)' });
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Project A must show OPEN while a query matches it, overriding its own saved collapsed state');
  const rowsDuringSearch = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id] li')).map((el) => el.textContent).join('|')`);
  assert(rowsDuringSearch.includes(sessionA1Name), `the matching Session row ("${sessionA1Name}") must render inside Project A (got: ${JSON.stringify(rowsDuringSearch)})`);
  const matchAnnouncement = await waitForAnnouncementMatch(cdp, ANNOUNCE_REGION, '^Showing 1 of \\d+ sessions$');
  assert(/^Showing 1 of \d+ sessions$/.test(matchAnnouncement), `announcement must read "Showing 1 of N sessions" (got ${JSON.stringify(matchAnnouncement)})`);
  log(`STEP PASS: a name query shows only the matching Session, forces its Project open, hides the sibling Project; announced ${JSON.stringify(matchAnnouncement)}.`);
  await cdp.screenshot(path.join(evidenceDir, '02-dark-one-match-forced-open.png'));

  // ---- The Collapse all / Expand all toolbar stays interactive during a search (never a no-op
  // from a hard "force everything open") ----
  const collapseDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-disabled')`);
  assert(collapseDisabled !== 'true', 'Collapse all must NOT be aria-disabled while a search is showing an open group (the toolbar must stay live during a search)');
  await cdp.clickByLabel('Collapse all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Collapse all closes Project A during the search' });
  await cdp.clickByLabel('Expand all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all reopens Project A during the search' });
  log('STEP PASS: Collapse all / Expand all stay live and actually toggle the visible group while a search is active (not a dead no-op).');

  // ---- Esc clears the field and restores Project A's saved CLOSED state (never written to by
  // the toggle above, which only touched the search's own ephemeral override), proved by a
  // byte-identical settings.json, not only the DOM ----
  await cdp.click(SEARCH_INPUT);
  await pressEscape(cdp);
  await cdp.waitFor(SEARCH_INPUT + `.value === ''`, { timeoutMs: 5_000, label: 'Esc clears the field' });
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after Esc' });
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Project A must return to its saved CLOSED state after Esc (the in-search Collapse/Expand clicks above never touched the saved layout)');
  await waitForAnnouncementText(cdp, ANNOUNCE_REGION, 'Filter cleared');
  await sleep(400);
  const settingsAfterSearch = readJson(path.join(dataDirForSettings, 'settings.json'));
  const settingsAfterSearchHash = sha256OfFile(path.join(dataDirForSettings, 'settings.json'));
  assert(
    JSON.stringify(settingsAfterSearch.sessionListCollapse) === JSON.stringify(settingsBeforeSearch.sessionListCollapse),
    `settings.json's sessionListCollapse must be byte-identical before and after the whole search (got before=${JSON.stringify(settingsBeforeSearch.sessionListCollapse)}, after=${JSON.stringify(settingsAfterSearch.sessionListCollapse)})`
  );
  // Gate round 2 fix (Medium): the stronger, whole-FILE claim -- not merely the one field this
  // story touches, but every byte of settings.json, proving nothing else moved either.
  assert(
    settingsAfterSearchHash === settingsBeforeSearchHash,
    `settings.json must be byte-identical (sha256) before and after the whole search (got before=${settingsBeforeSearchHash}, after=${settingsAfterSearchHash})`
  );
  log(`STEP PASS: Esc clears the field, announces "Filter cleared", restores Project A's saved closed state, and settings.json is byte-identical to before the search (sha256 ${settingsAfterSearchHash} both times, the override never persisted).`);

  // ---- A Project-name query shows the WHOLE Project (every Session in it matches on Project
  // name) ----
  await typeSearch(cdp, repoBName);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' === undefined', { timeoutMs: 10_000, label: 'Project A hidden (its name does not match Project B\'s name)' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Project B must show, forced open, for its own Project-name query');
  log('STEP PASS: a Project-name query shows that whole Project (every Session matches on Project name) and hides the other Project.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the in-field Clear button' });
  log('STEP PASS: the in-field Clear (x) button restores the full list.');

  // ---- Tab order: Pull requests -> search field -> Clear filter (only while there is text) ->
  // Collapse all groups ----
  await cdp.evaluate(`document.querySelector('[aria-label="Pull requests"]').focus()`);
  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.role === 'searchbox' || /Filter sessions/.test(active.name ?? ''), `Tab after Pull requests must land on the search field (got ${JSON.stringify(active)})`);
  await cdp.send('Input.insertText', { text: sessionA1Name });
  await cdp.waitFor(CLEAR_BUTTON + ' !== null', { timeoutMs: 5_000, label: 'Clear button appears once the field has text' });
  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Clear filter', `Tab from the search field (non-empty) must land on Clear filter (got ${JSON.stringify(active)})`);
  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Collapse all groups', `Tab from Clear filter must land on Collapse all groups (got ${JSON.stringify(active)})`);
  log('STEP PASS: Tab order confirmed via real accessible names -- Pull requests -> search field -> Clear filter -> Collapse all groups.');
  // ---- Shift+Tab reverses the same path, back from the list to the field (gate round 2,
  // ui-architect-v3 High: only the forward direction had ever been driven). ----
  await pressKey(cdp, 9, 'Tab', 'Tab', 8); // Shift+Tab (modifiers bitmask: Shift = 8)
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Clear filter', `Shift+Tab from Collapse all groups must land back on Clear filter (got ${JSON.stringify(active)})`);
  await pressKey(cdp, 9, 'Tab', 'Tab', 8);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.role === 'searchbox' || /Filter sessions/.test(active.name ?? ''), `Shift+Tab from Clear filter must land back on the search field (got ${JSON.stringify(active)})`);
  log('STEP PASS: Shift+Tab reverses the same path from the list back to the search field.');
  // Cleanup: the in-field Clear button works regardless of what currently has focus (focus is
  // back on the search field itself now, after the Shift+Tab reversal above).
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after Clear (Tab-order check cleanup)' });
  await cdp.evaluate(`document.activeElement?.blur()`);
  // ---- Gate round 5 (Main's finding 10): a real keyboard Escape while focus is ON the Clear
  // (x) button itself, not just the input -- the wrapper's own handler (gate round 3 finding 9)
  // is meant to catch Esc from either child, but only the input had ever been driven. ----
  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(CLEAR_BUTTON + ' !== null', { timeoutMs: 5_000, label: 'Clear button appears for the Esc-on-button check' });
  await cdp.click(SEARCH_INPUT);
  await pressTab(cdp);
  const escActive = await getActiveElementAccessibleName(cdp);
  assert(escActive.name === 'Clear filter', `focus must be on Clear filter before pressing Esc (got ${JSON.stringify(escActive)})`);
  await pressEscape(cdp);
  await cdp.waitFor(SEARCH_INPUT + `.value === ''`, { timeoutMs: 5_000, label: 'Esc on the Clear button clears the field' });
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after Esc-on-Clear-button' });
  log('STEP PASS: a real keyboard Escape while focus is on the Clear (x) button itself (not just the input) also clears the filter.');

  // ---- Settings round trip: the query (and its filtering) survive opening Settings and
  // returning, since it lives in session-list-store.ts, not local component state ----
  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'Project B hidden before the Settings round trip' });
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Returned from Settings to chat' });
  await cdp.waitFor(SEARCH_INPUT + ' !== null', { timeoutMs: 15_000, label: 'Search field re-rendered after the Settings round trip' });
  assert((await cdp.evaluate(SEARCH_INPUT + '.value')) === sessionA1Name, 'the query text must survive the Settings round trip');
  assert((await cdp.evaluate(groupTriggerFinder(repoBName) + ' === undefined')) === true, 'Project B must still be hidden after the Settings round trip (filtering survives too)');
  log('STEP PASS: the search query and its filtering survive a Settings round trip (App.tsx remounts the whole session list on this view swap).');

  // ---- High-contrast screenshot of a filtered, forced-open group ----
  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'filtered for the high-contrast screenshot' });
  // Gate round 2 fix (ui-architect-v3 High): assert the MATCHING Project is actually open with
  // its row shown before shooting -- the earlier cut shot an empty state here once `typeSearch`
  // appended onto leftover text from the Settings-round-trip block above instead of replacing
  // it, which a bare "Project B hidden" wait never caught.
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Project A must show OPEN for the high-contrast screenshot');
  const hcRows = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id] li')).map((el) => el.textContent).join('|')`);
  assert(hcRows.includes(sessionA1Name), `the matching Session row must render for the high-contrast screenshot (got ${JSON.stringify(hcRows)})`);
  const themeResult = await cdp.evaluate(`window.refract.theme.set('dark-high-contrast').then((r) => r.ok)`);
  assert(themeResult === true, 'theme.set(dark-high-contrast) must succeed');
  await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'High-contrast theme applied' });
  const focusOutline = await cdp.evaluate(
    `(() => { const el = ${SEARCH_INPUT}; el.focus(); const cs = getComputedStyle(el); return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth }; })()`
  );
  log(`verify-tauri-559: search field's own computed focus outline under Dark high contrast: ${JSON.stringify(focusOutline)} (forced-colors itself is not emulatable live in this harness, same finding as #567's own hover:none note -- this measures the real Dark-high-contrast theme's own focus ring, not a forced-colors mode).`);
  // Gate round 2 fix: move the real pointer off whatever it last hovered (the Settings cog's
  // own tooltip could still be open from the round-trip block above) -- the same `mouseMoved`
  // to a dead corner `proveTrailingSlotSwapAndHoverNone` already uses to clear hover.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await cdp.evaluate(`document.activeElement?.blur()`);
  // Gate round 3 fix (ui-architect-v3 Low, finding 7): the Settings cog's own tooltip (opened
  // by the Settings-round-trip block above) can still be fading out at this point -- wait for
  // it to actually leave the DOM, not just move the pointer away, before shooting.
  await cdp.waitFor(`!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 5_000, label: 'no tooltip showing before the high-contrast screenshot' });
  await cdp.screenshot(path.join(evidenceDir, '03-high-contrast-filtered.png'));
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('high-contrast')`, { timeoutMs: 10_000, label: 'back to Dark' });
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after the high-contrast check' });

  // ---- LAST: Archived, the only check that needs a second, archived Session. Create Session
  // A2, archive it via a real hover+click (openRowActionsMenu, fixed per Main's diagnosis), then
  // confirm Archived is searched the same way, against each row's own Project name. ----
  await createSessionViaQuickCreate(cdp, repoAName);
  const sessionA2Name = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoAName)})); const names = Array.from(group.querySelectorAll('li [data-session-open]')).map((b) => b.getAttribute('aria-label').split(',')[0]); return names.find((n) => n !== ${JSON.stringify(sessionA1Name)}); })()`
  );
  assert(sessionA2Name, `Project A's second Session name must be captured (got ${JSON.stringify(sessionA2Name)})`);
  await openRowActionsMenu(cdp, repoAName, evidenceDir, log);
  await clickMenuItem(cdp, 'Archive');
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session A2' });
  log(`STEP PASS: Session "${sessionA2Name}" archived via a real hover-then-click on its own row menu (Project A now has one active Session, "${sessionA1Name}", plus one archived).`);

  // ---- Rename, branch matching, case-insensitivity, the #900 focus-redirect, and surviving a
  // Session switch, all from one setup (gate round 2, ui-architect-v3/a11y-auditor High/Medium;
  // #806 file-size split: the proof itself lives in `verify-tauri-session-list-helpers.mjs` so
  // a future session-list story can reuse it). ----
  const { renamedTwiceName } = await proveRenameMatchingAndSessionSwitch(cdp, log, { repoAName, repoBName, sessionA1Name, CLEAR_BUTTON });
  // Gate round 3 (ui-architect-v3 finding 1): the Project half of the same #900 fix --
  // `RepositoryGroup.tsx`'s own `useFocusSearchOnStrandedUnmount` call.
  await proveProjectRenameFocusRedirect(cdp, log, { repoBName });
  // Gate round 3 (ui-architect-v3 finding 5): the hidden-create announcement, live -- query
  // matches only session A1 (`renamedTwiceName`), never Project A's own name, so a fresh
  // Session the "+" creates is Project-resolvable but still a non-match.
  await proveCreatedSessionHiddenAnnouncement(cdp, log, { repoAName, query: renamedTwiceName, chatAreaAnnounceRegionFinder: CHAT_AREA_ANNOUNCE_REGION });

  await typeSearch(cdp, repoAName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 10_000, label: 'Archived shown for a query matching its own row\'s Project name' });
  const archivedRowsForQuery = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] li').length`);
  assert(archivedRowsForQuery === 1, `Archived must show exactly the one matching archived row (got ${archivedRowsForQuery})`);
  log('STEP PASS: Archived is searched the same way, against each row\'s own Project name.');
  await cdp.click(CLEAR_BUTTON);

  // ---- Archived reverse (gate round 2, Medium): a query matching an ACTIVE Session but no
  // archived row must still hide Archived specifically -- distinct from the totally-empty case
  // below, which ran before any archived Session existed and never actually exercised this. ----
  await typeSearch(cdp, renamedTwiceName);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: "Project A matches its own twice-renamed Session for the Archived-reverse check" });
  assert((await cdp.evaluate(ARCHIVED_TRIGGER_FINDER + ' === null')) === true, 'Archived must be hidden when the query matches an active Session but no archived row');
  log('STEP PASS: Archived reverse -- a query matching an active Session but no archived row hides Archived.');

  // ---- Zero matches hides Archived too (gate round 2, High): the original zero-match check
  // ran before Session A2 was archived, so Archived did not exist yet to actually hide. ----
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: '"No sessions match" empty state shown with Archived present' });
  assert((await cdp.evaluate(ARCHIVED_TRIGGER_FINDER + ' === null')) === true, 'Archived must also be hidden on zero matches now that an archived Session actually exists');
  log('STEP PASS: zero matches hides Archived too, now that an archived Session exists to prove it.');
  await cdp.click(CLEAR_FILTER_BUTTON);

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  // Gate round 4 fix (Main's safety finding, MUST): `SHOT_DIR` can be redirected anywhere via
  // `REFRACT_559_SHOT_DIR` -- recursively deleting it was building a delete target from a
  // variable, exactly what the safe-deletion rule bans. Clears only this script's own known
  // output files by literal name instead (see `clearKnownOutputFiles`'s own guard).
  clearKnownOutputFiles(SHOT_DIR, 'refract-559-', [
    '01-dark-no-matches.png', '02-dark-one-match-forced-open.png', '03-high-contrast-filtered.png',
    '99-diag-row-actions-menu-failure.png', '99-diag-add-repository-A-failure.png', '99-diag-add-repository-B-failure.png',
    'report.json', 'report.txt', 'app.log', 'fake-omp-invocations.log'
  ]);
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  let shimDir, dataDir, importSourceDir, repoADir, repoBDir, exeDir;
  let child, cdp;
  let exitCode = 0;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-559-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-559-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-559-import-src-'));
    repoADir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-559-repoA-')), 'A');
    repoBDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-559-repoB-')), 'B');
    const repoAName = path.basename(repoADir);
    const repoBName = path.basename(repoBDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-559-exe-'));

    log(`verify-tauri-559: data dir ${dataDir}`);
    log(`verify-tauri-559: evidence dir ${SHOT_DIR}`);
    log(`verify-tauri-559: Project A ${repoADir} (name "${repoAName}")`);
    log(`verify-tauri-559: Project B ${repoBDir} (name "${repoBName}")`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash, buildTime: exeBuildTime } = copyBuiltExe(exeDir);
    const gitHeadValue = gitHead(REPO_ROOT);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOT_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOT_DIR, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);
    assertExeMatchesProcess(launched.targetPid, exePath, exeHash);
    cdp.__dataDir = dataDir;
    log(`verify-tauri-559: launched, pid ${launched.targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await runChecks(cdp, SHOT_DIR, log, { repoA: repoADir, repoB: repoBDir, repoAName, repoBName });

    log(`verify-tauri-559: ALL PASS. Evidence and screenshots: ${SHOT_DIR}`);
    // Gate round 3 fix (ui-architect-v3 Low, finding 7): cite each screenshot by sha256 too.
    const screenshots = citeScreenshots(SHOT_DIR, ['01-dark-no-matches.png', '02-dark-one-match-forced-open.png', '03-high-contrast-filtered.png']);
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        { gitHead: gitHeadValue, exitCode: 0, exeHash, exeBuildTime, screenshots, finishedAt: new Date().toISOString() },
        null,
        2
      )
    );
  } catch (err) {
    exitCode = 1;
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        {
          gitHead: gitHead(REPO_ROOT),
          exitCode: 1,
          error: String(err?.message ?? err),
          finishedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoADir) await safeRmSync(worktreesDirFor(repoADir));
    if (repoBDir) await safeRmSync(worktreesDirFor(repoBDir));
    await safeRmSync(repoADir);
    await safeRmSync(repoBDir);
    await safeRmSync(exeDir);
    // Deliberately NOT removing SHOT_DIR: its STEP-PASS report and screenshots are this run's
    // own audit trail (same convention as verify-tauri-735.mjs).
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error('verify-tauri-559: FAIL');
  console.error(err);
  process.exitCode = 1;
});
