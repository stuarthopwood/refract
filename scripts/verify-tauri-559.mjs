#!/usr/bin/env node
// Session list search live check (#559) against the scratch Tauri debug build: filtering, forced-open groups,
// collapse-state restore, tab order, announcements, rename/branch matching and Archived, via the real DOM.

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

// The shared target dir can be rebuilt by another lane mid-run, so `REFRACT_559_FROZEN_EXE` copies a frozen exe instead.
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = process.env.REFRACT_559_FROZEN_EXE || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src} -- build it first (pnpm exec tauri build --debug --no-bundle)`);
  // The source file's mtime (when cargo produced the exe), not the copy's.
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

// Wait for the exact expected text: a region holding a previous announcement reads non-empty before the debounced update lands.
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

/** Finds the app-level `aria-live="polite"` region (Ctrl+N fallback text), i.e. the one outside `data-session-search-region`. */
const CHAT_AREA_ANNOUNCE_REGION = `Array.from(document.querySelectorAll('[aria-live="polite"]')).find((el) => !el.closest('[data-session-search-region]'))`;

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-559: CDP target on port ${port} is not owned by this run's own process (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Wraps the shared `addRepository` helper with failure diagnostics (screenshot plus dialog DOM) for an intermittent timeout. */
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
  assert((await cdp.evaluate(`!!document.querySelector('[role="search"][aria-label="Sessions"]')`)) === true, 'the session search field must sit inside a role="search" landmark');
  log('STEP PASS: the search field sits inside a role="search" landmark.');

  // Ctrl+N fallback must run before any Session exists: once a Session is open, Ctrl+N targets its Project directly.
  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: 'empty state shown before the Ctrl+N fallback check' });
  await cdp.evaluate(`document.activeElement?.blur()`);
  await pressKey(cdp, 78, 'n', 'KeyN', 2); // Ctrl+N (modifiers bitmask: Ctrl = 2)
  await cdp.waitFor(`document.activeElement === (${SEARCH_INPUT})`, { timeoutMs: 10_000, label: 'Ctrl+N focuses the search field once it is the reason no Project is visible' });
  await waitForAnnouncementText(cdp, CHAT_AREA_ANNOUNCE_REGION, 'Clear the filter to choose a project for the new session');
  log('STEP PASS: Ctrl+N, when the search hides every Project (and no Session pane is open yet to resolve one directly), focuses the search field and announces the correct, filter-aware fallback text.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the Ctrl+N check' });

  // Archived's second Session is created and archived last so a flaky archive step can't block earlier checks.
  await createSessionViaQuickCreate(cdp, repoAName);
  const sessionA1Name = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoAName)})); const btn = group?.querySelector('li [data-session-open]'); return btn ? btn.getAttribute('aria-label').split(',')[0] : null; })()`
  );
  await createSessionViaQuickCreate(cdp, repoBName);
  assert(sessionA1Name, `Project A's own Session name must be captured (got ${JSON.stringify(sessionA1Name)})`);
  log(`STEP PASS: Session "${sessionA1Name}" created in Project A; a Session created in Project B.`);

  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Project A collapsed by its own header click' });
  await sleep(400); // let the 300ms debounced persist land before reading settings.json below
  const dataDirForSettings = cdp.__dataDir;
  const settingsBeforeSearch = readJson(path.join(dataDirForSettings, 'settings.json'));
  const settingsBeforeSearchHash = sha256OfFile(path.join(dataDirForSettings, 'settings.json'));
  log(`STEP PASS: Project A collapsed before any search; settings.json: ${JSON.stringify(settingsBeforeSearch.sessionListCollapse)} (sha256 ${settingsBeforeSearchHash})`);

  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: '"No sessions match" empty state shown' });
  assert((await cdp.evaluate(groupTriggerFinder(repoAName) + ' === undefined')) === true, 'Project A group must be gone from the DOM on zero matches');
  assert((await cdp.evaluate(groupTriggerFinder(repoBName) + ' === undefined')) === true, 'Project B group must be gone from the DOM on zero matches');
  await waitForAnnouncementText(cdp, ANNOUNCE_REGION, 'No sessions match');
  log('STEP PASS: a non-matching query shows the empty state, hides every group, and announces "No sessions match".');
  await cdp.screenshot(path.join(evidenceDir, '01-dark-no-matches.png'));

  await cdp.click(CLEAR_FILTER_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A group back after Clear filter' });
  assert((await cdp.evaluate(SEARCH_INPUT + '.value')) === '', 'the field must be empty after the empty-state Clear filter button');
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Project A must return to CLOSED (its own pre-search state), not forced open, once the query clears');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Project B must return to open');
  log('STEP PASS: the empty state\'s own Clear filter button restores the full list and Project A\'s exact pre-search collapsed state.');

  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'Project B hidden (no match)' });
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Project A must show OPEN while a query matches it, overriding its own saved collapsed state');
  const rowsDuringSearch = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id] li')).map((el) => el.textContent).join('|')`);
  assert(rowsDuringSearch.includes(sessionA1Name), `the matching Session row ("${sessionA1Name}") must render inside Project A (got: ${JSON.stringify(rowsDuringSearch)})`);
  const matchAnnouncement = await waitForAnnouncementMatch(cdp, ANNOUNCE_REGION, '^Showing 1 of \\d+ sessions$');
  assert(/^Showing 1 of \d+ sessions$/.test(matchAnnouncement), `announcement must read "Showing 1 of N sessions" (got ${JSON.stringify(matchAnnouncement)})`);
  log(`STEP PASS: a name query shows only the matching Session, forces its Project open, hides the sibling Project; announced ${JSON.stringify(matchAnnouncement)}.`);
  await cdp.screenshot(path.join(evidenceDir, '02-dark-one-match-forced-open.png'));

  const collapseDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-disabled')`);
  assert(collapseDisabled !== 'true', 'Collapse all must NOT be aria-disabled while a search is showing an open group (the toolbar must stay live during a search)');
  await cdp.clickByLabel('Collapse all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Collapse all closes Project A during the search' });
  await cdp.clickByLabel('Expand all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all reopens Project A during the search' });
  log('STEP PASS: Collapse all / Expand all stay live and actually toggle the visible group while a search is active (not a dead no-op).');

  // Compare settings.json byte-for-byte: the toggle above only touched the search's ephemeral override.
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
  assert(
    settingsAfterSearchHash === settingsBeforeSearchHash,
    `settings.json must be byte-identical (sha256) before and after the whole search (got before=${settingsBeforeSearchHash}, after=${settingsAfterSearchHash})`
  );
  log(`STEP PASS: Esc clears the field, announces "Filter cleared", restores Project A's saved closed state, and settings.json is byte-identical to before the search (sha256 ${settingsAfterSearchHash} both times, the override never persisted).`);

  await typeSearch(cdp, repoBName);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' === undefined', { timeoutMs: 10_000, label: 'Project A hidden (its name does not match Project B\'s name)' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Project B must show, forced open, for its own Project-name query');
  log('STEP PASS: a Project-name query shows that whole Project (every Session matches on Project name) and hides the other Project.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project A back after the in-field Clear button' });
  log('STEP PASS: the in-field Clear (x) button restores the full list.');

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
  await pressKey(cdp, 9, 'Tab', 'Tab', 8); // Shift+Tab (modifiers bitmask: Shift = 8)
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Clear filter', `Shift+Tab from Collapse all groups must land back on Clear filter (got ${JSON.stringify(active)})`);
  await pressKey(cdp, 9, 'Tab', 'Tab', 8);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.role === 'searchbox' || /Filter sessions/.test(active.name ?? ''), `Shift+Tab from Clear filter must land back on the search field (got ${JSON.stringify(active)})`);
  log('STEP PASS: Shift+Tab reverses the same path from the list back to the search field.');
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after Clear (Tab-order check cleanup)' });
  await cdp.evaluate(`document.activeElement?.blur()`);
  // Escape from the Clear button itself must also clear (the wrapper handles Esc from either child).
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

  await typeSearch(cdp, sessionA1Name);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' === undefined', { timeoutMs: 10_000, label: 'filtered for the high-contrast screenshot' });
  // Assert the matching Project is open before shooting: `typeSearch` once appended to leftover text and shot an empty state.
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
  // Move the pointer to a dead corner so the Settings cog's tooltip isn't open in the shot.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await cdp.evaluate(`document.activeElement?.blur()`);
  // The cog's tooltip can still be fading out; wait for it to leave the DOM before shooting.
  await cdp.waitFor(`!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 5_000, label: 'no tooltip showing before the high-contrast screenshot' });
  await cdp.screenshot(path.join(evidenceDir, '03-high-contrast-filtered.png'));
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('high-contrast')`, { timeoutMs: 10_000, label: 'back to Dark' });
  await cdp.click(CLEAR_BUTTON);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 10_000, label: 'Project B back after the high-contrast check' });

  // Archived goes last: it is the only check needing a second, archived Session.
  await createSessionViaQuickCreate(cdp, repoAName);
  const sessionA2Name = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoAName)})); const names = Array.from(group.querySelectorAll('li [data-session-open]')).map((b) => b.getAttribute('aria-label').split(',')[0]); return names.find((n) => n !== ${JSON.stringify(sessionA1Name)}); })()`
  );
  assert(sessionA2Name, `Project A's second Session name must be captured (got ${JSON.stringify(sessionA2Name)})`);
  await openRowActionsMenu(cdp, repoAName, evidenceDir, log);
  await clickMenuItem(cdp, 'Archive');
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session A2' });
  log(`STEP PASS: Session "${sessionA2Name}" archived via a real hover-then-click on its own row menu (Project A now has one active Session, "${sessionA1Name}", plus one archived).`);

  // Proof lives in `verify-tauri-session-list-helpers.mjs` (#806 file-size split).
  const { renamedTwiceName } = await proveRenameMatchingAndSessionSwitch(cdp, log, { repoAName, repoBName, sessionA1Name, CLEAR_BUTTON });
  await proveProjectRenameFocusRedirect(cdp, log, { repoBName });
  // The query matches only A1, so the fresh Session "+" creates is Project-resolvable but a non-match.
  await proveCreatedSessionHiddenAnnouncement(cdp, log, { repoAName, query: renamedTwiceName, chatAreaAnnounceRegionFinder: CHAT_AREA_ANNOUNCE_REGION });

  await typeSearch(cdp, repoAName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 10_000, label: 'Archived shown for a query matching its own row\'s Project name' });
  const archivedRowsForQuery = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] li').length`);
  assert(archivedRowsForQuery === 1, `Archived must show exactly the one matching archived row (got ${archivedRowsForQuery})`);
  log('STEP PASS: Archived is searched the same way, against each row\'s own Project name.');
  await cdp.click(CLEAR_BUTTON);

  await typeSearch(cdp, renamedTwiceName);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 10_000, label: "Project A matches its own twice-renamed Session for the Archived-reverse check" });
  assert((await cdp.evaluate(ARCHIVED_TRIGGER_FINDER + ' === null')) === true, 'Archived must be hidden when the query matches an active Session but no archived row');
  log('STEP PASS: Archived reverse -- a query matching an active Session but no archived row hides Archived.');

  await typeSearch(cdp, 'zzz-no-such-session-zzz');
  await cdp.waitFor(EMPTY_TITLE + ' !== undefined', { timeoutMs: 10_000, label: '"No sessions match" empty state shown with Archived present' });
  assert((await cdp.evaluate(ARCHIVED_TRIGGER_FINDER + ' === null')) === true, 'Archived must also be hidden on zero matches now that an archived Session actually exists');
  log('STEP PASS: zero matches hides Archived too, now that an archived Session exists to prove it.');
  await cdp.click(CLEAR_FILTER_BUTTON);

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  // `SHOT_DIR` is redirectable, so clear only known output files by literal name, never a variable-built delete target.
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
    // SHOT_DIR is kept: its report and screenshots are the run's audit trail.
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error('verify-tauri-559: FAIL');
  console.error(err);
  process.exitCode = 1;
});
