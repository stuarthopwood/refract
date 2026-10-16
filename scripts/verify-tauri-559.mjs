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
//     Collapse all groups.
//   - The result count announcement (debounced while typing; immediate "Filter cleared").
//   - The query (and the filtering) survive a Settings round trip (App.tsx remounts the list).
//   - Ctrl+N's own fallback, when the search hides every Project, focuses the search field
//     instead of the (now-absent) quick-create button.
//   - Archived is searched the same way, against each archived row's own Project name (run
//     LAST: this is the only check that needs an archived Session at all, per Main's 2026-10-16
//     review -- every other check above runs first so one flaky archive step cannot block them).
//
// Isolation (refract-tauri-live-check-isolation skill): same pattern as verify-tauri-735.mjs.

import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
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
  addRepository
} from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOT_DIR = process.env.REFRACT_559_SHOT_DIR || path.join(tmpdir(), 'refract-559-shots');

const SEARCH_INPUT = `document.querySelector('[data-session-search-region] input')`;
const CLEAR_BUTTON = `document.querySelector('[data-session-search-region] button[aria-label="Clear filter"]')`;
const ANNOUNCE_REGION = `document.querySelector('[data-session-search-region] [aria-live="polite"]')`;
const EMPTY_TITLE = `Array.from(document.querySelectorAll('[data-slot="empty-title"]')).find((el) => el.textContent.trim() === 'No sessions match')`;
const CLEAR_FILTER_BUTTON = `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Clear filter')`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-launcher.rs'), '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
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
  copyFileSync(src, dest);
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`verify-tauri-559: copied exe sha256 ${hash} (${dest}, source ${src})`);
  return { dest, hash };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${nowStamp()}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${nowStamp()}.pid`);
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

function makeScratchRepo(dir, label) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'Verify Tauri 559']);
  run(['config', 'user.email', 'verify-tauri-559@example.invalid']);
  run(['commit', '-q', '--allow-empty', '-m', `init ${label}`]);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri-559: could not remove ${dir}: ${err.message}`);
        return;
      }
      await sleep(1000);
    }
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Types into the search field via a real click plus `Input.insertText`, matching the pattern
 * `CdpSession.typeIntoByLabel` uses for an aria-labelled field -- this field's own name is the
 * long `aria-label`, so it is targeted by the stable `data-session-search-region` marker
 * instead. */
async function typeSearch(cdp, text) {
  await cdp.click(SEARCH_INPUT);
  await cdp.send('Input.insertText', { text });
}

