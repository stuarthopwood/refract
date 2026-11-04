#!/usr/bin/env node
// Live CDP check that the Todo readout is a pin-toggle and the pinned panel above the composer
// updates live. Driven by the `todo-pin-700` fake-omp tape (four turns: live plan, all done,
// cleared, re-created); selectors live in `verify-700-todo-pin-helpers.mjs`.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles,
  getAccessibleNameAndRole
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import {
  TODO_PILL_SELECTOR,
  PANEL_SELECTOR,
  readPill,
  readPanel,
  clickCollapseButton,
  clickUnpinButton,
  clickTodoPill,
  readScrollerScrollTop,
  SCROLLER_SELECTOR,
  readFirstMessageTop,
  readUpNextVisible,
  readStillRunning,
  settleForScreenshot,
  waitTwoFrames
} from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-700';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_700_SHOTS_DIR || path.join(tmpdir(), 'refract-700-todo-pin-shots');

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const report = [];
const notExercised = [];
function assertTrue(actual, label, extra) {
  const ok = actual === true;
  report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
  if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
  console.log(`${LOG}: PASS ${label}`);
}
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  report.push({ step: label, ok, actual, expected });
  if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  console.log(`${LOG}: PASS ${label}`);
}

async function focusAndPress(cdp, finderExpr, vk, key, code) {
  // WebView2 only delivers `Input.dispatchKeyEvent` to a JS-focused element with focus emulation
  // on; `text`/`unmodifiedText` make a focused `<button>` run its default Enter/Space activation.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.evaluate(`(${finderExpr}).focus()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, key, code, text: key === 'Enter' ? '\r' : ' ', unmodifiedText: key === 'Enter' ? '\r' : ' ' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code });
}

async function setWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
async function clearWidth(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(300);
}

/** Asserts exactly one pinned panel: a duplicate mount left a stale one that `document.querySelector`
 * silently read, so a recurrence must fail loudly. */
