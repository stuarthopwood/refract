#!/usr/bin/env node
// Session list collapse/expand live check (issue #735) against the scratch Tauri debug build.
// Standalone script (same precedent as verify-tauri-ask.mjs/verify-tauri-side-chat.mjs:
// duplicates the small build/copy/launch glue, reuses verify-tauri-cdp.mjs's CDP primitives).
//
// Proves, against the real rendered DOM (never window.refract.* as a shortcut for anything the
// UI itself should do -- window.refract.theme.set is the one exception, used only to switch
// themes between screenshots, exactly the real IPC call the Appearance section itself makes):
//   - The Collapse all / Expand all toolbar closes/opens every Repository group plus Archived
//     together, is keyboard-reachable right after Pull requests, its focus outline actually
//     renders at decision 23's exact 2px solid value (computed style after the transition
//     settles, never a bare truthy check), and a REAL second click on an already-disabled
//     button changes nothing (not just that the attribute reads aria-disabled).
//   - A closed group holding a Session with a pending approval (status needs-you) shows a single
//     Waiting marker, readable in the group header's own computed accessible name (CDP
//     Accessibility domain, never textContent).
//   - An archived Session, still the focused/visible pane at the moment it is archived, does NOT
//     leak its "contains open session" bar or Waiting marker onto its OLD Repository's header
//     once that header is collapsed -- only Archived's own header may carry that cue for it.
//   - A closed group re-opens (and that open persists) when a create (the header "+") or a
//     restore from Archived actually moves a Session into it.
//   - Decision 29's Settings round trip: a collapsed group stays collapsed (and nothing
//     re-expands) after opening Settings and returning to chat, which remounts the whole list.
//   - Decision 29's prune: removing a Repository (zero Sessions, collapsed) actually drops its
//     id from `settings.json`, not just from the renderer's own in-memory Set.
//   - A genuinely MIXED collapse state (one Repository closed, one open, Archived open with a
//     Session still actually archived in it -- never the all-default "freshly started" shape)
//     survives a real app restart (quit, relaunch on the SAME scratch data dir, no wipe),
//     verified both by reading `sessionListCollapse` straight out of `settings.json` on disk
//     before the quit, and by the rendered DOM after the relaunch.
//   - The exe actually driving every CDP session is the exact scratch copy this run built and
//     hashed (`assertExeMatchesProcess`), not merely logged as a coincidence.
//
// Isolation (refract-tauri-live-check-isolation skill): REFRACT_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER
// are fresh scratch dirs; REFRACT_IMPORT_SOURCE_DIR is an empty scratch dir so the one-time
// Electron-registry import never reads Stuart's real %APPDATA%\pinion. The built exe is copied to
// its own scratch dir and run from there (never from the shared CARGO_TARGET_DIR). Every launch
// asserts the CDP target is actually owned by the pid this run started (isTargetOwningPort) AND
// that pid's own exe path/hash match the scratch copy (assertExeMatchesProcess) before driving it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
  getAccessibleName,
  getActiveElementAccessibleName,
  pressTab,
  pressEscape,
  groupTriggerFinder,
  ARCHIVED_TRIGGER_FINDER,
  groupState,
  hasActiveBar,
  archivedHasActiveBar,
  createSessionViaQuickCreate,
  archiveFirstRowIn,
  restoreOnlyArchivedRow,
  addRepository,
  buildMixedStateAndCheckDecision29
} from './verify-tauri-session-list-helpers.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);

// Gate round 2 fix (architect/test-reviewer Low): this is now where screenshots ACTUALLY land
// (round 1 logged this path but wrote every screenshot to a separate `evidenceDir` instead) --
// the run's STEP-PASS report, app logs and settings.json dumps live here too, and NONE of it is
// deleted in the `finally` block below (round 1 did not delete it either, but a later manual
// cleanup pass did -- this round's run is kept deliberately as the gate's own audit trail).
const SHOT_DIR = process.env.REFRACT_735_SHOT_DIR || 'C:/Users/shopwood/AppData/Local/Temp/refract-735-gate2-shots';

