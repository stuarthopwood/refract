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
//     with real accessible names, and its focus outline actually renders (computed style, not a
//     bare truthy check -- gate round 1 regression proof for the COMPOSER_BUTTON_FOCUS_CLASS fix).
//   - A closed group holding a Session with a pending approval (status needs-you) shows a single
//     Waiting marker, readable in the group header's own computed accessible name (CDP
//     Accessibility domain, never textContent).
//   - An archived Session, still the focused/visible pane at the moment it is archived, does NOT
//     leak its "contains open session" bar or Waiting marker onto its OLD Repository's header
//     once that header is collapsed -- only Archived's own header may carry that cue for it
//     (gate round 1 regression proof for the `active`-filter fix in RepositoryGroup.tsx).
//   - A closed group re-opens (and that open persists) when a create (the header "+") or a
//     restore from Archived actually moves a Session into it.
//   - A genuinely MIXED collapse state (one Repository closed, one open, Archived open with a
//     Session still actually archived in it -- never the all-default "freshly started" shape)
//     survives a real app restart (quit, relaunch on the SAME scratch data dir, no wipe),
//     verified both by reading `sessionListCollapse` straight out of `settings.json` on disk
//     before the quit, and by the rendered DOM after the relaunch (gate round 1 fix: the first
//     driver's restart proof asserted a state identical to a fresh start's own defaults, so a
//     build that persisted nothing would have passed it too).
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

/** Reads and parses a JSON file straight off the scratch data dir -- used ONLY for the
 * persistence proof (reading what actually landed on disk), never as a shortcut for anything
 * the UI itself should be driven to do. */
function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
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

/** Whether the Repository group's (or Archived's) own 2px `bg-active-indicator` header bar is
 * present in the DOM right now -- the gate round 1 regression target: an archived Session must
 * never leave this bar on its OLD Repository's header. */
async function hasActiveBar(cdp, repoName) {
  return cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); return !!group?.querySelector('[class*="bg-active-indicator"]'); })()`
  );
}
async function archivedHasActiveBar(cdp) {
  return cdp.evaluate(`!!document.querySelector('[data-archived-group] [class*="bg-active-indicator"]')`);
}

async function clickQuickCreate(cdp, repoName) {
  // The header "+" quick-create button stays rendered (and clickable) even while the group is
  // collapsed -- only CollapsibleContent (the row list) is conditionally mounted by Radix.
  const finder = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('[data-quick-create-session]')`;
  await cdp.click(finder);
}

/** Archives the FIRST (most-recently-active, so the just-created one) Session row inside the
 * named Repository group's own `<li>` list, via its row menu. */
async function archiveFirstRowIn(cdp, repoName) {
  await cdp.click(
    `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button[aria-label$=" actions"]')`
  );
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'Row menu open with Archive item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
}

/** Restores the ONLY Session row currently inside Archived, via its row menu. Opens Archived
 * first if it is closed. */