async function readAnnouncement(cdp, { timeoutMs = 30_000 } = {}) {
  return cdp.waitFor(`(${ANNOUNCE_REGION})?.textContent?.trim() || ''`, { timeoutMs, label: 'search announcement region non-empty' });
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-559: CDP target on port ${port} is not owned by this run's own process (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Finder for the FIRST (most-recently-active) Session row's own "... actions" trigger inside
 * the named Project's group. */
function firstRowActionsFinder(repoName) {
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
async function openRowActionsMenu(cdp, repoName, evidenceDir, log) {
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

async function clickMenuItem(cdp, text) {
  const finder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
  await cdp.waitFor(finder + ' !== undefined', { timeoutMs: 10_000, label: `menu item "${text}" present` });
  await cdp.click(finder);
}

async function runChecks(cdp, evidenceDir, log, { repoA, repoB, repoAName, repoBName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoA);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository A group rendered' });
  await addRepository(cdp, repoB);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository B group rendered' });
  log('STEP PASS: both scratch Projects added.');

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
  log(`STEP PASS: Project A collapsed before any search; settings.json: ${JSON.stringify(settingsBeforeSearch.sessionListCollapse)}`);

  // ---- Zero matches: "No sessions match" empty state, both groups and Archived gone ----
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: '"No sessions match" empty state shown' });
  assert((await cdp.evaluate(groupTriggerFinder(repoAName) + ' === undefined')) === true, 'Project A group must be gone from the DOM on zero matches');
  assert((await cdp.evaluate(groupTriggerFinder(repoBName) + ' === undefined')) === true, 'Project B group must be gone from the DOM on zero matches');
  const zeroAnnouncement = await readAnnouncement(cdp);
  assert(zeroAnnouncement === 'No sessions match', `announcement on zero matches must read "No sessions match" (got ${JSON.stringify(zeroAnnouncement)})`);
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
  await sleep(600); // debounce window
  const matchAnnouncement = await readAnnouncement(cdp);
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
  const clearedAnnouncement = await readAnnouncement(cdp);
  assert(clearedAnnouncement === 'Filter cleared', `Esc must announce "Filter cleared" immediately (got ${JSON.stringify(clearedAnnouncement)})`);
  await sleep(400);
  const settingsAfterSearch = readJson(path.join(dataDirForSettings, 'settings.json'));
  assert(
    JSON.stringify(settingsAfterSearch.sessionListCollapse) === JSON.stringify(settingsBeforeSearch.sessionListCollapse),
    `settings.json's sessionListCollapse must be byte-identical before and after the whole search (got before=${JSON.stringify(settingsBeforeSearch.sessionListCollapse)}, after=${JSON.stringify(settingsAfterSearch.sessionListCollapse)})`
  );
  log('STEP PASS: Esc clears the field, announces "Filter cleared", restores Project A\'s saved closed state, and settings.json is byte-identical to before the search (the override never persisted).');

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
  await pressEscape(cdp);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after Esc (Tab-order check cleanup)' });
  await cdp.evaluate(`document.activeElement?.blur()`);

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

  // ---- Ctrl+N fallback: once the search hides every Project, Ctrl+N focuses the search field
  // instead of the (absent) quick-create button ----
  await cdp.click(CLEAR_BUTTON);
  await cdp.evaluate(`document.activeElement?.blur()`);
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: 'empty state shown before the Ctrl+N fallback check' });
  await cdp.evaluate(`document.activeElement?.blur()`);
  await pressKey(cdp, 78, 'n', 'KeyN', 2); // Ctrl+N (modifiers bitmask: Ctrl = 2)
  await cdp.waitFor(`document.activeElement === (${SEARCH_INPUT})`, { timeoutMs: 10_000, label: 'Ctrl+N focuses the search field once it is the reason no Project is visible' });
  const ctrlNAnnouncement = await readAnnouncement(cdp);
  assert(ctrlNAnnouncement === 'Clear the filter to choose a project for the new session', `Ctrl+N's own announcement must name the filter (got ${JSON.stringify(ctrlNAnnouncement)})`);
  log('STEP PASS: Ctrl+N, when the search hides every Project, focuses the search field and announces the correct, filter-aware fallback text.');
  await cdp.click(CLEAR_BUTTON);

  // ---- High-contrast screenshot of a filtered, forced-open group ----
  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'filtered for the high-contrast screenshot' });
  const themeResult = await cdp.evaluate(`window.refract.theme.set('dark-high-contrast').then((r) => r.ok)`);
  assert(themeResult === true, 'theme.set(dark-high-contrast) must succeed');
  await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'High-contrast theme applied' });
  const focusOutline = await cdp.evaluate(
    `(() => { const el = ${SEARCH_INPUT}; el.focus(); const cs = getComputedStyle(el); return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth }; })()`
  );
  log(`verify-tauri-559: search field's own computed focus outline under Dark high contrast: ${JSON.stringify(focusOutline)} (forced-colors itself is not emulatable live in this harness, same finding as #567's own hover:none note -- this measures the real Dark-high-contrast theme's own focus ring, not a forced-colors mode).`);
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

  await typeSearch(cdp, repoAName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 10_000, label: 'Archived shown for a query matching its own row\'s Project name' });
  const archivedRowsForQuery = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] li').length`);
  assert(archivedRowsForQuery === 1, `Archived must show exactly the one matching archived row (got ${archivedRowsForQuery})`);
  log('STEP PASS: Archived is searched the same way, against each row\'s own Project name.');
  await cdp.click(CLEAR_BUTTON);

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
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
    const { dest: exePath, hash: exeHash } = copyBuiltExe(exeDir);

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
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        { gitHead: process.env.REFRACT_559_GIT_HEAD || null, exitCode: 0, exeHash, finishedAt: new Date().toISOString() },
        null,
        2
      )
    );
  } catch (err) {
    exitCode = 1;
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        { gitHead: process.env.REFRACT_559_GIT_HEAD || null, exitCode: 1, error: String(err?.message ?? err), finishedAt: new Date().toISOString() },
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
