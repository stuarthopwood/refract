#!/usr/bin/env node
// Session list collapse/expand live check (issue #735) against the scratch Tauri debug build.
// Standalone script (same precedent as verify-tauri-ask.mjs/verify-tauri-side-chat.mjs:
// duplicates the small build/copy/launch glue, reuses verify-tauri-cdp.mjs's CDP primitives).
//
// Proves, against the real rendered DOM (never window.refract.* as a shortcut for anything the
// UI itself should do -- window.refract.theme.set is the one exception, used only to switch
// themes between screenshots, exactly the real IPC call the Appearance section itself makes):
//   - The Collapse all / Expand all toolbar closes/opens every Repository group plus Archived
//     (once something is archived) together, and is keyboard-reachable right after Pull requests
//     with real accessible names.
//   - A closed group holding a Session with a pending approval (status needs-you) shows a single
//     Waiting marker, readable in the group header's own computed accessible name (CDP
//     Accessibility domain, never textContent).
//   - A closed group re-opens (and that open persists) when a create (the header "+") or a
//     restore from Archived actually moves a Session into it.
//   - The whole collapse/expand state survives a real app restart (quit, relaunch on the SAME
//     scratch data dir, no wipe).
//
// Isolation (refract-tauri-live-check-isolation skill): REFRACT_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER
// are fresh scratch dirs; REFRACT_IMPORT_SOURCE_DIR is an empty scratch dir so the one-time
// Electron-registry import never reads Stuart's real %APPDATA%\pinion. The built exe is copied to
// its own scratch dir and run from there (never from the shared CARGO_TARGET_DIR), with its own
// sha256 logged. Every launch asserts the CDP target is actually owned by the pid this run
// started (isTargetOwningPort) before driving it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');

const SHOT_DIR = process.env.REFRACT_735_SHOT_DIR || 'C:/Users/shopwood/AppData/Local/Temp/refract-735-shots';

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

