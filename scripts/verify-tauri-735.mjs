#!/usr/bin/env node
// Live check of Session list collapse/expand (#735) against the scratch Tauri debug build, driven through real DOM
// (only `window.refract.theme.set` is used directly, to switch themes between screenshots).
// Isolation: scratch REFRACT_DATA_DIR/WEBVIEW2 folders and an empty REFRACT_IMPORT_SOURCE_DIR so the real %APPDATA%\pinion is never read.
// Every launch asserts the CDP target is owned by this run's pid and that its exe path/hash match the scratch copy.

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

const SHOT_DIR = process.env.REFRACT_735_SHOT_DIR || path.join(tmpdir(), 'refract-735-gate2-shots');

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
    const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR, CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: '4' };
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

// Reads what actually landed on disk, for the persistence proof only.
function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

async function runChecks(cdp, evidenceDir, log, { repoA, repoB, repoC, repoAName, repoBName, repoCName }) {
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

  // Repository C stays empty and collapsed: main() removes it later for the prune check.
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Repository A group must start open');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B group must start open');
  assert((await groupState(cdp, groupTriggerFinder(repoCName))) === 'open', 'Repository C group must start open');

  await cdp.click(groupTriggerFinder(repoCName));
  await cdp.waitFor(`${groupTriggerFinder(repoCName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository C collapsed' });

  await createSessionViaQuickCreate(cdp, repoAName);
  await cdp.screenshot(path.join(evidenceDir, '01-session-a1-created.png'));
  log('STEP PASS: Session A1 created via the header + quick-create button.');

  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'Approval card rendered (Session A1 now needs-you)' }
  );
  await cdp.screenshot(path.join(evidenceDir, '02-session-a1-needs-you-pending-approval.png'));
  log('STEP PASS: Session A1 has a pending approval (status needs-you).');

  // B2 becomes the focused pane (`create()` calls `replaceFocused`); assert the row count grew, since a dropped create passed silently.
  await createSessionViaQuickCreate(cdp, repoBName);
  log('STEP PASS: Session B1 created via the header + quick-create button (row count proven).');
  await createSessionViaQuickCreate(cdp, repoBName);
  log('STEP PASS: Session B2 created via the header + quick-create button (row count proven, now the focused pane).');

  // Archive B2 while focused: archiving does not clear `paneSessionIds` (only delete does), so its id stays in the pane list.
  await archiveFirstRowIn(cdp, repoBName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session B2' });
  log('STEP PASS: Session B2 archived while still the focused pane; Archived group now shown.');

  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Archived group must stay closed after archiving (archiving never opens Archived)');

  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository A group collapsed by its own header click' });
  await cdp.click(groupTriggerFinder(repoBName));
  await cdp.waitFor(`${groupTriggerFinder(repoBName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository B group collapsed by its own header click' });
  log('STEP PASS: Repository A and Repository B groups collapsed by clicking their own headers.');

  const repoAName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoAName));
  assert(repoAName_ax && /Needs you/.test(repoAName_ax), `Repository A's collapsed header accessible name must include "Needs you" (got: ${JSON.stringify(repoAName_ax)})`);
  log(`STEP PASS: Repository A collapsed header's real accessible name includes the Waiting marker: ${JSON.stringify(repoAName_ax)}`);

  // B's collapsed header must show neither the active bar nor a waiting marker for archived B2, though it is still the focused pane.
  const repoBName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoBName));
  assert(repoBName_ax && !/contains open session/.test(repoBName_ax), `Repository B's header must NOT claim "contains open session" for an archived former-focused Session (got: ${JSON.stringify(repoBName_ax)})`);
  assert(!(await hasActiveBar(cdp, repoBName)), 'Repository B\'s collapsed header must not render the active-indicator bar for an archived Session');
  const archivedName_ax = await getAccessibleName(cdp, ARCHIVED_TRIGGER_FINDER);
  assert(archivedName_ax && /contains open session/.test(archivedName_ax), `Archived's own header SHOULD claim "contains open session" (got: ${JSON.stringify(archivedName_ax)})`);
  assert(await archivedHasActiveBar(cdp), 'Archived\'s own collapsed header must render the active-indicator bar');
  log('STEP PASS: the archived-Session active bar and marker show on Archived\'s own header, never leaked back onto Repository B\'s former header.');
  await cdp.screenshot(path.join(evidenceDir, '03-dark-collapsed-with-marker.png'));

  // Focused programmatically, not clicked: a click opens Pull Requests, whose combobox steals focus on mount.
  await cdp.evaluate(`document.querySelector('[aria-label="Pull requests"]').focus()`);
  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Collapse all groups', `Tab after Pull requests must land on Collapse all groups (got: ${JSON.stringify(active)})`);

  // Wait for the outline to settle: `outline-2` animates down from the initial 3px over ~150ms, so an immediate read sees 3px.
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

  await pressEscape(cdp);
  await cdp.evaluate(`document.activeElement?.blur()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cdp.clickByLabel('Expand all groups');
  // No DOM `.click()` fallback: a real click that missed its target must fail this check.
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all opened Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Expand all must open Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Expand all must open Archived (shown, since Session B2 is archived)');
  log('STEP PASS: Expand all opened every Repository group plus Archived.');

  const expandAllDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Expand all groups"]').getAttribute('aria-disabled')`);
  assert(expandAllDisabled === 'true', `Expand all must be aria-disabled once everything is already expanded (got: ${expandAllDisabled})`);
  await cdp.clickByLabel('Expand all groups');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'A real second click on the disabled Expand all must change nothing (Repository A)');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'A real second click on the disabled Expand all must change nothing (Repository B)');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'A real second click on the disabled Expand all must change nothing (Archived)');
  log('STEP PASS: a real second click on the already-disabled Expand all changed nothing (genuine no-op).');

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

  const themeResult = await cdp.evaluate(`window.refract.theme.set('dark-high-contrast').then((r) => r.ok)`);
  assert(themeResult === true, 'theme.set(dark-high-contrast) must succeed');
  await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'High-contrast theme class applied' });
  await cdp.screenshot(path.join(evidenceDir, '04-high-contrast-collapsed-with-marker.png'));
  log('STEP PASS: High-contrast screenshot captured with the collapsed group and its Waiting marker.');
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('high-contrast')`, { timeoutMs: 10_000, label: 'Back to Dark theme' });

  // A2, created here, is the Session kept archived through the restart proof.
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed before the open-on-create proof');
  await createSessionViaQuickCreate(cdp, repoAName);
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository A reopened by a successful create' });
  log('STEP PASS: a successful create via the header + button reopened Repository A\'s closed group (open-on-create), creating Session A2.');

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
    assertExeMatchesProcess(targetPid1, exePath, exeHash);
    log(`verify-tauri-735: run 1 launched, pid ${targetPid1}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await runChecks(cdp, evidenceDir, log, { repoA: repoADir, repoB: repoBDir, repoC: repoCDir, repoAName, repoBName, repoCName });

    const { repoARecord } = await buildMixedStateAndCheckDecision29(cdp, log, {
      repoAName,
      repoBName,
      repoCName,
      repoADir,
      repoCDir,
      dataDir
    });

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

    // `stopLauncher` force-kills the Job Object, so the renderer's flush-on-quit handler never runs; this wait is a safety margin.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    cdp.close();
    cdp = null;
    await stopLauncher(child);
    child = null;
    log('verify-tauri-735: run 1 stopped (a forceful Job-Object kill, not a real beforeunload/pagehide quit). Relaunching the SAME exe on the SAME data dir...');

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

    // A non-default combination (A closed), which only working persistence reproduces.
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
    // Keep `evidenceDir` (== SHOT_DIR): it is the audit trail.
  }
}

main().catch((err) => {
  console.error('verify-tauri-735: FAIL');
  console.error(err);
  process.exitCode = 1;
});