const PROMPT_MESSAGE = 'Please respond now.';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri-735: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildTauriDebugNoBundle() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) {
      env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
      env.CARGO_INCREMENTAL = '0';
      env.CARGO_BUILD_JOBS = '4';
    }
    const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build', '--debug', '--no-bundle'], {
      cwd: REPO_ROOT,
      env,
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024
    });
    if (result.status === 0) return;
    const locked = /Access is denied/i.test(result.stderr ?? '') || /Access is denied/i.test(result.stdout ?? '');
    if (!locked || attempt === maxAttempts) {
      throw new Error(`buildTauriDebugNoBundle: build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.warn(`verify-tauri-735: build exe locked, retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src}`);
  copyFileSync(src, dest);
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`verify-tauri-735: copied exe sha256 ${hash} (${dest})`);
  return { dest, hash };
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

function makeScratchRepo(dir, repoLabel) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'Verify Tauri 735']);
  run(['config', 'user.email', 'verify-tauri-735@example.invalid']);
  run(['commit', '-q', '--allow-empty', '-m', `init ${repoLabel}`]);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-735: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Reads and parses a JSON file straight off the scratch data dir -- used ONLY for the
 * persistence proof (reading what actually landed on disk), never as a shortcut for anything
 * the UI itself should be driven to do. */
function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

async function runChecks(cdp, evidenceDir, log, { repoA, repoB, repoC, repoAName, repoBName, repoCName }) {
  // ---- US1-equivalent: readiness, add all three scratch repositories (C stays empty: it is
  // decision 29's prune check's own target, collapsed once and removed later in main()) ----
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoA);
  try {
    await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository A group rendered' });
  } catch (err) {
    const diag = await cdp.evaluate(
      `({ repoHtml: document.querySelector('[data-repository-id]')?.outerHTML?.slice(0, 3000), anyDataSlot: Array.from(document.querySelectorAll('[data-slot]')).map((el) => el.getAttribute('data-slot')) })`
    );
    console.error('verify-tauri-735: Repository A group never rendered; diagnostics:', JSON.stringify(diag, null, 2));
    await cdp.screenshot(path.join(evidenceDir, '00-diag-repo-a-failure.png'));
    throw err;
  }
  await addRepository(cdp, repoB);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository B group rendered' });
  await addRepository(cdp, repoC);
  await cdp.waitFor(groupTriggerFinder(repoCName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository C group rendered' });
  log('STEP PASS: all three scratch repositories added, three Repository groups rendered.');

  // Every group must start OPEN (decision 16's default: absent from the saved set = open).
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Repository A group must start open');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B group must start open');
  assert((await groupState(cdp, groupTriggerFinder(repoCName))) === 'open', 'Repository C group must start open');

  // Repository C owns zero Sessions throughout and is collapsed now -- decision 29's prune
  // check (main()) removes it later while it is in this state.
  await cdp.click(groupTriggerFinder(repoCName));
  await cdp.waitFor(`${groupTriggerFinder(repoCName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository C collapsed' });

  // ---- Create a Session in each repository via the header "+" quick-create ----
  await createSessionViaQuickCreate(cdp, repoAName);
  await cdp.screenshot(path.join(evidenceDir, '01-session-a1-created.png'));
  log('STEP PASS: Session A1 created via the header + quick-create button.');

  // ---- Trigger an approval (needs-you) on Session A1, leave it PENDING ----
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'Approval card rendered (Session A1 now needs-you)' }
  );
  await cdp.screenshot(path.join(evidenceDir, '02-session-a1-needs-you-pending-approval.png'));
  log('STEP PASS: Session A1 has a pending approval (status needs-you).');

  // ---- Session B1 (an ordinary active Session that stays in Repository B throughout), then
  // Session B2 (becomes the focused/visible pane -- `create()` calls `replaceFocused`). Both
  // waits now assert the row count itself increased, not only that a composer is enabled
  // (gate round 2 fix: a dropped second create used to pass silently here). ----
  await createSessionViaQuickCreate(cdp, repoBName);
  log('STEP PASS: Session B1 created via the header + quick-create button (row count proven).');
  await createSessionViaQuickCreate(cdp, repoBName);
  log('STEP PASS: Session B2 created via the header + quick-create button (row count proven, now the focused pane).');

  // ---- Archive Session B2 WHILE it is still the focused/visible pane -- the exact regression
  // shape gate round 1 found: archiving does not clear `paneSessionIds` (only a delete does,
  // FR-016), so B2's id stays in the Split store's pane list even once it is archived. ----
  await archiveFirstRowIn(cdp, repoBName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session B2' });
  log('STEP PASS: Session B2 archived while still the focused pane; Archived group now shown.');

  // Archived starts closed by default; archiving never opens it (decision 20's own scope).
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Archived group must stay closed after archiving (archiving never opens Archived)');

  // ---- Collapse Repository A (now holding the needs-you Session) and Repository B ----
  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository A group collapsed by its own header click' });
  await cdp.click(groupTriggerFinder(repoBName));
  await cdp.waitFor(`${groupTriggerFinder(repoBName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository B group collapsed by its own header click' });
  log('STEP PASS: Repository A and Repository B groups collapsed by clicking their own headers.');

  // ---- Waiting marker: Repository A's collapsed header names "Needs you" in its real AX name ----
  const repoAName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoAName));
  assert(repoAName_ax && /Needs you/.test(repoAName_ax), `Repository A's collapsed header accessible name must include "Needs you" (got: ${JSON.stringify(repoAName_ax)})`);
  log(`STEP PASS: Repository A collapsed header's real accessible name includes the Waiting marker: ${JSON.stringify(repoAName_ax)}`);

  // ---- Gate round 1 regression proof: Repository B's collapsed header must show NEITHER the
  // active-session bar NOR any waiting marker for the now-archived B2, even though B2 is still
  // the Split store's own focused pane -- only Archived's own header may carry that cue. ----
  const repoBName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoBName));
  assert(repoBName_ax && !/contains open session/.test(repoBName_ax), `Repository B's header must NOT claim "contains open session" for an archived former-focused Session (got: ${JSON.stringify(repoBName_ax)})`);
  assert(!(await hasActiveBar(cdp, repoBName)), 'Repository B\'s collapsed header must not render the active-indicator bar for an archived Session');
  const archivedName_ax = await getAccessibleName(cdp, ARCHIVED_TRIGGER_FINDER);
  assert(archivedName_ax && /contains open session/.test(archivedName_ax), `Archived's own header SHOULD claim "contains open session" (got: ${JSON.stringify(archivedName_ax)})`);
  assert(await archivedHasActiveBar(cdp), 'Archived\'s own collapsed header must render the active-indicator bar');
  log('STEP PASS: the archived-Session active bar and marker show on Archived\'s own header, never leaked back onto Repository B\'s former header.');
  await cdp.screenshot(path.join(evidenceDir, '03-dark-collapsed-with-marker.png'));

  // ---- Toolbar: keyboard reach, right after Pull requests ----
  // Focused programmatically (never clicked): a real click activates the button, which swaps
  // the centre region to the Pull Requests view, whose own repository combobox then steals
  // focus on mount.
  await cdp.evaluate(`document.querySelector('[aria-label="Pull requests"]').focus()`);
  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Collapse all groups', `Tab after Pull requests must land on Collapse all groups (got: ${JSON.stringify(active)})`);

  // ---- Gate round 2 fix (Medium, test/code-reviewer): the toolbar's focus outline must render
  // at decision 23's EXACT 2px solid value, not just a nonzero width. Button's base
  // `outline-width` starts at the CSS initial `medium` (3px) and `outline-2` animates it down
  // over `transition-all`'s ~150ms, so reading immediately after Tab catches the animation's
  // start value (round 1's "solid, 3px" claim) -- waiting for it to settle first fixes that. ----
  await new Promise((resolve) => setTimeout(resolve, 250));
  const focusOutline = await cdp.evaluate(
    `(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineOffset: cs.outlineOffset }; })()`
  );
  assert(
    focusOutline.outlineStyle === 'solid' && focusOutline.outlineWidth === '2px' && focusOutline.outlineOffset === '2px',
    `Collapse all groups must render decision 23's exact 2px solid outline, 2px offset, once the transition settles (got: ${JSON.stringify(focusOutline)})`
  );
  log(`STEP PASS: the toolbar's focus outline renders at decision 23's exact value under real keyboard focus (${JSON.stringify(focusOutline)}).`);

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Expand all groups', `Tab after Collapse all groups must land on Expand all groups (got: ${JSON.stringify(active)})`);
  log('STEP PASS: toolbar keyboard reach confirmed (Pull requests -> Collapse all groups -> Expand all groups), via real accessible names.');

  // ---- Toolbar: Expand all opens every group (A, B, Archived; C stays closed, untouched) ----
  await pressEscape(cdp);
  await cdp.evaluate(`document.activeElement?.blur()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cdp.clickByLabel('Expand all groups');
  // No DOM `.click()` fallback: a real click that missed its target must fail this check.
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all opened Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Expand all must open Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Expand all must open Archived (shown, since Session B2 is archived)');
  log('STEP PASS: Expand all opened every Repository group plus Archived.');

  // ---- Gate round 2 fix (Medium, test-reviewer): Expand all's own no-op state, and a REAL
  // second click that changes nothing -- round 1 only ever read the `aria-disabled` attribute. ----
  const expandAllDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Expand all groups"]').getAttribute('aria-disabled')`);
  assert(expandAllDisabled === 'true', `Expand all must be aria-disabled once everything is already expanded (got: ${expandAllDisabled})`);
  await cdp.clickByLabel('Expand all groups');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'A real second click on the disabled Expand all must change nothing (Repository A)');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'A real second click on the disabled Expand all must change nothing (Repository B)');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'A real second click on the disabled Expand all must change nothing (Archived)');
  log('STEP PASS: a real second click on the already-disabled Expand all changed nothing (genuine no-op).');

  // ---- Toolbar: Collapse all closes every group, is a no-op the second time, AND a real
  // second click changes nothing ----
  await cdp.clickByLabel('Collapse all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Collapse all closed Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Collapse all must close Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Collapse all must close Archived');
  log('STEP PASS: Collapse all closed every Repository group plus Archived.');

  const activeBarCount = await cdp.evaluate(`document.querySelectorAll('[class*="bg-active-indicator"]').length`);
  assert(activeBarCount === 1, `Exactly one active-indicator bar must render (Archived's own) once everything is collapsed (got: ${activeBarCount})`);
  assert(await archivedHasActiveBar(cdp), 'The one active-indicator bar must be on Archived\'s own header');

  const collapseAllDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-disabled')`);
  assert(collapseAllDisabled === 'true', `Collapse all must be aria-disabled once already collapsed (got: ${collapseAllDisabled})`);
  const reasonId = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-describedby')`);
  const reasonText = reasonId ? await cdp.evaluate(`document.getElementById(${JSON.stringify(reasonId)})?.textContent`) : null;
  assert(reasonText === 'All groups are collapsed', `no-op reason text must read "All groups are collapsed" (got: ${JSON.stringify(reasonText)})`);
  log('STEP PASS: Collapse all is aria-disabled with the correct no-op reason once already all-collapsed (never native disabled).');

  await cdp.clickByLabel('Collapse all groups');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'A real second click on the disabled Collapse all must change nothing (Repository A)');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'A real second click on the disabled Collapse all must change nothing (Repository B)');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'A real second click on the disabled Collapse all must change nothing (Archived)');
  log('STEP PASS: a real second click on the already-disabled Collapse all changed nothing (genuine no-op).');

  // ---- High-contrast screenshot of the same collapsed+marker state ----
  const themeResult = await cdp.evaluate(`window.refract.theme.set('dark-high-contrast').then((r) => r.ok)`);
  assert(themeResult === true, 'theme.set(dark-high-contrast) must succeed');
  await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'High-contrast theme class applied' });
  await cdp.screenshot(path.join(evidenceDir, '04-high-contrast-collapsed-with-marker.png'));
  log('STEP PASS: High-contrast screenshot captured with the collapsed group and its Waiting marker.');
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('high-contrast')`, { timeoutMs: 10_000, label: 'Back to Dark theme' });

  // ---- Open-on-create: Repository A is closed; the header + quick-create reopens it. The new
  // Session created here (A2) is the one kept archived through the restart proof below. ----
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed before the open-on-create proof');
  await createSessionViaQuickCreate(cdp, repoAName);
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository A reopened by a successful create' });
  log('STEP PASS: a successful create via the header + button reopened Repository A\'s closed group (open-on-create), creating Session A2.');

  // ---- Open-on-restore: Archived is closed; restoring Session B2 reopens Repository B ----
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Repository B must still be closed before the open-on-restore proof');
  await restoreOnlyArchivedRow(cdp);
  await cdp.waitFor(`${groupTriggerFinder(repoBName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository B reopened by a successful restore' });
  log('STEP PASS: a successful restore from Archived reopened Repository B\'s closed group (open-on-restore).');

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  let shimDir, dataDir, importSourceDir, repoADir, repoBDir, repoCDir, exeDir;
  const evidenceDir = SHOT_DIR;
  let child;
  let cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-735-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-735-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-735-import-src-'));
    repoADir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-735-repoA-')), 'A');
    repoBDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-735-repoB-')), 'B');
    repoCDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-735-repoC-')), 'C');
    const repoAName = path.basename(repoADir);
    const repoBName = path.basename(repoBDir);
    const repoCName = path.basename(repoCDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-735-exe-'));

    log(`verify-tauri-735: data dir ${dataDir}`);
    log(`verify-tauri-735: evidence/screenshot dir ${evidenceDir}`);
    log(`verify-tauri-735: repo A ${repoADir} (name "${repoAName}")`);
    log(`verify-tauri-735: repo B ${repoBDir} (name "${repoBName}")`);
    log(`verify-tauri-735: repo C ${repoCDir} (name "${repoCName}", empty, for the decision-29 prune check)`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    log('verify-tauri-735: building (tauri build --debug --no-bundle)...');
    buildTauriDebugNoBundle();
    const { dest: exePath, hash: exeHash } = copyBuiltExe(exeDir);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(evidenceDir, 'app-run1.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(evidenceDir, 'fake-omp-invocations-run1.log')
      }
    });
    child = launched.child;
    const targetPid1 = launched.targetPid;
    cdp = await connectCdp(port, targetPid1);
    // Gate round 2 fix (High in effect, test-reviewer Medium): actually assert the exe's own
    // sha256 against the launched process's own exe path -- round 1 only ever logged the hash.
    assertExeMatchesProcess(targetPid1, exePath, exeHash);
    log(`verify-tauri-735: run 1 launched, pid ${targetPid1}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await runChecks(cdp, evidenceDir, log, { repoA: repoADir, repoB: repoBDir, repoC: repoCDir, repoAName, repoBName, repoCName });

    // ---- Build the mixed collapse state and run decision 29's two remaining checks (the
    // Settings round trip and the prune) -- extracted to the shared helpers module to keep this
    // file under the #806 line cap; see its own doc comment for the full sequence. ----
    const { repoARecord } = await buildMixedStateAndCheckDecision29(cdp, log, {
      repoAName,
      repoBName,
      repoCName,
      repoADir,
      repoCDir,
      dataDir
    });

    // ---- Read the FINAL on-disk settings.json before quitting (decision 17's debounced write) ----
    await new Promise((resolve) => setTimeout(resolve, 700));
    const settingsBeforeQuit = readJsonFile(path.join(dataDir, 'settings.json'));
    const collapseBeforeQuit = settingsBeforeQuit.sessionListCollapse;
    assert(
      Array.isArray(collapseBeforeQuit.collapsedRepositoryIds) && collapseBeforeQuit.collapsedRepositoryIds.length === 1 && collapseBeforeQuit.collapsedRepositoryIds[0] === repoARecord.id,
      `settings.json's collapsedRepositoryIds must be exactly [Repository A's id] (got: ${JSON.stringify(collapseBeforeQuit.collapsedRepositoryIds)})`
    );
    assert(collapseBeforeQuit.archivedOpen === true, `settings.json's archivedOpen must be true (got: ${JSON.stringify(collapseBeforeQuit.archivedOpen)})`);
    writeFileSync(path.join(evidenceDir, 'settings-before-quit.json'), JSON.stringify(settingsBeforeQuit, null, 2));
    log(`STEP PASS: settings.json on disk, BEFORE quitting, shows the final mixed state: ${JSON.stringify(collapseBeforeQuit)} (dumped to settings-before-quit.json).`);
    await cdp.screenshot(path.join(evidenceDir, '05-mixed-state-before-restart.png'));

    // `stopLauncher` below force-kills the Job Object, which never fires
    // `beforeunload`/`pagehide` -- unlike a real user closing the window, so the renderer's own
    // flush-on-quit handler never runs here. This wait is a second, independent safety margin on
    // top of the on-disk read just above, which already proves the debounced write landed.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    cdp.close();
    cdp = null;
    await stopLauncher(child);
    child = null;
    log('verify-tauri-735: run 1 stopped (a forceful Job-Object kill, not a real beforeunload/pagehide quit). Relaunching the SAME exe on the SAME data dir...');

    // ---- Relaunch on the SAME dataDir (no wipe) to prove the collapse state survives a restart ----
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exePath, {
      port: port2,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(evidenceDir, 'app-run2.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(evidenceDir, 'fake-omp-invocations-run2.log')
      }
    });
    child = launched2.child;
    const targetPid2 = launched2.targetPid;
    cdp = await connectCdp(port2, targetPid2);
    assertExeMatchesProcess(targetPid2, exePath, exeHash);
    log(`verify-tauri-735: run 2 (relaunch) launched, pid ${targetPid2}, exe re-asserted against the same scratch copy`);

    await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 60_000, label: 'Repository A group re-rendered after restart' });
    await cdp.screenshot(path.join(evidenceDir, '06-after-restart.png'));

    const afterRestart = {
      repoA: await groupState(cdp, groupTriggerFinder(repoAName)),
      repoB: await groupState(cdp, groupTriggerFinder(repoBName)),
      archived: await groupState(cdp, ARCHIVED_TRIGGER_FINDER)
    };
    const archivedRowCountAfterRestart = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] ul[aria-label="Archived sessions"] li').length`);
    const repoCGoneAfterRestart = await cdp.evaluate(groupTriggerFinder(repoCName) + ' === undefined');
    const registryAfterRestart = readJsonFile(path.join(dataDir, 'registry.json'));
    writeFileSync(
      path.join(evidenceDir, 'state-after-restart.json'),
      JSON.stringify({ afterRestart, archivedRowCountAfterRestart, repoCGoneAfterRestart, repositoryCount: registryAfterRestart.repositories.length }, null, 2)
    );
    log(`verify-tauri-735: collapse state after restart: ${JSON.stringify(afterRestart)}, Archived row count: ${archivedRowCountAfterRestart}, Repository C still gone: ${repoCGoneAfterRestart}`);

    // A NON-default combination (Repository A closed is the opposite of every group's own
    // fresh-start default) that only a working persistence layer reproduces.
    assert(afterRestart.repoA === 'closed', `Repository A's CLOSED state must survive a restart (got: ${afterRestart.repoA})`);
    assert(afterRestart.repoB === 'open', `Repository B's open state must survive a restart (got: ${afterRestart.repoB})`);
    assert(afterRestart.archived === 'open', `Archived's OPEN state must survive a restart (got: ${afterRestart.archived})`);
    assert(archivedRowCountAfterRestart === 1, `Archived must still list exactly the one Session (A2) kept archived (got: ${archivedRowCountAfterRestart})`);
    assert(repoCGoneAfterRestart, 'Repository C must still be gone after the restart (the prune itself persisted, not only its collapse-state entry)');
    log('STEP PASS: the genuinely mixed collapse/expand state (A closed, B open, Archived open with its one Session, C pruned) survived a real app restart.');

    log(`verify-tauri-735: ALL PASS. Evidence and screenshots: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoADir) await safeRmSync(worktreesDirFor(repoADir));
    if (repoBDir) await safeRmSync(worktreesDirFor(repoBDir));
    if (repoCDir) await safeRmSync(worktreesDirFor(repoCDir));
    await safeRmSync(repoADir);
    await safeRmSync(repoBDir);
    await safeRmSync(repoCDir);
    await safeRmSync(exeDir);
    // Deliberately NOT removing `evidenceDir` (== SHOT_DIR): this run's STEP-PASS report, app
    // logs, settings.json dumps and screenshots are the gate's own audit trail and must survive.
  }
}

main().catch((err) => {
  console.error('verify-tauri-735: FAIL');
  console.error(err);
  process.exitCode = 1;
});
