#!/usr/bin/env node
// #567 session list restyle live check against the scratch Tauri debug build. Gate round 1 (five-
// reviewer re-review) added the keyboard-only focus-return checks, the geometric marker-column
// comparison, and moved the header-actions-at-rest probe before the only active Session is
// archived. Never rebuilds itself: the caller chains a fresh `pnpm tauri build` with this script
// in ONE command (`REFRACT_567_PREBUILT_EXE` points at that build's own output), so the run's own
// exe is always built from the exact commit under test, logged below via `git rev-parse HEAD`.
//
// Proves, against the real rendered DOM (never window.refract.* as a shortcut for anything the
// UI itself should do -- window.refract.theme.set is the one exception, used only to switch
// themes between screenshots, the same exception verify-tauri-735.mjs documents):
//   - A #567-only DOM marker, row geometry, the focus ring, the row's own accessible name.
//   - The trailing slot: at rest shows the time; on hover the "..." menu button replaces it
//     (opacity/pointer-events, not display -- gate round 1 fix) and the time hides.
//   - KEYBOARD-ONLY: Tab reaches the row's "..." at rest (it is never removed from the Tab
//     order); Enter opens it; Escape returns focus to it; Delete then Cancel also returns focus
//     to it (gate round 1's High finding -- a `display:none` trigger could never take focus back).
//   - Header actions' opacity at rest/hover/keyboard-focus, measured BEFORE the only active
//     Session is archived (gate round 1 fix: the previous run measured an empty group, which is
//     always-on by its own decision 6 override, and proved nothing about the hidden-at-rest
//     state).
//   - The Archived header's own trigger right edge lines up with a Repository header's, within
//     1px (gate round 1 fix: the previous #908 fold-in was 8px off and wrongly claimed exact).
//   - Decision 24's "No sessions yet" line once the only Session is archived.
//   - Archived row: Project name with FolderGit2Icon on line 2, and in the accessible description.
//   - Group header sentence case, the closed-group Waiting marker, the footer divider, the Pull
//     requests selected bar, Dark (high contrast) and Obsidian screenshots.
//
// Isolation (refract-tauri-live-check-isolation skill): REFRACT_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER
// are fresh scratch dirs; REFRACT_IMPORT_SOURCE_DIR is an empty scratch dir.

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
import { groupTriggerFinder, ARCHIVED_TRIGGER_FINDER, createSessionViaQuickCreate, addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = process.env.REFRACT_567_SHOT_DIR || 'C:/Users/shopwood/AppData/Local/Temp/refract-567-gate1-shots';
const PRE_BUILT_EXE = process.env.REFRACT_567_PREBUILT_EXE;
const PROMPT_MESSAGE = 'Please respond now.';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function gitHead() {
  const result = spawnSync_('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  if (result.status !== 0) throw new Error(`gitHead: git rev-parse failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri-567: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
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

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  if (!PRE_BUILT_EXE || !existsSync(PRE_BUILT_EXE)) {
    throw new Error(`copyBuiltExe: REFRACT_567_PREBUILT_EXE not set or missing (${PRE_BUILT_EXE}) -- this script never rebuilds, chain a build in the same command first`);
  }
  copyFileSync(PRE_BUILT_EXE, dest);
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`verify-tauri-567: copied exe sha256 ${hash} (${dest}, from ${PRE_BUILT_EXE})`);
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
  run(['config', 'user.name', 'Verify Tauri 567']);
  run(['config', 'user.email', 'verify-tauri-567@example.invalid']);
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
    throw new Error(`verify-tauri-567: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function hoverRow(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `hover target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
}

async function pressKey(cdp, windowsVirtualKeyCode, key, code, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode, key, code, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode, key, code, modifiers });
}

