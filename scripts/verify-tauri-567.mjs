#!/usr/bin/env node
// #567 session list restyle live check against the scratch Tauri debug build. Reuses the exe
// `ci-local.mjs` just built (no rebuild here -- scratch copy + hash check only), the shared CDP
// driver (`verify-tauri-cdp.mjs`) and session-list helpers (`verify-tauri-session-list-helpers.mjs`),
// same precedent as `verify-tauri-735.mjs`.
//
// Proves, against the real rendered DOM (never window.refract.* as a shortcut for anything the
// UI itself should do -- window.refract.theme.set is the one exception, used only to switch
// themes between screenshots, the same exception verify-tauri-735.mjs documents):
//   - A #567-only DOM marker (the row's own `data-choice-item` <li>, and the Archived header's
//     own separate tabular-nums count span) is present before anything else is judged.
//   - Row geometry: ~44px row height, the open button's own focus ring draws INSIDE the row
//     (negative outline-offset), the selected row's active-indicator bar uses inset-y-1.
//   - The row's trailing slot: at rest shows the time; on hover the "..." menu button replaces
//     it (display, not opacity) and the time hides.
//   - Line 2 precedence: an archived row shows its own Project name, a non-archived row shows
//     its branch in the Code font.
//   - The row's own accessible name follows the "{name}, {status}[, Archived][, focused pane]"
//     comma form (CDP Accessibility domain, never textContent).
//   - Group header: sentence case (no uppercase/tracking), 24px ghost action buttons hidden at
//     rest and revealed on hover, a closed group's own Waiting marker.
//   - Archived group: "Archived" + a separate tabular-nums count span, never bracketed.
//   - Footer: one `border-divider` above the Add-repository/profile-item block, no second
//     border on the profile item itself.
//   - Dark (high contrast) and Obsidian screenshots via `window.refract.theme.set`.
//   - The exe actually driving the CDP session is the exact scratch copy this run built and
//     hashed (`assertExeMatchesProcess`).
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
const SHOT_DIR = process.env.REFRACT_567_SHOT_DIR || 'C:/Users/shopwood/AppData/Local/Temp/refract-567-shots';
const PRE_BUILT_EXE = process.env.REFRACT_567_PREBUILT_EXE;
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
    throw new Error(`copyBuiltExe: REFRACT_567_PREBUILT_EXE not set or missing (${PRE_BUILT_EXE}) -- this script never rebuilds, run ci-local or pnpm tauri build first`);
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