async function assertSinglePanel(cdp, label) {
  const count = await cdp.evaluate(`document.querySelectorAll('[data-slot="pinned-todo-panel"]').length`);
  assertEqual(count, 1, `Exactly one pinned-todo-panel element exists (${label})`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-700-todo-pin-shots', [...THEMES.map((t) => `pinned-${t.id}.png`), '360px.png', '520px.png', 'e4-follow-diagnostic.png', 'report.json']);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-700-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-700-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-700-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-700-todo-pin');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-700-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-700-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-700-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: 'todo-pin-700'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session A composer enabled' });

    await cdp.typeIntoByLabel('Message', 'plan and build the thing');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Todo pill appears once the first todo tool call lands' });
    assertTrue(!!(await cdp.evaluate(PANEL_SELECTOR.replace('document.querySelector', '!!document.querySelector'))) === false, 'Pinned panel is not yet mounted (not pinned yet)');

    assertTrue(await readUpNextVisible(cdp), 'E8: Up next renders while UNPINNED (a real one-agent Stage plus a pending phase exist)');

    const pillBeforePin = await readPill(cdp);
    assertEqual(pillBeforePin.ariaPressed, 'false', 'Pill aria-pressed is false before pinning');
    const axBeforePin = await getAccessibleNameAndRole(cdp, TODO_PILL_SELECTOR);
    assertTrue(axBeforePin.role === 'button', 'Pill AX role is a button', axBeforePin);
    assertTrue(/^Pin todo list \(Todo \d+\/\d+\)$/.test(axBeforePin.name ?? ''), 'P8: Pill AX name matches the fixed "Pin todo list (Todo d/t)" pattern', axBeforePin);

    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pinned panel mounts the instant the pill is clicked' });
    await assertSinglePanel(cdp, 'right after the initial pin');
    assertTrue(!(await readUpNextVisible(cdp)), 'E8: Up next hides the instant the panel is pinned');
    const pillAfterPin = await readPill(cdp);
    assertEqual(pillAfterPin.ariaPressed, 'true', 'Pill aria-pressed is true once pinned');
    const panelFirstRead = await readPanel(cdp);
    assertEqual(panelFirstRead.tagName, 'SECTION', 'P6: panel root is a <section> (an implicit ARIA region, not a bare <div>)');
    assertEqual(pillAfterPin.ariaControls, panelFirstRead.id, 'P10: Pill aria-controls names the panel\'s own id');
    assertEqual(panelFirstRead.ariaLabel, 'Todo list', 'Panel region is labelled "Todo list"');
    const sessionIdA = panelFirstRead.id.replace(/^todo-panel-/, '');
    assertTrue(sessionIdA.length > 0, 'Session A id read from the panel\'s own DOM id');
    assertEqual(panelFirstRead.collapseAriaControls, panelFirstRead.listId, 'P7: Collapse button aria-controls names the task list\'s own id');
    const axCollapse = await getAccessibleNameAndRole(cdp, `(${PANEL_SELECTOR}).querySelector('[aria-label="Todo list details"]')`);
    assertEqual(axCollapse.name, 'Todo list details', 'P7: Collapse button has the FIXED accessible name "Todo list details"');

    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Panel unmounts on Unpin' });
    assertTrue(await readUpNextVisible(cdp), 'E8: Up next returns once unpinned');
    // The restore is deferred one rAF and a CDP round trip can beat it, so poll instead of reading once.
    await cdp.waitFor(`document.activeElement === (${TODO_PILL_SELECTOR})`, { timeoutMs: 2_000, label: 'P3: focus lands on the pill after Unpin removes the focused button (never <body>)' });
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Re-pinned' });
    await assertSinglePanel(cdp, 'right after Unpin then re-pin');

    await cdp.waitFor(`!!(${PANEL_SELECTOR}).textContent.includes('Task 9')`, { timeoutMs: 10_000, label: 'Panel header shows "Task 9" as the live current task, mid-turn' });
    const midTurnRead = await readPanel(cdp);
    assertTrue(midTurnRead.phaseHeaders.some((h) => h.startsWith('Setup')), 'Setup phase header visible mid-turn (2 phases, so headers show)');
    assertTrue(midTurnRead.phaseHeaders.some((h) => h.startsWith('Work')), 'Work phase header visible mid-turn');
    assertEqual(midTurnRead.listTabIndex, '0', 'P9: the 12-task Work phase overflows its own cap, so the list is a keyboard Tab stop');

    await cdp.waitFor(`!!(${PANEL_SELECTOR}).textContent.includes('waiting on API docs')`, { timeoutMs: 10_000, label: 'Blocked task\'s own blocker line appears live, mid-turn' });
    const blockedRead = await readPanel(cdp);
    const blockedRow = blockedRead.rows.find((r) => r.hasBlockedLine);
    assertTrue(!!blockedRow, 'A row with a "Blocked:" line exists', blockedRead.rows);
    assertTrue(blockedRow.text.includes('waiting on API docs'), 'Blocked row names the real blocker text', blockedRow);

    assertTrue(await readStillRunning(cdp), 'E2: the turn is still running (Stop control present) while the blocked state is already shown live, well before settle');
    await assertSinglePanel(cdp, 'before the abandoned-status wait');

    // 20s: the tape holds 8s here and 15s left too little margin over launch/render latency.
    await cdp.waitFor(`!!(${PANEL_SELECTOR}).querySelector('.line-through')`, { timeoutMs: 20_000, label: 'Abandoned task strike-through appears live, mid-turn' });
    await assertSinglePanel(cdp, 'right after the abandoned update');
    assertTrue(await readStillRunning(cdp), 'E2: the turn is still running after the second 8s hold too (abandoned state already live)');
    const abandonedRead = await readPanel(cdp);
    assertTrue(abandonedRead.rows.some((r) => r.lineThrough && r.text.includes('Deploy')), 'Deploy row shows a strike-through (abandoned)', abandonedRead.rows);
    assertTrue(!abandonedRead.rows.some((r) => r.text.includes('Scaffold')), 'Setup phase folded: no individual Scaffold row once Setup is fully done');

    const listMetrics = await cdp.evaluate(`(() => { const l = document.getElementById((${PANEL_SELECTOR}).querySelector('[role="group"]').id); return { scrollHeight: l.scrollHeight, clientHeight: l.clientHeight, scrollTop: l.scrollTop }; })()`);
    assertTrue(listMetrics.scrollHeight > listMetrics.clientHeight, 'E4: the 14-task list genuinely overflows its own max-height cap');
    // Record which failure it was (missing row/scroller vs out of view) plus geometry, since both read as `false`.
    const e4Diag = await cdp.evaluate(`(() => {
      const panel = ${PANEL_SELECTOR};
      const list = panel ? panel.querySelector('[role="group"]') : null;
      const row = panel ? panel.querySelector('[data-current-task="true"]') : null;
      const rowRect = row ? row.getBoundingClientRect() : null;
      const listRect = list ? list.getBoundingClientRect() : null;
      const phases = list ? Array.from(list.querySelectorAll(':scope > div')).map((d) => ({ header: d.querySelector(':scope > div')?.textContent?.trim() ?? null, folded: !d.querySelector('ul') })) : [];
      return {
        panelFound: !!panel,
        listFound: !!list,
        rowFound: !!row,
        selector: '[data-current-task="true"]',
        rowRect: rowRect ? { top: rowRect.top, bottom: rowRect.bottom } : null,
        listRect: listRect ? { top: listRect.top, bottom: listRect.bottom } : null,
        listScrollTop: list ? list.scrollTop : null,
        listScrollHeight: list ? list.scrollHeight : null,
        listClientHeight: list ? list.clientHeight : null,
        phases,
        inView: (row && list) ? (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) : null
      };
    })()`);
    report.push({ step: 'DIAG E4 follow-into-view geometry', ok: true, extra: e4Diag });
    if (e4Diag.inView !== true) {
      await cdp.screenshot(path.join(SHOTS_DIR, 'e4-follow-diagnostic.png'));
    }
    assertTrue(e4Diag.inView === true, 'E4: the in-progress row is actually within the scrolled list\'s own visible bounds (followed into view)', e4Diag);
    // The in-progress task sits far down the Work phase, so being in view requires a real scroll.
    assertTrue(e4Diag.listScrollTop > 0, 'E4: the follow genuinely scrolled the list (listScrollTop > 0), not a no-op on an already-visible row', e4Diag);
    // A large wheel delta: a small fixed one can be a no-op when the follow landed near the top.
    const listRect = await cdp.evaluate(`(() => { const l = (${PANEL_SELECTOR}).querySelector('[role="group"]'); const r = l.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: listRect.x, y: listRect.y, deltaX: 0, deltaY: -200 });
    await sleep(200);
    await waitTwoFrames(cdp);
    const scrollTopAfterUserScroll = await cdp.evaluate(`(${PANEL_SELECTOR}).querySelector('[role="group"]').scrollTop`);
    assertTrue(scrollTopAfterUserScroll !== e4Diag.listScrollTop, 'E4: the real wheel scroll genuinely changed listScrollTop', { before: e4Diag.listScrollTop, after: scrollTopAfterUserScroll });

    // Spans the full scripted 8s delay (todo-7 -> todo-8), hence the 20s budget.
    await cdp.waitFor(`!!(${PANEL_SELECTOR}).textContent.includes('Task 11')`, { timeoutMs: 20_000, label: 'The second current-task change (Task 11) lands live' });
    await sleep(300);
    await waitTwoFrames(cdp);
    const afterSecondChange = await cdp.evaluate(`(() => {
      const panel = ${PANEL_SELECTOR};
      const list = panel.querySelector('[role="group"]');
      const row = panel.querySelector('[data-current-task="true"]');
      const rowRect = row ? row.getBoundingClientRect() : null;
      const listRect = list.getBoundingClientRect();
      return { scrollTop: list.scrollTop, outOfView: row ? !(rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) : null };
    })()`);
    assertEqual(afterSecondChange.scrollTop, scrollTopAfterUserScroll, 'E4: the list did NOT auto-scroll back to the new current task after a real user scroll (follow genuinely stopped)');
    assertTrue(afterSecondChange.outOfView === true, 'E4: the new current task (Task 11) is genuinely OUT of the scrolled list\'s own visible bounds (follow did not silently bring it into view)', afterSecondChange);

    await cdp.waitFor(`!!(${SCROLLER_SELECTOR})`, { timeoutMs: 1_000 }).catch(() => {});
    const scrollAtBottomBefore = await readScrollerScrollTop(cdp);
    const firstTopBefore = await readFirstMessageTop(cdp);
    await clickCollapseButton(cdp);
    await waitTwoFrames(cdp);
    assertEqual(await readScrollerScrollTop(cdp), scrollAtBottomBefore, 'E1: collapsing the panel (bottom-scrolled transcript) does not move the real scroller');
    assertEqual(await readFirstMessageTop(cdp), firstTopBefore, 'E1: collapsing the panel does not move the first message\'s own on-screen position');
    await clickCollapseButton(cdp);
    await waitTwoFrames(cdp);
    assertEqual(await readScrollerScrollTop(cdp), scrollAtBottomBefore, 'E1: expanding the panel again (bottom-scrolled transcript) does not move the real scroller');

    // The long reply is still streaming here, so growth exercises a real content-growth tick.
    const streamFollowBefore = await cdp.evaluate(`(() => { const el = ${SCROLLER_SELECTOR}; return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; })()`);
    await cdp.waitFor(`(() => { const el = ${SCROLLER_SELECTOR}; return !!el && el.scrollHeight > ${streamFollowBefore.scrollHeight}; })()`, { timeoutMs: 60_000, label: 'E1: more assistant content streams in while still at the end' });
    const streamFollowAfter = await cdp.evaluate(`(() => { const el = ${SCROLLER_SELECTOR}; return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; })()`);
    // 48 matches SCROLL_END_TOLERANCE_PX in scrollLanding.ts.
    assertTrue(streamFollowAfter.scrollHeight - streamFollowAfter.scrollTop - streamFollowAfter.clientHeight <= 48, 'E1: the transcript auto-follows newly streamed content while still at the end', streamFollowAfter);
    // The long reply streams in right after todo-8; without this wait `scrollTop = scrollHeight / 2` can be a no-op.
    await cdp.waitFor(`(() => { const el = ${SCROLLER_SELECTOR}; return !!el && el.scrollHeight > el.clientHeight; })()`, { timeoutMs: 60_000, label: 'Transcript genuinely overflows before the middle-scroll E1 check' });
    // A direct `el.scrollTop =` write marks no gesture and is correctly ignored; a CDP wheel event is real input.
    const overflowMetrics = await cdp.evaluate(`(() => { const el = ${SCROLLER_SELECTOR}; return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; })()`);
    const scrollerRect = await cdp.evaluate(`(() => { const el = ${SCROLLER_SELECTOR}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollerRect.x, y: scrollerRect.y, deltaX: 0, deltaY: -Math.floor((overflowMetrics.scrollHeight - overflowMetrics.clientHeight) / 2) });
    await sleep(200);
    const scrollAtMiddleBefore = await readScrollerScrollTop(cdp);
    assertTrue(scrollAtMiddleBefore !== null && scrollAtMiddleBefore > 0, 'E1 setup: transcript genuinely scrolled away from the bottom, to the middle');
    // A wheel exercises the scroller's free-scrolling path, not a scrollbar drag (recorded below as not covered).
    notExercised.push('A scrollbar drag (rather than a wheel scroll) while the vendored scroller is actively auto-scrolling streamed content -- a different input path through the same library, not exercised by this tape.');
    const middleScrollHeight = (await cdp.evaluate(`(() => { const el = ${SCROLLER_SELECTOR}; return el.scrollHeight; })()`));
    await cdp.waitFor(`(() => { const el = ${SCROLLER_SELECTOR}; return !!el && el.scrollHeight > ${middleScrollHeight}; })()`, { timeoutMs: 10_000, label: 'E1: the rest of the assistant reply streams in while scrolled away' });
    assertEqual(await readScrollerScrollTop(cdp), scrollAtMiddleBefore, 'E1: a wheel away from the end, followed by streaming growth, does NOT snap back');
    const firstTopMiddleBefore = await readFirstMessageTop(cdp);
    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Unpinned for the middle-scroll E1 check' });
    await waitTwoFrames(cdp);
    assertEqual(await readScrollerScrollTop(cdp), scrollAtMiddleBefore, 'E1: unpinning (mid-scrolled transcript) does not move the real scroller');
    assertEqual(await readFirstMessageTop(cdp), firstTopMiddleBefore, 'E1: unpinning does not move the first message\'s own on-screen position');
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Re-pinned for the middle-scroll E1 check' });
    await waitTwoFrames(cdp);
    assertEqual(await readScrollerScrollTop(cdp), scrollAtMiddleBefore, 'E1: re-pinning (mid-scrolled transcript) does not move the real scroller');

    await cdp.waitFor(`document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 60_000, label: 'Turn 1 settled, composer re-enabled' });
    // The composer re-enables synchronously on settle, but the `get_state` reconcile runs in a separate task, so poll the DOM.
    await cdp.waitFor(`(() => { const panel = ${PANEL_SELECTOR}; const list = panel?.querySelector('div.overflow-y-auto'); return !!list && !/Blocked:/.test(list.textContent); })()`, { timeoutMs: 10_000, label: 'E2: settle tree reconciles away the Blocked line' });
    const settledRead = await readPanel(cdp);
    assertTrue(!settledRead.rows.some((r) => r.hasBlockedLine), 'E2: settle tree reconciles "Update docs" from blocked (last live) to completed -- no Blocked line remains');
    assertTrue(/Todo 4\/13/.test(settledRead.header ?? ''), 'E2: header reads "Todo 4\\/13" at settle, differing from the pre-settle "Todo 3\\/13" (the reconciled Update docs now also counts as done)', settledRead.header);

    await cdp.evaluate(`(${PANEL_SELECTOR}).querySelector('[role="group"]').focus()`);
    await waitTwoFrames(cdp);
    assertTrue(await cdp.evaluate(`document.activeElement === (${PANEL_SELECTOR}).querySelector('[role="group"]')`), 'Setup: focus genuinely lands inside the task list before collapsing it');
    await clickCollapseButton(cdp);
    await waitTwoFrames(cdp);
    assertTrue(await cdp.evaluate(`document.activeElement === (${PANEL_SELECTOR}).querySelector('[aria-label="Todo list details"]')`), 'Main follow-up (c): collapsing with focus inside the list moves focus to the Collapse chevron (never <body>)');
    const collapsedRead = await readPanel(cdp);
    assertEqual(collapsedRead.collapsed, true, 'Collapse button hides the task list');
    assertTrue(collapsedRead.rows === null, 'Task list genuinely absent from the DOM while collapsed (not merely visually hidden)');
    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Panel unmounts once Unpin is clicked while collapsed' });
    await waitTwoFrames(cdp);
    assertTrue(await cdp.evaluate(`document.activeElement === (${TODO_PILL_SELECTOR}) && document.activeElement !== document.body`), 'Main follow-up (a): Unpin from a COLLAPSED panel restores focus to the pill (never <body>)');
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Re-pinned after the collapsed-Unpin focus check' });
    await clickCollapseButton(cdp);
    const expandedAgainRead = await readPanel(cdp);
    assertEqual(expandedAgainRead.collapsed, false, 'Collapse button toggles back to expanded');

    const settingsOffResult = await cdp.evaluate(`window.refract.settings.setReadoutVisibility('todo-progress', false).then((r) => r.ok)`);
    assertTrue(settingsOffResult === true, 'Turned the Todo readout off in Settings');
    await cdp.waitFor(`!(${TODO_PILL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pill disappears once the readout setting is off' });
    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)), 'Panel stays mounted (still pinned) even though the pill itself is now hidden');
    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Panel unmounts once Unpin is clicked from inside the panel, pill hidden' });
    await cdp.waitFor(`document.activeElement === document.querySelector('[aria-label="Message"]')`, { timeoutMs: 2_000, label: 'P3: focus lands on the composer after Unpin, with the pill itself hidden (never <body>)' });
    await cdp.evaluate(`window.refract.settings.setReadoutVisibility('todo-progress', true)`);
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pill reappears once the readout setting is back on' });

    await focusAndPress(cdp, TODO_PILL_SELECTOR, 13, 'Enter', 'Enter');
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Enter key on the focused pill pins the panel' });
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'Pill aria-pressed true after Enter');
    assertTrue(!!(await cdp.evaluate(`document.activeElement === (${TODO_PILL_SELECTOR})`)), 'E6: focus stays on the pill itself after the Enter that pinned it');
    await focusAndPress(cdp, `(${PANEL_SELECTOR}).querySelector('[aria-label="Unpin todo list"]')`, 13, 'Enter', 'Enter');
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Enter key on the focused Unpin button unpins the panel' });
    await cdp.waitFor(`document.activeElement === (${TODO_PILL_SELECTOR})`, { timeoutMs: 2_000, label: 'E6: keyboard Unpin leaves focus on the pill (never <body>)' });
    await focusAndPress(cdp, TODO_PILL_SELECTOR, 32, ' ', 'Space');
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Space key on the focused pill pins the panel' });
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'Pill aria-pressed true after Space');

    await clickCollapseButton(cdp);
    assertEqual((await readPanel(cdp)).collapsed, true, 'Collapsed before switching sessions');

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Session B dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Session B dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session B composer enabled' });
    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)) === false, 'Session B starts unpinned, a genuinely different pane (independent of Session A which is still pinned)');

    await cdp.typeIntoByLabel('Message', 'plan and build the thing');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Session B: Todo pill appears once its own first todo tool call lands' });
    assertEqual((await readPill(cdp)).ariaPressed, 'false', 'Session B: pill starts unpressed');
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Session B: pinned' });
    assertEqual((await readPanel(cdp)).collapsed, false, 'Session B: a FRESH pin starts expanded (its own default, independent of Session A\'s saved collapse)');

    const SESSION_A_ROW = `document.querySelector(${JSON.stringify(`button[data-session-open="${sessionIdA}"]`)})`;
    await cdp.click(SESSION_A_ROW);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 10_000, label: 'Switching back to Session A remounts its own pinned panel' });
    assertEqual((await readPanel(cdp)).collapsed, true, 'Session A\'s panel is STILL collapsed after switching away and back (per-Session, not reset)');
    await clickCollapseButton(cdp);

    for (const width of [360, 520]) {
      await setWidth(cdp, width);
      const scrollBefore = await readScrollerScrollTop(cdp);
      const overflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
      assertTrue(!overflow, `No horizontal scrollbar at ${width}px`);
      const noClip = await cdp.evaluate(`(() => { const panel = ${PANEL_SELECTOR}; if (!panel) return null; return Array.from(panel.querySelectorAll('li')).every((li) => { const span = li.querySelector('span.block.break-words'); return !span || getComputedStyle(span).overflow !== 'hidden'; }); })()`);
      assertTrue(noClip === true, `Task text has no clipping overflow at ${width}px`, noClip);
      await settleForScreenshot(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, `${width}px.png`));
      assertEqual(await readScrollerScrollTop(cdp), scrollBefore, `Transcript scroll position unchanged at ${width}px (no jump from the panel's own presence)`);
    }
    await clearWidth(cdp);

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await settleForScreenshot(cdp);
      const warningColor = await resolveCssVarColor(cdp, '--severity-warning', 'color');
      const panelBg = await cdp.evaluate(`getComputedStyle(document.body).backgroundColor`);
      const ratio = measuredContrastRatio(warningColor, panelBg);
      assertTrue(ratio >= 4.5, `${theme.name}: Blocked status word (--severity-warning) contrast >= 4.5:1 against the page background`, { ratio, warningColor, panelBg });
      await cdp.screenshot(path.join(SHOTS_DIR, `pinned-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)), 'Still on Session A, panel still pinned');
    await cdp.typeIntoByLabel('Message', 'finish the rest');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${PANEL_SELECTOR}).textContent.includes('All 13 done')`, { timeoutMs: 20_000, label: 'Panel header reads "All 13 done" once every open task is complete' });
    const allDoneRead = await readPanel(cdp);
    assertTrue(allDoneRead.rows === null, 'P2: "All N done" genuinely COLLAPSES the task list itself (list absent, not just the header text)');
    await cdp.evaluate(`(${PANEL_SELECTOR}).querySelector('[aria-label="Todo list details"]').focus()`);
    await waitTwoFrames(cdp);
    assertTrue(await cdp.evaluate(`document.activeElement === (${PANEL_SELECTOR}).querySelector('[aria-label="Todo list details"]')`), 'Setup: focus genuinely lands on the chevron before Unpin (after the all-done auto-collapse)');
    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Panel unmounts once Unpin is clicked right after the all-done auto-collapse' });
    await waitTwoFrames(cdp);
    assertTrue(await cdp.evaluate(`document.activeElement === (${TODO_PILL_SELECTOR}) && document.activeElement !== document.body`), 'Main follow-up (b): Unpin right after the "All N done" auto-collapse restores focus to the pill (never <body>)');
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Re-pinned after the all-done-collapse Unpin focus check' });

    await clickCollapseButton(cdp); // the user CAN expand again after all-done (P2's own reversibility)
    assertEqual((await readPanel(cdp)).collapsed, false, 'P2: the user can still expand the panel again after it auto-collapsed to "All N done"');
    await clickCollapseButton(cdp);
    await cdp.typeIntoByLabel('Message', 'clear the plan');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 20_000, label: 'Panel unmounts once the agent clears its plan entirely' });
    const noPlanStep = !!(await cdp.evaluate(`!(${TODO_PILL_SELECTOR})`));
    assertTrue(noPlanStep, 'E5: "panel absent with no plan" is its own distinct report step -- pill is also hidden with no plan (FR-021, unchanged)');

    await cdp.typeIntoByLabel('Message', 'start a follow-up plan');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 20_000, label: 'E8: the panel reappears, ALREADY pinned, the instant a new plan exists -- no click from this script' });
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'E8: the pill itself also reads pressed again on the new plan, with no click');

    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `pinned-${t.id}.png`), '360px.png', '520px.png']) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