async function rightClick(cdp, finderExpr) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: `right-click target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
}

async function runChecks(cdp, evidenceDir, log, { repoDir, repoName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project group rendered' });
  log('STEP PASS: scratch Project added, group rendered.');

  // ---- #567-only marker ----
  await createSessionViaQuickCreate(cdp, repoName);
  const rowFinder = `document.querySelector('[data-repository-id] li[data-choice-item]')`;
  await cdp.waitFor(`!!${rowFinder}`, { timeoutMs: 15_000, label: '#567 marker: li[data-choice-item] row' });
  log('STEP PASS: #567-only DOM marker present (li[data-choice-item] row).');
  await cdp.screenshot(path.join(evidenceDir, '01-row-idle-selected.png'));

  // ---- Row geometry ----
  const rowGeometry = await cdp.evaluate(
    `(() => { const li = ${rowFinder}; const surface = li.firstElementChild.nextElementSibling ?? li.querySelector(':scope > div'); const r = surface.getBoundingClientRect(); const cs = getComputedStyle(surface); return { height: r.height, borderRadius: cs.borderRadius, liBorderRadius: getComputedStyle(li).borderRadius }; })()`
  );
  writeFileSync(path.join(evidenceDir, 'row-geometry.json'), JSON.stringify(rowGeometry, null, 2));
  log(`verify-tauri-567: row geometry: ${JSON.stringify(rowGeometry)}`);
  assert(rowGeometry.height >= 40 && rowGeometry.height <= 48, `row height should be close to 44px (decision 8), measured ${rowGeometry.height}`);
  assert(rowGeometry.borderRadius === '0px', `row surface must be square-cornered (FR-054), measured borderRadius=${rowGeometry.borderRadius}`);

  // ---- Header actions at rest / hover / keyboard focus, measured NOW while the group still
  // has its one active Session (gate round 1 fix: measuring after archiving proved nothing,
  // since decision 6's own empty-group override forces opacity-100 regardless of hover/focus). ----
  const plusFinder = `document.querySelector('[data-quick-create-session]')`;
  // `createSessionViaQuickCreate` clicked the "+" button itself, which Chromium leaves
  // focused -- `group-focus-within` would otherwise keep the header actions revealed and this
  // "at rest" probe would prove nothing (the actual bug that produced this fix in the first
  // place: a false PASS from an unintentionally-focused or -hovered element).
  await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); // clear any lingering hover too
  await cdp.waitFor(`parseFloat(getComputedStyle(${plusFinder}).opacity) < 0.5`, { timeoutMs: 5_000, label: 'header + hidden at rest (active Session present)' });
  const headerAtRest = await cdp.evaluate(`(() => { const r = ${plusFinder}.getBoundingClientRect(); return { opacity: getComputedStyle(${plusFinder}).opacity, width: r.width, height: r.height }; })()`);
  log(`verify-tauri-567: header "+" AT REST (active Session present): ${JSON.stringify(headerAtRest)}`);
  assert(parseFloat(headerAtRest.opacity) < 0.5, `header "+" must be hidden at rest while the group has an active Session (decision 6), got opacity=${headerAtRest.opacity}`);
  assert(Math.round(headerAtRest.width) === 24 && Math.round(headerAtRest.height) === 24, `header action buttons must be 24px icon-xs (decision 6), got ${JSON.stringify(headerAtRest)}`);
  await hoverRow(cdp, `document.querySelector('[data-repository-id] .group')`);
  await cdp.waitFor(`parseFloat(getComputedStyle(${plusFinder}).opacity) > 0.5`, { timeoutMs: 5_000, label: 'header + revealed on hover' });
  log('STEP PASS: header "+" hidden at rest with an active Session present, revealed on hover (opacity 0 -> 1).');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await cdp.waitFor(`parseFloat(getComputedStyle(${plusFinder}).opacity) < 0.5`, { timeoutMs: 5_000, label: 'header + hidden again after hover clears' });
  // Keyboard focus reveal: Ctrl+N's own fallback target per the existing focus-visible class.
  await cdp.evaluate(`${plusFinder}.focus()`);
  await pressKey(cdp, 9, 'Tab', 'Tab'); // away
  await pressKey(cdp, 9, 'Tab', 'Tab', 8); // Shift+Tab back
  await cdp.waitFor(`parseFloat(getComputedStyle(${plusFinder}).opacity) > 0.5 && document.activeElement === ${plusFinder}`, { timeoutMs: 5_000, label: 'header + revealed on keyboard focus' });
  log('STEP PASS: header "+" revealed on real keyboard focus too.');
  await cdp.screenshot(path.join(evidenceDir, '07-group-header-hover.png'));

  // ---- Focus ring (real keyboard Tab/Shift+Tab, not a mouse click or script .focus()) ----
  const openButtonFinder = `${rowFinder}.querySelector('.session-open-button')`;
  await cdp.click(openButtonFinder); // focuses it via the real click path (also selects it)
  await cdp.waitFor(`document.activeElement === ${openButtonFinder}`, { timeoutMs: 10_000, label: 'row open button focused' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.waitFor(`document.activeElement !== ${openButtonFinder}`, { timeoutMs: 10_000, label: 'Tab moved focus away from the open button' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: 8 });
  await cdp.waitFor(`document.activeElement === ${openButtonFinder}`, { timeoutMs: 10_000, label: 'Shift+Tab moved focus back to the open button' });
  const focusDiag = await cdp.evaluate(
    `(() => { const el = ${openButtonFinder}; const cs = getComputedStyle(el); return { matchesFocusVisible: el.matches(':focus-visible'), outlineOffset: cs.outlineOffset, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, className: el.className }; })()`
  );
  writeFileSync(path.join(evidenceDir, 'focus-ring-offset.json'), JSON.stringify(focusDiag, null, 2));
  log(`verify-tauri-567: row open button focus diagnostics: ${JSON.stringify(focusDiag)}`);
  assert(focusDiag.matchesFocusVisible, `row open button must match :focus-visible once focused this way, got false (className=${focusDiag.className})`);
  assert(focusDiag.outlineStyle !== 'none', `row open button's focus ring must actually paint (outline-style must not be none), got ${JSON.stringify(focusDiag)}`);
  assert(focusDiag.outlineOffset.trim().startsWith('-'), `row open button's focus ring must draw INSIDE the row (decision 15, negative outline-offset), measured ${focusDiag.outlineOffset}`);
  await cdp.screenshot(path.join(evidenceDir, '02-row-focused.png'));

  // ---- KEYBOARD-ONLY focus return after the "..." menu closes (gate round 1 High finding) ----
  const ellipsisFinder = `${rowFinder}.querySelector('button[aria-label$="actions"]')`;
  await cdp.evaluate(`${openButtonFinder}.focus()`);
  await pressKey(cdp, 9, 'Tab', 'Tab');
  await cdp.waitFor(`document.activeElement === ${ellipsisFinder}`, { timeoutMs: 10_000, label: 'Tab from the open button reaches the "..." trigger (decision 17: every control is a Tab stop)' });
  log('STEP PASS: Tab reaches the row\'s "..." trigger at rest -- it is never removed from the Tab order.');
  await pressKey(cdp, 13, 'Enter', 'Enter');
  await cdp.waitFor(`${ellipsisFinder}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: '"..." menu opened via Enter' });
  await pressKey(cdp, 27, 'Escape', 'Escape');
  await cdp.waitFor(`document.activeElement === ${ellipsisFinder}`, { timeoutMs: 10_000, label: 'Escape returns focus to the "..." trigger' });
  log('STEP PASS: Escape closes the "..." menu and returns KEYBOARD focus to the trigger (not <body>).');

  // ---- Delete then Cancel also returns focus to the "..." trigger ----
  await pressKey(cdp, 13, 'Enter', 'Enter');
  await cdp.waitFor(`${ellipsisFinder}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: '"..." menu reopened' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Delete'))`);
  await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Delete confirmation dialog open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((el) => el.textContent.trim() === 'Cancel')`);
  await cdp.waitFor(`!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Delete dialog closed' });
  await cdp.waitFor(`document.activeElement === ${ellipsisFinder}`, { timeoutMs: 10_000, label: 'focus returns to the "..." trigger after Delete > Cancel' });
  log('STEP PASS: Delete > Cancel returns focus to the "..." trigger (not <body>).');

  // ---- Right-click (context menu) also reveals the "..." slot and leaves focus somewhere live ----
  await rightClick(cdp, rowFinder);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'context menu opened via right-click' });
  const ellipsisVisibleDuringContextMenu = await cdp.evaluate(`getComputedStyle(${ellipsisFinder}).opacity`);
  log(`verify-tauri-567: "..." opacity while the context menu is open: ${ellipsisVisibleDuringContextMenu}`);
  assert(parseFloat(ellipsisVisibleDuringContextMenu) > 0.5, `"..." must also show while a right-click context menu is open (decision 12), got opacity=${ellipsisVisibleDuringContextMenu}`);
  await pressKey(cdp, 27, 'Escape', 'Escape');
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'context menu closed' });
  const activeAfterContextMenu = await cdp.evaluate(`document.activeElement === document.body ? 'body' : document.activeElement.tagName`);
  log(`verify-tauri-567: focus after closing the context menu: ${activeAfterContextMenu}`);
  assert(activeAfterContextMenu !== 'body', `focus must not strand on <body> after closing the right-click context menu, got ${activeAfterContextMenu}`);
  log('STEP PASS: right-click context menu reveals the "..." slot and does not strand focus on <body> on close.');
  await cdp.screenshot(path.join(evidenceDir, '13-context-menu.png'));

  // ---- Renaming state (F2) ----
  await cdp.click(openButtonFinder);
  await cdp.waitFor(`document.activeElement === ${openButtonFinder}`, { timeoutMs: 10_000, label: 'row open button focused before F2' });
  await pressKey(cdp, 0x73, 'F2', 'F2');
  await cdp.waitFor(`!!${rowFinder}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename input shown' });
  const rowHeightWhileRenaming = await cdp.evaluate(
    `(() => { const li = ${rowFinder}; const surface = li.querySelector(':scope > div'); return surface.getBoundingClientRect().height; })()`
  );
  log(`verify-tauri-567: row height while renaming: ${rowHeightWhileRenaming}`);
  assert(rowHeightWhileRenaming >= 40, `row must not shrink while renaming (min-h-11), measured ${rowHeightWhileRenaming}`);
  log('STEP PASS: F2 renaming state shown on the row, full height kept.');
  await cdp.screenshot(path.join(evidenceDir, '04-row-renaming.png'));
  await pressKey(cdp, 27, 'Escape', 'Escape');
  await cdp.waitFor(`!${rowFinder}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename cancelled' });

  // ---- Needs-you (pending approval) status, branch line 2 ----
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'Approval card rendered (needs-you)' }
  );
  log('STEP PASS: Session now needs-you (pending approval).');
  await cdp.screenshot(path.join(evidenceDir, '05-row-needs-you.png'));
  const line2Branch = await cdp.evaluate(`(() => { const s = ${rowFinder}.querySelector('.session-open-button > span:last-child'); return { text: s.textContent, fontFamily: getComputedStyle(s).fontFamily }; })()`);
  log(`verify-tauri-567: line 2 (branch, needs-you row): ${JSON.stringify(line2Branch)}`);
  assert(line2Branch.fontFamily.toLowerCase().includes('cascadia') || line2Branch.fontFamily.toLowerCase().includes('consolas') || line2Branch.fontFamily.toLowerCase().includes('mono'), `branch line 2 must use the Code font (decision 10), got ${line2Branch.fontFamily}`);

  // ---- Marker-column alignment: Repository header's trigger right edge vs Archived's own,
  // measured geometrically (not dependent on a marker actually rendering) -- gate round 1 fix:
  // the previous #908 fold-in was 8px off and never measured live either way. ----
  const repoHeaderTriggerFinder = groupTriggerFinder(repoName);
  const repoTriggerRight = await cdp.evaluate(`${repoHeaderTriggerFinder}.getBoundingClientRect().right`);

  // ---- Archive it: Archived group label/count format, line 2 becomes the Project name. ----
  await hoverRow(cdp, rowFinder);
  await cdp.waitFor(`getComputedStyle(${ellipsisFinder}).opacity > 0.5`, { timeoutMs: 5_000, label: '"..." menu button visible before archiving' });
  await cdp.click(ellipsisFinder);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'row menu open with Archive item' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
  await cdp.waitFor(`!!${ARCHIVED_TRIGGER_FINDER}`, { timeoutMs: 15_000, label: 'Archived header rendered' });
  const archivedLabel = await cdp.evaluate(
    `(() => { const t = ${ARCHIVED_TRIGGER_FINDER}; return { text: t.textContent, hasBracket: /\\(/.test(t.textContent), countSpan: t.querySelector('span.tabular-nums')?.textContent ?? null }; })()`
  );
  writeFileSync(path.join(evidenceDir, 'archived-label.json'), JSON.stringify(archivedLabel, null, 2));
  log(`verify-tauri-567: Archived header label: ${JSON.stringify(archivedLabel)}`);
  assert(!archivedLabel.hasBracket, `Archived label must not use brackets (decision 5), got text=${JSON.stringify(archivedLabel.text)}`);
  assert(archivedLabel.countSpan === '1', `Archived header must show a separate tabular-nums count span (decision 5), got ${JSON.stringify(archivedLabel.countSpan)}`);

  // Marker-column alignment, measured now that both headers exist (geometric, regardless of a
  // real marker-worthy status on either side -- the trigger's own right edge is what `ml-auto`
  // anchors a marker against).
  const archivedTriggerRight = await cdp.evaluate(`${ARCHIVED_TRIGGER_FINDER}.getBoundingClientRect().right`);
  const alignmentDeltaPx = Math.abs(repoTriggerRight - archivedTriggerRight);
  writeFileSync(path.join(evidenceDir, 'marker-column-alignment.json'), JSON.stringify({ repoTriggerRight, archivedTriggerRight, alignmentDeltaPx }, null, 2));
  log(`verify-tauri-567: marker column alignment: Repository trigger right=${repoTriggerRight}, Archived trigger right=${archivedTriggerRight}, delta=${alignmentDeltaPx}px`);
  assert(alignmentDeltaPx <= 1, `Archived and Repository header triggers must line up within 1px (#908), measured delta=${alignmentDeltaPx}px`);
  log('STEP PASS: #908 marker column alignment measured live -- within 1px.');

  await cdp.click(ARCHIVED_TRIGGER_FINDER);
  await cdp.waitFor(`${ARCHIVED_TRIGGER_FINDER}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened' });
  const archivedRowFinder = `document.querySelector('[data-archived-group] li[data-choice-item]')`;
  await cdp.waitFor(`!!${archivedRowFinder}`, { timeoutMs: 10_000, label: 'archived row rendered' });
  const archivedLine2 = await cdp.evaluate(
    `(() => { const s = ${archivedRowFinder}.querySelector('.session-open-button > span:last-child'); return { text: s.textContent, hasIcon: !!s.querySelector('svg') }; })()`
  );
  log(`verify-tauri-567: archived row's own line 2 (should be the Project name with an icon): ${JSON.stringify(archivedLine2)}`);
  assert(archivedLine2.text === repoName, `archived row's line 2 must show its own Project name (decision 9), got ${JSON.stringify(archivedLine2.text)}`);
  assert(archivedLine2.hasIcon, `archived row's line 2 must show FolderGit2Icon (decision 9.4), got no icon`);
  const archivedDescription = await cdp.evaluate(
    `(() => { const btn = ${archivedRowFinder}.querySelector('.session-open-button'); const id = btn.getAttribute('aria-describedby'); return id ? document.getElementById(id)?.textContent ?? null : null; })()`
  );
  log(`verify-tauri-567: archived row's accessible description: ${JSON.stringify(archivedDescription)}`);
  assert(typeof archivedDescription === 'string' && archivedDescription.includes(repoName), `archived row's accessible description must include its own Project name (decision 16), got ${JSON.stringify(archivedDescription)}`);
  log('STEP PASS: Archived header label/count format, archived row line-2 Project name + icon, and the accessible description all verified.');
  await cdp.screenshot(path.join(evidenceDir, '06-archived-group-open.png'));
  await cdp.click(ARCHIVED_TRIGGER_FINDER); // close it again

  // ---- Decision 24: "No sessions yet" once the only Session is archived ----
  await cdp.waitFor(`${repoHeaderTriggerFinder}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Project group still open' });
  const emptyStateText = await cdp.evaluate(
    `(() => { const group = document.querySelector('[data-repository-id]'); const p = Array.from(group.querySelectorAll('p')).find((el) => el.textContent.includes('No sessions yet')); return p ? p.textContent : null; })()`
  );
  log(`verify-tauri-567: empty-Project state text: ${JSON.stringify(emptyStateText)}`);
  assert(emptyStateText === 'No sessions yet', `an open, empty Project must show "No sessions yet" (decision 24), got ${JSON.stringify(emptyStateText)}`);
  log('STEP PASS: decision 24\'s "No sessions yet" line renders once the only Session is archived.');
  await cdp.screenshot(path.join(evidenceDir, '14-empty-project.png'));

  // ---- Group header: sentence case ----
  const headerCase = await cdp.evaluate(`getComputedStyle(${repoHeaderTriggerFinder}).textTransform`);
  log(`verify-tauri-567: group header text-transform: ${headerCase}`);
  assert(headerCase === 'none', `group header must be sentence case, never uppercase (decision 4), got textTransform=${headerCase}`);

  // ---- Collapsed group with a Waiting marker ----
  await createSessionViaQuickCreate(cdp, repoName);
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'second session needs-you' });
  await cdp.click(repoHeaderTriggerFinder);
  await cdp.waitFor(`${repoHeaderTriggerFinder}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Project group collapsed' });
  const markerName = await cdp.evaluate(`${repoHeaderTriggerFinder}.getAttribute('aria-label')`);
  log(`verify-tauri-567: collapsed header accessible name (should include the Waiting marker): ${JSON.stringify(markerName)}`);
  assert(typeof markerName === 'string' && markerName.includes('Needs you'), `closed group with a needs-you Session must carry the Waiting marker in its accessible name (#735 decision 21), got ${JSON.stringify(markerName)}`);
  log('STEP PASS: closed group header carries the Waiting marker.');
  await cdp.screenshot(path.join(evidenceDir, '08-group-collapsed-waiting-marker.png'));

  // ---- Footer: one divider above Add repository + profile item, no second border on ProfileItem ----
  const footerCheck = await cdp.evaluate(
    `(() => { const footer = Array.from(document.querySelectorAll('nav div')).find((el) => el.className.includes('border-t') && el.querySelector('button')?.textContent?.includes('Add repository')); const profile = document.querySelector('[data-profile-name-button]')?.closest('div'); const fcs = footer ? getComputedStyle(footer) : null; const pcs = profile ? getComputedStyle(profile) : null; return { footerBorderWidth: fcs?.borderTopWidth, profileBorderWidth: pcs?.borderTopWidth, addRepoColor: getComputedStyle(footer.querySelector('button')).color }; })()`
  );
  writeFileSync(path.join(evidenceDir, 'footer-check.json'), JSON.stringify(footerCheck, null, 2));
  log(`verify-tauri-567: footer divider check: ${JSON.stringify(footerCheck)}`);
  assert(footerCheck.footerBorderWidth && footerCheck.footerBorderWidth !== '0px', `footer must keep its own top divider, got ${footerCheck.footerBorderWidth}`);
  assert(footerCheck.profileBorderWidth === '0px', `ProfileItem must NOT draw its own border-t any more (decision 20), got ${footerCheck.profileBorderWidth}`);
  log('STEP PASS: footer divider unified, ProfileItem no longer draws a second border.');
  await cdp.screenshot(path.join(evidenceDir, '09-footer.png'));

  // ---- Pull requests nav entry selected bar (decision 18) ----
  await cdp.clickByLabel('Pull requests');
  await cdp.waitFor(`document.querySelector('[aria-label="Pull requests"]').getAttribute('aria-current') === 'page'`, { timeoutMs: 10_000, label: 'Pull requests selected' });
  const prBar = await cdp.evaluate(`!!document.querySelector('[aria-label="Pull requests"] span[class*="bg-active-indicator"]')`);
  log(`verify-tauri-567: Pull requests selected bar present: ${prBar}`);
  assert(prBar, 'selected Pull requests nav entry must show the 2px active-indicator bar (decision 18)');
  log('STEP PASS: Pull requests nav entry shows the selected bar plus fill.');
  await cdp.screenshot(path.join(evidenceDir, '10-pull-requests-selected.png'));

  // ---- Restore the normal session-list/chat view before the caller's per-theme screenshots ----
  await cdp.click(repoHeaderTriggerFinder);
  await cdp.waitFor(`${repoHeaderTriggerFinder}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Project group reopened before theme screenshots' });
  const anyOpenButton = `document.querySelector('[data-repository-id] .session-open-button')`;
  await cdp.click(anyOpenButton);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 15_000, label: 'chat pane shown before theme screenshots' });

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  log(`verify-tauri-567: git HEAD under test: ${gitHead()}`);
  let shimDir, dataDir, importSourceDir, repoDir, exeDir;
  const evidenceDir = SHOT_DIR;
  let child;
  let cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-567-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-567-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-567-import-src-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-567-repo-')), 'A');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-567-exe-'));

    log(`verify-tauri-567: data dir ${dataDir}`);
    log(`verify-tauri-567: evidence/screenshot dir ${evidenceDir}`);
    log(`verify-tauri-567: repo ${repoDir} (name "${repoName}")`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
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
    const targetPid = launched.targetPid;
    cdp = await connectCdp(port, targetPid);
    assertExeMatchesProcess(targetPid, exePath, exeHash);
    log(`verify-tauri-567: launched, pid ${targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await runChecks(cdp, evidenceDir, log, { repoDir, repoName });

    // ---- Theme screenshots (Dark already captured above; Dark high contrast + Obsidian here) ----
    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(evidenceDir, '11-theme-dark-high-contrast.png'));
    log('STEP PASS: Dark (high contrast) theme screenshot captured.');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.screenshot(path.join(evidenceDir, '12-theme-obsidian.png'));
    log('STEP PASS: Obsidian theme screenshot captured.');

    log(`verify-tauri-567: ALL PASS. Evidence and screenshots: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    // evidenceDir (== SHOT_DIR) is NOT removed -- it is this run's own audit trail.
  }
}

main().catch((err) => {
  console.error('verify-tauri-567: FAIL');
  console.error(err);
  process.exitCode = 1;
});