async function runChecks(cdp, evidenceDir, log, { repoDir, repoName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project group rendered' });
  log('STEP PASS: scratch Project added, group rendered.');

  // ---- #567-only marker: the row's own <li data-choice-item>, present before anything else
  // is judged (distinguishes this build from any other lane's exe/stale state). ----
  await createSessionViaQuickCreate(cdp, repoName);
  const rowFinder = `document.querySelector('[data-repository-id] li[data-choice-item]')`;
  await cdp.waitFor(`!!${rowFinder}`, { timeoutMs: 15_000, label: '#567 marker: li[data-choice-item] row' });
  log('STEP PASS: #567-only DOM marker present (li[data-choice-item] row).');
  await cdp.screenshot(path.join(evidenceDir, '01-row-idle-selected.png'));

  // ---- Row geometry: ~44px tall, square corners (no border-radius), focus ring draws inside. ----
  const rowGeometry = await cdp.evaluate(
    `(() => { const li = ${rowFinder}; const surface = li.firstElementChild.nextElementSibling ?? li.querySelector(':scope > div'); const r = surface.getBoundingClientRect(); const cs = getComputedStyle(surface); return { height: r.height, borderRadius: cs.borderRadius, liBorderRadius: getComputedStyle(li).borderRadius }; })()`
  );
  writeFileSync(path.join(evidenceDir, 'row-geometry.json'), JSON.stringify(rowGeometry, null, 2));
  log(`verify-tauri-567: row geometry: ${JSON.stringify(rowGeometry)}`);
  assert(rowGeometry.height >= 40 && rowGeometry.height <= 48, `row height should be close to 44px (decision 8), measured ${rowGeometry.height}`);
  assert(rowGeometry.borderRadius === '0px', `row surface must be square-cornered (FR-054), measured borderRadius=${rowGeometry.borderRadius}`);

  const openButtonFinder = `${rowFinder}.querySelector('.session-open-button')`;
  await cdp.click(openButtonFinder); // focuses it via the real click path (also selects it)
  await cdp.waitFor(`document.activeElement === ${openButtonFinder}`, { timeoutMs: 10_000, label: 'row open button focused' });
  // A mouse click does not engage `:focus-visible` in Chromium's own heuristic (only real
  // keyboard navigation does) -- Tab away then Shift+Tab back, real `Input.dispatchKeyEvent`
  // input (never a state poke), so the outline this decision actually cares about is the one
  // really drawn for a keyboard user, not a false negative from how the harness first focused it.
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

  // ---- Accessible name: "{name}, {status word}" comma form (decision 16). ----
  const axName = await cdp.send('Accessibility.getPartialAXTree', {
    objectId: (await cdp.send('Runtime.evaluate', { expression: openButtonFinder, returnByValue: false })).result.objectId
  }).then((r) => r.nodes?.[0]?.name?.value ?? null).catch(() => null);
  writeFileSync(path.join(evidenceDir, 'row-ax-name.json'), JSON.stringify({ axName }, null, 2));
  log(`verify-tauri-567: row open button accessible name: ${JSON.stringify(axName)}`);
  assert(typeof axName === 'string' && /, (Idle|Working|Needs you|Stopped|Unread response)/.test(axName), `accessible name must contain ", {status word}" (decision 16), got ${JSON.stringify(axName)}`);

  // ---- Trailing slot swap: at rest the time shows (aria-hidden); on hover the "..." button
  // takes its place (display, not just opacity) and the time hides. Blur first: the previous
  // keyboard-focus check left focus inside this row, and `group-focus-within` alone (correctly)
  // already hides the time -- "at rest" must mean neither hover nor focus is inside the row.
  await cdp.evaluate(`${openButtonFinder}.blur()`);
  await cdp.waitFor(`document.activeElement !== ${openButtonFinder}`, { timeoutMs: 5_000, label: 'row blurred before the at-rest check' });
  // The earlier click left the virtual pointer resting at the row's own centre -- `:hover` is
  // positional and never clears on its own without a real mouse-move event away from it.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  const timeFinder = `${rowFinder}.querySelector('.session-open-button span[aria-hidden]')`;
  const ellipsisFinder = `${rowFinder}.querySelector('button[aria-label$="actions"]')`;
  await cdp.waitFor(`getComputedStyle(${ellipsisFinder}).display === 'none'`, { timeoutMs: 5_000, label: '"..." menu button hidden again once hover/focus cleared' });
  const atRest = await cdp.evaluate(
    `(() => ({ timeDisplay: getComputedStyle(${timeFinder}).display, timeText: ${timeFinder}.textContent, menuDisplay: getComputedStyle(${ellipsisFinder}).display }))()`
  );
  log(`verify-tauri-567: trailing slot AT REST: ${JSON.stringify(atRest)}`);
  assert(atRest.timeDisplay !== 'none', `time must show at rest, got display=${atRest.timeDisplay}`);
  assert(atRest.menuDisplay === 'none', `"..." menu button must be hidden at rest, got display=${atRest.menuDisplay}`);
  await hoverRow(cdp, rowFinder);
  await cdp.waitFor(`getComputedStyle(${ellipsisFinder}).display !== 'none'`, { timeoutMs: 5_000, label: '"..." menu button shown on hover' });
  const onHover = await cdp.evaluate(`(() => ({ timeDisplay: getComputedStyle(${timeFinder}).display, menuDisplay: getComputedStyle(${ellipsisFinder}).display }))()`);
  log(`verify-tauri-567: trailing slot ON HOVER: ${JSON.stringify(onHover)}`);
  assert(onHover.timeDisplay === 'none', `time must hide on hover (decision 12), got display=${onHover.timeDisplay}`);
  assert(onHover.menuDisplay !== 'none', `"..." menu button must show on hover (decision 12), got display=${onHover.menuDisplay}`);
  log('STEP PASS: trailing time/"..." menu slot swap verified on hover (display toggling, not opacity).');
  await cdp.screenshot(path.join(evidenceDir, '03-row-hover-trailing-slot.png'));

  // ---- Renaming state (F2) ----
  await cdp.click(openButtonFinder); // F2 is handled by the open button's own keydown handler
  await cdp.waitFor(`document.activeElement === ${openButtonFinder}`, { timeoutMs: 10_000, label: 'row open button focused before F2' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 0x73, code: 'F2', key: 'F2' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 0x73, code: 'F2', key: 'F2' });
  await cdp.waitFor(`!!${rowFinder}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename input shown' });
  log('STEP PASS: F2 renaming state shown on the row.');
  await cdp.screenshot(path.join(evidenceDir, '04-row-renaming.png'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
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

  // ---- Archive it: Archived group label/count format, line 2 becomes the Project name.
  // `archiveFirstRowIn` (the shared helper) assumes an opacity-hidden "..." button, which still
  // has a real bounding rect to click; #567's own trailing slot instead toggles `display` (the
  // "takes that slot" swap, decision 12), so the row must be hovered first or the button has a
  // zero-size rect to click. ----
  await hoverRow(cdp, rowFinder);
  await cdp.waitFor(`getComputedStyle(${ellipsisFinder}).display !== 'none'`, { timeoutMs: 5_000, label: '"..." menu button visible before archiving' });
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
  await cdp.click(ARCHIVED_TRIGGER_FINDER);
  await cdp.waitFor(`${ARCHIVED_TRIGGER_FINDER}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Archived opened' });
  const archivedRowFinder = `document.querySelector('[data-archived-group] li[data-choice-item]')`;
  await cdp.waitFor(`!!${archivedRowFinder}`, { timeoutMs: 10_000, label: 'archived row rendered' });
  const archivedLine2 = await cdp.evaluate(`${archivedRowFinder}.querySelector('.session-open-button > span:last-child').textContent`);
  log(`verify-tauri-567: archived row's own line 2 (should be the Project name): ${JSON.stringify(archivedLine2)}`);
  assert(archivedLine2 === repoName, `archived row's line 2 must show its own Project name (decision 9), got ${JSON.stringify(archivedLine2)}`);
  log('STEP PASS: Archived header label/count format and archived row line-2 Project name verified.');
  await cdp.screenshot(path.join(evidenceDir, '06-archived-group-open.png'));

  // ---- Group header: sentence case, 24px ghost actions hidden at rest / shown on hover ----
  await cdp.click(ARCHIVED_TRIGGER_FINDER); // close it again
  const headerTrigger = groupTriggerFinder(repoName);
  const headerCase = await cdp.evaluate(`getComputedStyle(${headerTrigger}).textTransform`);
  log(`verify-tauri-567: group header text-transform: ${headerCase}`);
  assert(headerCase === 'none', `group header must be sentence case, never uppercase (decision 4), got textTransform=${headerCase}`);
  const headerActionsAtRest = await cdp.evaluate(
    `(() => { const plus = document.querySelector('[data-quick-create-session]'); const r = plus.getBoundingClientRect(); return { opacity: getComputedStyle(plus).opacity, width: r.width, height: r.height }; })()`
  );
  log(`verify-tauri-567: header "+" button at rest: ${JSON.stringify(headerActionsAtRest)}`);
  assert(Math.round(headerActionsAtRest.width) === 24 && Math.round(headerActionsAtRest.height) === 24, `header action buttons must be 24px icon-xs (decision 6), got ${JSON.stringify(headerActionsAtRest)}`);
  await hoverRow(cdp, `document.querySelector('[data-repository-id]')`);
  await cdp.waitFor(`parseFloat(getComputedStyle(document.querySelector('[data-quick-create-session]')).opacity) > 0.5`, { timeoutMs: 5_000, label: 'header actions revealed on hover' });
  log('STEP PASS: group header sentence case and 24px hover-revealed action buttons verified.');
  await cdp.screenshot(path.join(evidenceDir, '07-group-header-hover.png'));

  // ---- Collapsed group with a Waiting marker ----
  await createSessionViaQuickCreate(cdp, repoName);
  await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'second session needs-you' });
  await cdp.click(headerTrigger);
  await cdp.waitFor(`${headerTrigger}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Project group collapsed' });
  const markerName = await cdp.evaluate(`${headerTrigger}.getAttribute('aria-label')`);
  log(`verify-tauri-567: collapsed header accessible name (should include the Waiting marker): ${JSON.stringify(markerName)}`);
  assert(typeof markerName === 'string' && markerName.includes('Needs you'), `closed group with a needs-you Session must carry the Waiting marker in its accessible name (#735 decision 21), got ${JSON.stringify(markerName)}`);
  log('STEP PASS: closed group header carries the Waiting marker.');
  await cdp.screenshot(path.join(evidenceDir, '08-group-collapsed-waiting-marker.png'));

  // ---- Footer: one divider above Add repository + profile item, no second border on ProfileItem ----
  const footerCheck = await cdp.evaluate(
    `(() => { const footer = Array.from(document.querySelectorAll('nav div')).find((el) => el.className.includes('border-t') && el.querySelector('button')?.textContent?.includes('Add repository')); const profile = document.querySelector('[data-profile-name-button]')?.closest('div'); const fcs = footer ? getComputedStyle(footer) : null; const pcs = profile ? getComputedStyle(profile) : null; return { footerBorderWidth: fcs?.borderTopWidth, profileBorderWidth: pcs?.borderTopWidth }; })()`
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

  // ---- Restore the normal session-list/chat view (currently Pull requests, and the Project
  // group is still collapsed from the Waiting-marker check) before the caller's per-theme
  // screenshots, so those show the row layout rather than the Pull requests view. ----
  await cdp.click(headerTrigger);
  await cdp.waitFor(`${headerTrigger}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Project group reopened before theme screenshots' });
  const anyOpenButton = `document.querySelector('[data-repository-id] .session-open-button')`;
  await cdp.click(anyOpenButton);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 15_000, label: 'chat pane shown before theme screenshots' });

  log('ALL IN-PROCESS CHECKS PASS.');
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
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