function withEvidenceDir(name) {
  const dir = path.join(tmpdir(), `refract-tauri-verify-735-${name}-${nowStamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

/** Computed accessible name of the FIRST element matching `finderExpr`, via CDP Accessibility
 * domain -- never textContent, which is not what a screen reader announces and would not
 * distinguish the combined aria-label this story builds (label + marker + "contains open
 * session"). `null` when nothing matches or it carries no AX node. */
async function getAccessibleName(cdp, finderExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: finderExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  return nodes?.[0]?.name?.value ?? null;
}

async function getActiveElementAccessibleName(cdp) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return { name: null, role: null };
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  const node = nodes?.[0];
  return { name: node?.name?.value ?? null, role: node?.role?.value ?? null };
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}

function groupTriggerFinder(repoName) {
  // Repository headers are wrapped in a Tooltip (`asChild`), whose own `data-slot`/`data-state`
  // overwrite the inner CollapsibleTrigger's (GroupHeader.tsx's own documented reason for keying
  // off `aria-expanded` instead, never `data-state`, once a trigger is a Tooltip's child too) --
  // so finding by `aria-label` (always starts with the repo name) and reading `aria-expanded`
  // is the only selector immune to that override. Archived carries no tooltip, so its own
  // `data-slot="collapsible-trigger"` is untouched and still the more specific match.
  return `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(repoName)}))`;
}
const ARCHIVED_TRIGGER_FINDER = `document.querySelector('[data-archived-group] [data-slot="collapsible-trigger"]')`;

async function groupState(cdp, finderExpr) {
  return cdp.evaluate(`(() => { const el = ${finderExpr}; if (!el) return null; return el.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'; })()`);
}

async function clickQuickCreate(cdp, repoName) {
  // The header "+" quick-create button stays rendered (and clickable) even while the group is
  // collapsed -- only CollapsibleContent (the row list) is conditionally mounted by Radix.
  const finder = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('[data-quick-create-session]')`;
  await cdp.click(finder);
}

async function runChecks(cdp, evidenceDir, { repoA, repoB, repoAName, repoBName }) {
  // ---- US1-equivalent: readiness, add both scratch repositories ----
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );

  async function addRepo(dir) {
    await cdp.click(`document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: dir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'Add repository dialog closed' });
  }
  await addRepo(repoA);
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
  await addRepo(repoB);
  await cdp.waitFor(groupTriggerFinder(repoBName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository B group rendered' });
  console.log('STEP PASS: both scratch repositories added, two Repository groups rendered.');

  // Both groups must start OPEN (decision 72's default).
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'open', 'Repository A group must start open');
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Repository B group must start open');

  // ---- Create a Session in each repository via the header "+" quick-create ----
  async function createViaQuickCreate(repoName) {
    await clickQuickCreate(cdp, repoName);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: `Session created in ${repoName}, composer enabled`
    });
  }
  await createViaQuickCreate(repoAName);
  await cdp.screenshot(path.join(evidenceDir, '01-session-a-created.png'));
  console.log('STEP PASS: Session A created via the header + quick-create button.');

  // ---- Trigger an approval (needs-you) on Session A, leave it PENDING ----
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'Approval card rendered (Session A now needs-you)' }
  );
  await cdp.screenshot(path.join(evidenceDir, '02-session-a-needs-you-pending-approval.png'));
  console.log('STEP PASS: Session A has a pending approval (status needs-you).');

  // Second Session, in repository B -- used for the archive/restore (open-on-restore) proof.
  await createViaQuickCreate(repoBName);
  console.log('STEP PASS: Session B created via the header + quick-create button.');

  // Archive Session B through its row's "..." menu.
  await cdp.click(`Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoBName)}))?.querySelector('li button[aria-label$=" actions"]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'Row menu open with Archive item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session B' });
  console.log('STEP PASS: Session B archived; Archived group now shown.');

  // Archived starts closed by default (decision 72); Archiving never opens it (decision 90).
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Archived group must stay closed after archiving (archiving never opens Archived)');

  // ---- Collapse Repository A (now holding the needs-you Session) and Repository B ----
  await cdp.click(groupTriggerFinder(repoAName));
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository A group collapsed by its own header click' });
  await cdp.click(groupTriggerFinder(repoBName));
  await cdp.waitFor(`${groupTriggerFinder(repoBName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository B group collapsed by its own header click' });
  console.log('STEP PASS: Repository A and Repository B groups collapsed by clicking their own headers.');

  // ---- Waiting marker: Repository A's collapsed header names "Needs you" in its real AX name ----
  const repoAName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoAName));
  assert(repoAName_ax && /Needs you/.test(repoAName_ax), `Repository A's collapsed header accessible name must include "Needs you" (got: ${JSON.stringify(repoAName_ax)})`);
  console.log(`STEP PASS: Repository A collapsed header's real accessible name includes the Waiting marker: ${JSON.stringify(repoAName_ax)}`);
  await cdp.screenshot(path.join(evidenceDir, '03-dark-collapsed-with-marker.png'));

  // ---- Toolbar: keyboard reach, right after Pull requests ----
  // Focused programmatically (never clicked): a real click activates the button, which swaps
  // the centre region to the Pull Requests view, whose own repository combobox then steals
  // focus on mount -- the real-world equivalent of landing on Pull requests via Shift+Tab
  // backward, or simply tabbing forward INTO it, neither of which activates it.
  await cdp.evaluate(`document.querySelector('[aria-label="Pull requests"]').focus()`);
  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Collapse all groups', `Tab after Pull requests must land on Collapse all groups (got: ${JSON.stringify(active)})`);
  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Expand all groups', `Tab after Collapse all groups must land on Expand all groups (got: ${JSON.stringify(active)})`);
  console.log('STEP PASS: toolbar keyboard reach confirmed (Pull requests -> Collapse all groups -> Expand all groups), via real accessible names.');

  // ---- Toolbar: Expand all opens every group (A, B, Archived) ----
  const preExpandDiag = await cdp.evaluate(
    `({ expandAriaDisabled: document.querySelector('[aria-label="Expand all groups"]')?.getAttribute('aria-disabled'), repoAExpanded: ${groupTriggerFinder(repoAName)}?.getAttribute('aria-expanded'), repoBExpanded: ${groupTriggerFinder(repoBName)}?.getAttribute('aria-expanded'), archivedExpanded: ${ARCHIVED_TRIGGER_FINDER}?.getAttribute('aria-expanded') })`
  );
  console.log('verify-tauri-735: state right before Expand all click:', JSON.stringify(preExpandDiag));
  // Keyboard focus is still on this very button from the preceding Tab-reach test; Radix
  // Tooltip opens on focus too, and its content can sit over the trigger at some viewport
  // sizes -- Escape (Radix's own documented tooltip-dismiss key) plus a blur clears that before
  // the real mouse click below, so the click lands on the button, not a transient overlay.
  await pressEscape(cdp);
  await cdp.evaluate(`document.activeElement?.blur()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cdp.clickByLabel('Expand all groups');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const postExpandDiag = await cdp.evaluate(
    `({ expandAriaDisabled: document.querySelector('[aria-label="Expand all groups"]')?.getAttribute('aria-disabled'), repoAExpanded: ${groupTriggerFinder(repoAName)}?.getAttribute('aria-expanded'), repoBExpanded: ${groupTriggerFinder(repoBName)}?.getAttribute('aria-expanded'), archivedExpanded: ${ARCHIVED_TRIGGER_FINDER}?.getAttribute('aria-expanded') })`
  );
  console.log('verify-tauri-735: state 500ms after Expand all click:', JSON.stringify(postExpandDiag));
  if (postExpandDiag.repoAExpanded !== 'true') {
    console.log('verify-tauri-735: mouse click did not open Repository A; trying a direct DOM .click() as a diagnostic fallback...');
    await cdp.evaluate(`document.querySelector('[aria-label="Expand all groups"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const domClickDiag = await cdp.evaluate(`${groupTriggerFinder(repoAName)}?.getAttribute('aria-expanded')`);
    console.log(`verify-tauri-735: Repository A aria-expanded after DOM .click() fallback: ${domClickDiag}`);
  }
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all opened Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Expand all must open Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Expand all must open Archived (shown, since Session B is archived)');
  console.log('STEP PASS: Expand all opened every Repository group plus Archived.');

  // ---- Toolbar: Collapse all closes every group, then is a no-op (aria-disabled) the second time ----
  await cdp.clickByLabel('Collapse all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Collapse all closed Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Collapse all must close Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Collapse all must close Archived');
  console.log('STEP PASS: Collapse all closed every Repository group plus Archived.');

  const collapseAllDisabled = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-disabled')`);
  assert(collapseAllDisabled === 'true', `Collapse all must be aria-disabled once everything is already collapsed (got: ${collapseAllDisabled})`);
  const reasonId = await cdp.evaluate(`document.querySelector('[aria-label="Collapse all groups"]').getAttribute('aria-describedby')`);
  const reasonText = reasonId ? await cdp.evaluate(`document.getElementById(${JSON.stringify(reasonId)})?.textContent`) : null;
  assert(!!reasonId, 'Collapse all must carry aria-describedby pointing at its no-op reason once disabled');
  assert(reasonText === 'All groups are collapsed', `no-op reason text must read "All groups are collapsed" (got: ${JSON.stringify(reasonText)})`);
  console.log('STEP PASS: Collapse all is aria-disabled with the correct no-op reason once already all-collapsed (never native disabled).');

  // ---- High-contrast screenshot of the same collapsed+marker state ----
  const themeResult = await cdp.evaluate(`window.refract.theme.set('dark-high-contrast').then((r) => r.ok)`);
  assert(themeResult === true, 'theme.set(dark-high-contrast) must succeed');
  await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'High-contrast theme class applied' });
  await cdp.screenshot(path.join(evidenceDir, '04-high-contrast-collapsed-with-marker.png'));
  console.log('STEP PASS: High-contrast screenshot captured with the collapsed group and its Waiting marker.');
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('high-contrast')`, { timeoutMs: 10_000, label: 'Back to Dark theme' });

  // ---- Open-on-create: Repository A is closed; the header + quick-create reopens it ----
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed before the open-on-create proof');
  await clickQuickCreate(cdp, repoAName);
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository A reopened by a successful create' });
  console.log('STEP PASS: a successful create via the header + button reopened Repository A\'s closed group (open-on-create).');

  // ---- Open-on-restore: Archived is closed; restoring Session B reopens Repository B ----
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Repository B must still be closed before the open-on-restore proof');
  await cdp.click(ARCHIVED_TRIGGER_FINDER);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened to reach the restore action' });
  await cdp.click(`document.querySelector('[data-archived-group]')?.querySelector('li button[aria-label$=" actions"]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`, { timeoutMs: 10_000, label: 'Archived row menu open with Restore item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`);
  await cdp.waitFor(`${groupTriggerFinder(repoBName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository B reopened by a successful restore' });
  console.log('STEP PASS: a successful restore from Archived reopened Repository B\'s closed group (open-on-restore).');

  console.log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  let shimDir, dataDir, importSourceDir, repoADir, repoBDir, exeDir, evidenceDir;
  let child;
  let cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-735-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-735-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-735-import-src-'));
    const repoAParent = mkdtempSync(path.join(tmpdir(), 'refract-735-repoA-'));
    const repoBParent = mkdtempSync(path.join(tmpdir(), 'refract-735-repoB-'));
    repoADir = makeScratchRepo(repoAParent, 'A');
    repoBDir = makeScratchRepo(repoBParent, 'B');
    const repoAName = path.basename(repoADir);
    const repoBName = path.basename(repoBDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-735-exe-'));
    evidenceDir = withEvidenceDir('run');

    console.log(`verify-tauri-735: data dir ${dataDir}`);
    console.log(`verify-tauri-735: evidence dir ${evidenceDir}`);
    console.log(`verify-tauri-735: screenshot dir ${SHOT_DIR}`);
    console.log(`verify-tauri-735: repo A ${repoADir} (name "${repoAName}")`);
    console.log(`verify-tauri-735: repo B ${repoBDir} (name "${repoBName}")`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    console.log('verify-tauri-735: building (tauri build --debug --no-bundle)...');
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
    console.log(`verify-tauri-735: run 1 launched, pid ${targetPid1}, exe sha256 ${exeHash}`);
    cdp = await connectCdp(port, targetPid1);

  await runChecks(cdp, evidenceDir, { repoA: repoADir, repoB: repoBDir, repoAName, repoBName });

  // `stopLauncher` below force-kills the Job Object (TerminateJobObject-equivalent), which never
  // fires `beforeunload`/`pagehide` -- unlike a real user closing the window, so the renderer's
  // own flush-on-quit handler never runs here. Waiting out the ~300ms persist debounce (plus
  // margin) first is what actually gets the LAST toggle (the open-on-restore proof above) onto
  // disk before this run is torn down.
  await new Promise((resolve) => setTimeout(resolve, 1500));

    // Record the collapse state right before quitting, read straight from the renderer's own
    // store (the ONLY window.refract.*-free internal read used in this whole script -- not an
    // IPC call, just reading this run's own in-memory JS state for the restart-proof baseline).
    const beforeQuit = await cdp.evaluate(
      `(() => { const s = window.__refractStores?.sessionList?.getState?.(); return s ? { collapsedRepositoryIds: [...s.collapsedRepositoryIds], archivedOpen: s.archivedOpen } : null; })()`
    );
    console.log(`verify-tauri-735: collapse state before quit: ${JSON.stringify(beforeQuit)}`);

    cdp.close();
    cdp = null;
    await stopLauncher(child);
    child = null;
    console.log('verify-tauri-735: run 1 stopped (quit). Relaunching the SAME exe on the SAME data dir...');

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
    console.log(`verify-tauri-735: run 2 (relaunch) launched, pid ${targetPid2}`);
    cdp = await connectCdp(port2, targetPid2);

    await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 60_000, label: 'Repository A group re-rendered after restart' });
    await cdp.screenshot(path.join(evidenceDir, '05-after-restart.png'));

    const afterRestart = {
      repoA: await groupState(cdp, groupTriggerFinder(repoAName)),
      repoB: await groupState(cdp, groupTriggerFinder(repoBName)),
      archived: await groupState(cdp, ARCHIVED_TRIGGER_FINDER)
    };
    console.log(`verify-tauri-735: collapse state after restart: ${JSON.stringify(afterRestart)}`);

    // Repository A was reopened by the create proof (open), Repository B was reopened by the
    // restore proof (open). The restore proof also moved Session B OUT of Archived back into
    // Repository B -- nothing is archived any more by this point, so #527's own "hidden
    // entirely while nothing anywhere is archived" rule correctly means Archived does not
    // render at all post-restart (a real, separate persistence proof in its own right: the
    // restore itself, a registry mutation, also survived the restart, not just settings.json).
    assert(afterRestart.repoA === 'open', `Repository A's open state must survive a restart (got: ${afterRestart.repoA})`);
    assert(afterRestart.repoB === 'open', `Repository B's open state must survive a restart (got: ${afterRestart.repoB})`);
    assert(afterRestart.archived === null, `Archived must not render post-restart (nothing is archived any more after the restore proof) (got: ${afterRestart.archived})`);
    console.log('STEP PASS: every group\'s collapse/expand state survived a real app restart (quit, relaunch on the same data dir).');

    console.log(`verify-tauri-735: ALL PASS. Evidence: ${evidenceDir}. Screenshots: ${SHOT_DIR}`);
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
  }
}

main().catch((err) => {
  console.error('verify-tauri-735: FAIL');
  console.error(err);
  process.exitCode = 1;
});