async function restoreOnlyArchivedRow(cdp) {
  if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') {
    await cdp.click(ARCHIVED_TRIGGER_FINDER);
    await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened to reach the restore action' });
  }
  await cdp.click(`document.querySelector('[data-archived-group]')?.querySelector('li button[aria-label$=" actions"]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`, { timeoutMs: 10_000, label: 'Archived row menu open with Restore item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Restore')`);
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

  // Both groups must start OPEN (decision 16's default: absent from the saved set = open).
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
  await cdp.screenshot(path.join(evidenceDir, '01-session-a1-created.png'));
  console.log('STEP PASS: Session A1 created via the header + quick-create button.');

  // ---- Trigger an approval (needs-you) on Session A1, leave it PENDING ----
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'Approval card rendered (Session A1 now needs-you)' }
  );
  await cdp.screenshot(path.join(evidenceDir, '02-session-a1-needs-you-pending-approval.png'));
  console.log('STEP PASS: Session A1 has a pending approval (status needs-you).');

  // ---- Session B1 (an ordinary active Session that stays in Repository B throughout), then
  // Session B2 (becomes the focused/visible pane -- `create()` calls `replaceFocused`) ----
  await createViaQuickCreate(repoBName);
  console.log('STEP PASS: Session B1 created via the header + quick-create button.');
  await createViaQuickCreate(repoBName);
  console.log('STEP PASS: Session B2 created via the header + quick-create button (now the focused pane).');

  // ---- Archive Session B2 WHILE it is still the focused/visible pane -- the exact regression
  // shape gate round 1 found: archiving does not clear `paneSessionIds` (only a delete does,
  // FR-016), so B2's id stays in the Split store's pane list even once it is archived. ----
  await archiveFirstRowIn(cdp, repoBName);
  await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group appears after archiving Session B2' });
  console.log('STEP PASS: Session B2 archived while still the focused pane; Archived group now shown.');

  // Archived starts closed by default; archiving never opens it (decision 20's own scope).
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

  // ---- Gate round 1 regression proof: Repository B's collapsed header must show NEITHER the
  // active-session bar NOR any waiting marker for the now-archived B2, even though B2 is still
  // the Split store's own focused pane -- only Archived's own header may carry that cue. ----
  const repoBName_ax = await getAccessibleName(cdp, groupTriggerFinder(repoBName));
  assert(repoBName_ax && !/contains open session/.test(repoBName_ax), `Repository B's header must NOT claim "contains open session" for an archived former-focused Session (got: ${JSON.stringify(repoBName_ax)})`);
  assert(!(await hasActiveBar(cdp, repoBName)), 'Repository B\'s collapsed header must not render the active-indicator bar for an archived Session (gate round 1 regression: RepositoryGroup.tsx must filter to active Sessions before computing it)');
  const archivedName_ax = await getAccessibleName(cdp, ARCHIVED_TRIGGER_FINDER);
  assert(archivedName_ax && /contains open session/.test(archivedName_ax), `Archived's own header SHOULD claim "contains open session" for the genuinely-archived, still-focused Session B2 (got: ${JSON.stringify(archivedName_ax)})`);
  assert(await archivedHasActiveBar(cdp), 'Archived\'s own collapsed header must render the active-indicator bar for its own archived, still-focused Session');
  console.log('STEP PASS: the archived-Session active bar and marker show on Archived\'s own header, never leaked back onto Repository B\'s former header.');
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

  // ---- Gate round 1 regression proof: the toolbar's own focus outline must actually render.
  // `COMPOSER_BUTTON_FOCUS_CLASS`'s fix (`outline-solid`) is what makes this non-zero; the
  // original literal class string left `outline-style: none` from Button's own base class in
  // place, so `outline-width`/`outline-offset` had nothing to draw. Computed style, not a bare
  // truthy check: `outline-style` must not be `none` and `outline-width` must be > 0px. ----
  const focusOutline = await cdp.evaluate(
    `(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth }; })()`
  );
  assert(
    focusOutline.outlineStyle !== 'none' && parseFloat(focusOutline.outlineWidth) > 0,
    `Collapse all groups must render a real focus outline under real keyboard focus (got: ${JSON.stringify(focusOutline)})`
  );
  console.log(`STEP PASS: the toolbar's focus outline actually renders under real keyboard focus (${JSON.stringify(focusOutline)}).`);

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Expand all groups', `Tab after Collapse all groups must land on Expand all groups (got: ${JSON.stringify(active)})`);
  console.log('STEP PASS: toolbar keyboard reach confirmed (Pull requests -> Collapse all groups -> Expand all groups), via real accessible names.');

  // ---- Toolbar: Expand all opens every group (A, B, Archived) ----
  // Keyboard focus is still on this very button from the preceding Tab-reach test; Radix
  // Tooltip opens on focus too, and its content can sit over the trigger at some viewport
  // sizes -- Escape (Radix's own documented tooltip-dismiss key) plus a blur clears that before
  // the real mouse click below, so the click lands on the button, not a transient overlay.
  await pressEscape(cdp);
  await cdp.evaluate(`document.activeElement?.blur()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cdp.clickByLabel('Expand all groups');
  // Gate round 1 fix (Medium, ui-workflow-forms-v3): no DOM `.click()` fallback here -- a real
  // click that missed its target must fail this check, not be silently rescued by a direct DOM
  // dispatch that could pass even when the genuine pointer path is broken.
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Expand all opened Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'open', 'Expand all must open Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Expand all must open Archived (shown, since Session B2 is archived)');
  console.log('STEP PASS: Expand all opened every Repository group plus Archived.');

  // ---- Toolbar: Collapse all closes every group, then is a no-op (aria-disabled) the second time ----
  await cdp.clickByLabel('Collapse all groups');
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Collapse all closed Repository A' });
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Collapse all must close Repository B');
  assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed', 'Collapse all must close Archived');
  console.log('STEP PASS: Collapse all closed every Repository group plus Archived.');

  // Exactly one active-indicator bar must exist anywhere in the list right now: on Archived's
  // own header, never duplicated onto Repository B's (gate round 1 regression proof, restated
  // after a full Collapse all rather than just the earlier manual-click state).
  const activeBarCount = await cdp.evaluate(`document.querySelectorAll('[class*="bg-active-indicator"]').length`);
  assert(activeBarCount === 1, `Exactly one active-indicator bar must render (Archived's own) once everything is collapsed (got: ${activeBarCount})`);
  assert(await archivedHasActiveBar(cdp), 'The one active-indicator bar must be on Archived\'s own header');

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

  // ---- Open-on-create: Repository A is closed; the header + quick-create reopens it. The new
  // Session created here (A2) is the one kept archived through the restart proof below. ----
  assert((await groupState(cdp, groupTriggerFinder(repoAName))) === 'closed', 'Repository A must still be closed before the open-on-create proof');
  await clickQuickCreate(cdp, repoAName);
  await cdp.waitFor(`${groupTriggerFinder(repoAName)}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 30_000, label: 'Repository A reopened by a successful create' });
  console.log('STEP PASS: a successful create via the header + button reopened Repository A\'s closed group (open-on-create), creating Session A2.');

  // ---- Open-on-restore: Archived is closed; restoring Session B2 reopens Repository B ----
  assert((await groupState(cdp, groupTriggerFinder(repoBName))) === 'closed', 'Repository B must still be closed before the open-on-restore proof');
  await restoreOnlyArchivedRow(cdp);
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

    const repoAName_ = repoAName;
    const repoBName_ = repoBName;
    await runChecks(cdp, evidenceDir, { repoA: repoADir, repoB: repoBDir, repoAName: repoAName_, repoBName: repoBName_ });

    // ---- Build a genuinely MIXED, non-default collapse state and prove it is written to disk
    // BEFORE quitting -- the gate round 1 fix for "a build that saves nothing would pass too":
    // Repository A (closed, non-default), Repository B (open, the default -- left alone),
    // Archived (open, non-default) holding the one Session (A2) archived here and kept archived
    // through the whole restart proof. ----
    await archiveFirstRowIn(cdp, repoAName_);
    await cdp.waitFor(`${groupTriggerFinder(repoAName_)} !== undefined`, { timeoutMs: 15_000, label: 'Repository A still rendered after archiving Session A2' });
    await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + ' !== null', { timeoutMs: 15_000, label: 'Archived group re-mounted after archiving Session A2' });
    // Archiving never opens Archived (decision 20's own scope) -- open it explicitly.
    if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') {
      await cdp.click(ARCHIVED_TRIGGER_FINDER);
      await cdp.waitFor(ARCHIVED_TRIGGER_FINDER + `.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened for the mixed-state proof' });
    }
    assert((await groupState(cdp, groupTriggerFinder(repoAName_))) === 'open', 'Repository A must still be open right after archiving Session A2 (archiving never collapses the group it is in)');
    await cdp.click(groupTriggerFinder(repoAName_));
    await cdp.waitFor(`${groupTriggerFinder(repoAName_)}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Repository A collapsed for the mixed-state proof' });
    assert((await groupState(cdp, groupTriggerFinder(repoBName_))) === 'open', 'Repository B must be open for the mixed-state proof (left at the default)');
    assert((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'open', 'Archived must be open for the mixed-state proof');
    const archivedRowCount = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] ul[aria-label="Archived sessions"] li').length`);
    assert(archivedRowCount === 1, `Archived must list exactly the one Session (A2) kept archived for the mixed-state proof (got: ${archivedRowCount})`);
    await cdp.screenshot(path.join(evidenceDir, '05-mixed-state-before-restart.png'));
    console.log('STEP PASS: built the mixed collapse state (Repository A closed, Repository B open, Archived open with one Session archived).');

    // Wait out the ~300ms persist debounce (plus margin), then read the ACTUAL on-disk
    // settings.json -- proves decision 17's debounced write landed, not just that the in-memory
    // store believes it did.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const registryBeforeQuit = readJsonFile(path.join(dataDir, 'registry.json'));
    const repoARecord = registryBeforeQuit.repositories.find((r) => r.path === repoADir || path.basename(r.path) === repoAName_);
    assert(repoARecord, `registry.json must contain Repository A (searched path ${repoADir})`);
    const settingsBeforeQuit = readJsonFile(path.join(dataDir, 'settings.json'));
    const collapseBeforeQuit = settingsBeforeQuit.sessionListCollapse;
    assert(collapseBeforeQuit, 'settings.json must contain a sessionListCollapse field before quitting');
    assert(
      Array.isArray(collapseBeforeQuit.collapsedRepositoryIds) && collapseBeforeQuit.collapsedRepositoryIds.length === 1 && collapseBeforeQuit.collapsedRepositoryIds[0] === repoARecord.id,
      `settings.json's sessionListCollapse.collapsedRepositoryIds must be exactly [Repository A's id] (got: ${JSON.stringify(collapseBeforeQuit.collapsedRepositoryIds)}, Repository A id: ${repoARecord.id})`
    );
    assert(collapseBeforeQuit.archivedOpen === true, `settings.json's sessionListCollapse.archivedOpen must be true (got: ${JSON.stringify(collapseBeforeQuit.archivedOpen)})`);
    console.log(`STEP PASS: settings.json on disk, BEFORE quitting, already shows the mixed state: ${JSON.stringify(collapseBeforeQuit)}.`);

    // `stopLauncher` below force-kills the Job Object (TerminateJobObject-equivalent), which
    // never fires `beforeunload`/`pagehide` -- unlike a real user closing the window, so the
    // renderer's own flush-on-quit handler never runs here. This extra wait is a second,
    // independent safety margin on top of the on-disk read just above (which already proves the
    // debounced write landed): it is what would let the LAST toggle reach disk even if it had
    // NOT already been proven above.
    await new Promise((resolve) => setTimeout(resolve, 1500));

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

    await cdp.waitFor(groupTriggerFinder(repoAName_) + ' !== undefined', { timeoutMs: 60_000, label: 'Repository A group re-rendered after restart' });
    await cdp.screenshot(path.join(evidenceDir, '06-after-restart.png'));

    const afterRestart = {
      repoA: await groupState(cdp, groupTriggerFinder(repoAName_)),
      repoB: await groupState(cdp, groupTriggerFinder(repoBName_)),
      archived: await groupState(cdp, ARCHIVED_TRIGGER_FINDER)
    };
    const archivedRowCountAfterRestart = await cdp.evaluate(`document.querySelectorAll('[data-archived-group] ul[aria-label="Archived sessions"] li').length`);
    console.log(`verify-tauri-735: collapse state after restart: ${JSON.stringify(afterRestart)}, Archived row count: ${archivedRowCountAfterRestart}`);

    // This is the gate round 1 fix: a NON-default combination (Repository A closed is the
    // opposite of every group's own fresh-start default) that only a working persistence layer
    // reproduces -- a build that saved nothing would show Repository A OPEN here instead, and
    // Archived would start closed (or render nothing, if the archive mutation itself had not
    // also survived). All three are asserted against the exact mixed state built above, not
    // against values that also happen to match a fresh start's own defaults.
    assert(afterRestart.repoA === 'closed', `Repository A's CLOSED state must survive a restart (got: ${afterRestart.repoA}) -- this is the non-default state only real persistence reproduces`);
    assert(afterRestart.repoB === 'open', `Repository B's open state must survive a restart (got: ${afterRestart.repoB})`);
    assert(afterRestart.archived === 'open', `Archived's OPEN state must survive a restart (got: ${afterRestart.archived}) -- this is the non-default state only real persistence reproduces`);
    assert(archivedRowCountAfterRestart === 1, `Archived must still list exactly the one Session (A2) kept archived, proving the archive mutation itself also survived the restart (got: ${archivedRowCountAfterRestart})`);
    console.log('STEP PASS: the genuinely mixed collapse/expand state (A closed, B open, Archived open with its one Session) survived a real app restart (quit, relaunch on the same data dir).');

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
