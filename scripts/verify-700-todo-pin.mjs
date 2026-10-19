#!/usr/bin/env node
// Live CDP check for issues #700/#701 slice (a): the Todo readout becomes a pin-toggle, and a
// pinned todo panel appears above the message box with a live-updating tree. Driven by the
// `todo-pin-700` fake-omp tape (`scripts/fixtures/omp-frames/todo-pin-700.jsonl`, next to this
// file's own README row) -- deterministic, no real model cost, three turns: (1) build Setup
// (2 tasks) and Work (5 tasks) phases through every status this slice cares about, mid-turn,
// settling with Setup folded/done and Work mixed (completed/in_progress/blocked/abandoned/
// pending); (2) complete every remaining open task ("All N done"); (3) clear the plan entirely
// (panel unmounts, pin stays). Selectors and small read helpers live in
// `verify-700-todo-pin-helpers.mjs` to stay under the #806 600-line soft cap.
//
// WRITTEN FOR A BUILD SLOT: this script has not yet been run against a real built app (no slot
// granted at authoring time) -- `node --check` is the only thing run against it so far.

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
import { pressKey } from './verify-tauri-session-list-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import {
  TODO_PILL_SELECTOR,
  PANEL_SELECTOR,
  readPill,
  readPanel,
  clickCollapseButton,
  clickUnpinButton,
  clickTodoPill,
  readTranscriptScrollTop
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
  await cdp.evaluate(`(${finderExpr}).focus()`);
  await pressKey(cdp, vk, key, code);
}

async function setWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
async function clearWidth(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(300);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-700-todo-pin-shots', [...THEMES.map((t) => `pinned-${t.id}.png`), '360px.png', '520px.png', 'report.json']);
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

    // ---- Readiness, Add repository, Session A ----
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session A composer enabled' });

    const transcriptScrollBefore = await readTranscriptScrollTop(cdp);

    // ---- Turn 1: kick off the scripted tape ----
    await cdp.typeIntoByLabel('Message', 'plan and build the thing');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Todo pill appears once the first todo tool call lands' });
    assertTrue(!!(await cdp.evaluate(PANEL_SELECTOR.replace('document.querySelector', '!!document.querySelector'))) === false, 'Pinned panel is not yet mounted (not pinned yet)');

    const pillBeforePin = await readPill(cdp);
    assertEqual(pillBeforePin.ariaPressed, 'false', 'Pill aria-pressed is false before pinning');
    const axBeforePin = await getAccessibleNameAndRole(cdp, TODO_PILL_SELECTOR);
    assertTrue(axBeforePin.role === 'button', 'Pill AX role is a button', axBeforePin);
    assertTrue(/^Pin todo list \(Todo \d+\/\d+\)$/.test(axBeforePin.name ?? ''), 'Pill AX name matches the fixed "Pin todo list (Todo d/t)" pattern', axBeforePin);

    // ---- Pin mid-turn (well before settle: the tape still has several __delay__-spaced todo
    // calls left) ----
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pinned panel mounts the instant the pill is clicked' });
    const pillAfterPin = await readPill(cdp);
    assertEqual(pillAfterPin.ariaPressed, 'true', 'Pill aria-pressed is true once pinned');
    const panelFirstRead = await readPanel(cdp);
    assertEqual(pillAfterPin.ariaControls, panelFirstRead.id, 'Pill aria-controls names the panel\'s own id');
    assertEqual(panelFirstRead.ariaLabel, 'Todo list', 'Panel region is labelled "Todo list"');
    // No dev-only `window.__refractStores` hook exists in this built (non-`vite dev`) asset
    // bundle (`import.meta.env.DEV` is false for a `vite build` output regardless of the Rust
    // side's own debug/release profile) -- the real Session id is instead read straight off the
    // panel's own DOM id (`todo-panel-<sessionId>`, `PinnedTodoPanel.tsx`), needing no hook.
    const sessionIdA = panelFirstRead.id.replace(/^todo-panel-/, '');
    assertTrue(sessionIdA.length > 0, 'Session A id read from the panel\'s own DOM id');
    const transcriptScrollAfterPin = await readTranscriptScrollTop(cdp);
    assertEqual(transcriptScrollAfterPin, transcriptScrollBefore, 'Opening the panel did not move the transcript scroll position');

    // ---- Live mid-turn updates: poll until the Work phase's current task reaches "Implement
    // feature" (todo-5), well before the turn settles ----
    await cdp.waitFor(`(${PANEL_SELECTOR}).textContent.includes('Implement feature')`, { timeoutMs: 10_000, label: 'Panel header shows "Implement feature" as the live current task, mid-turn' });
    const midTurnRead = await readPanel(cdp);
    assertTrue(midTurnRead.phaseHeaders.some((h) => h.startsWith('Setup')), 'Setup phase header visible mid-turn (2 phases, so headers show)');
    assertTrue(midTurnRead.phaseHeaders.some((h) => h.startsWith('Work')), 'Work phase header visible mid-turn');

    await cdp.waitFor(`(${PANEL_SELECTOR}).textContent.includes('waiting on API docs')`, { timeoutMs: 10_000, label: 'Blocked task\'s own blocker line appears live, mid-turn' });
    const blockedRead = await readPanel(cdp);
    const blockedRow = blockedRead.rows.find((r) => r.hasBlockedLine);
    assertTrue(!!blockedRow, 'A row with a "Blocked:" line exists', blockedRead.rows);
    assertTrue(blockedRow.text.includes('waiting on API docs'), 'Blocked row names the real blocker text', blockedRow);

    await cdp.waitFor(`!!(${PANEL_SELECTOR}).querySelector('.line-through')`, { timeoutMs: 10_000, label: 'Abandoned task strike-through appears live, mid-turn' });
    const abandonedRead = await readPanel(cdp);
    assertTrue(abandonedRead.rows.some((r) => r.lineThrough && r.text.includes('Deploy')), 'Deploy row shows a strike-through (abandoned)', abandonedRead.rows);
    // Setup (2/2, both completed) folds to one line once Work's own progression has moved past
    // it -- no individual "Scaffold"/"Configure" rows left once folded.
    assertTrue(!abandonedRead.rows.some((r) => r.text.includes('Scaffold')), 'Setup phase folded: no individual Scaffold row once Setup is fully done');

    // ---- Settle, then confirm the panel matches the settle state exactly ----
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 60_000, label: 'Turn 1 settled, composer re-enabled' });
    await sleep(500);
    const settledRead = await readPanel(cdp);
    assertEqual(settledRead.rows, abandonedRead.rows, 'Panel state after settle is byte-identical to the last live mid-turn read (no reconciliation drift)');
    const settledHeaderMatch = /Todo 3\/6/.test(settledRead.header ?? '');
    assertTrue(settledHeaderMatch, 'Header reads "Todo 3/6" at settle (done: Setup 2 + Write tests 1; total: Setup 2 + Work non-abandoned 4)', settledRead.header);

    // ---- Collapse control ----
    await clickCollapseButton(cdp);
    const collapsedRead = await readPanel(cdp);
    assertEqual(collapsedRead.collapsed, true, 'Collapse button hides the task list');
    assertTrue(collapsedRead.rows === null, 'Task list genuinely absent from the DOM while collapsed (not merely visually hidden)');
    await clickCollapseButton(cdp);
    const expandedAgainRead = await readPanel(cdp);
    assertEqual(expandedAgainRead.collapsed, false, 'Collapse button toggles back to expanded');

    // ---- Unpin via the panel header while the pill itself is hidden (Settings) ----
    const settingsOffResult = await cdp.evaluate(`window.refract.settings.setReadoutVisibility('todo-progress', false).then((r) => r.ok)`);
    assertTrue(settingsOffResult === true, 'Turned the Todo readout off in Settings');
    await cdp.waitFor(`!(${TODO_PILL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pill disappears once the readout setting is off' });
    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)), 'Panel stays mounted (still pinned) even though the pill itself is now hidden');
    await clickUnpinButton(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Panel unmounts once Unpin is clicked from inside the panel, pill hidden' });
    await cdp.evaluate(`window.refract.settings.setReadoutVisibility('todo-progress', true)`);
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 5_000, label: 'Pill reappears once the readout setting is back on' });

    // ---- Keyboard toggle: Enter re-pins, Space unpins ----
    await focusAndPress(cdp, TODO_PILL_SELECTOR, 13, 'Enter', 'Enter');
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Enter key on the focused pill pins the panel' });
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'Pill aria-pressed true after Enter');
    await focusAndPress(cdp, TODO_PILL_SELECTOR, 32, ' ', 'Space');
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Space key on the focused pill unpins the panel' });
    assertEqual((await readPill(cdp)).ariaPressed, 'false', 'Pill aria-pressed false after Space');

    // ---- Collapse persists per Session across a Session switch ----
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Re-pinned for the session-switch check' });
    await clickCollapseButton(cdp);
    assertEqual((await readPanel(cdp)).collapsed, true, 'Collapsed before switching sessions');

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Session B dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Session B dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session B composer enabled' });
    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)) === false, 'Session B starts unpinned, a genuinely different pane (independent of Session A which is still pinned)');

    const NOT_CURRENT_SESSION_ROW = `Array.from(document.querySelectorAll('nav[aria-label="Sessions"] [aria-current]')).find((el) => el.getAttribute('aria-current') !== 'true')`;
    await cdp.click(NOT_CURRENT_SESSION_ROW);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 10_000, label: 'Switching back to Session A remounts its own pinned panel' });
    assertEqual((await readPanel(cdp)).collapsed, true, 'Session A\'s panel is STILL collapsed after switching away and back (per-Session, not reset)');
    await clickCollapseButton(cdp);

    // ---- Narrow widths: wrap, no clipping, no horizontal scroll, no transcript jump ----
    for (const width of [360, 520]) {
      await setWidth(cdp, width);
      const scrollBefore = await readTranscriptScrollTop(cdp);
      const overflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
      assertTrue(!overflow, `No horizontal scrollbar at ${width}px`);
      const noClip = await cdp.evaluate(`(() => { const panel = ${PANEL_SELECTOR}; if (!panel) return null; return Array.from(panel.querySelectorAll('li')).every((li) => { const span = li.querySelector('span.block.break-words'); return !span || getComputedStyle(span).overflow !== 'hidden'; }); })()`);
      assertTrue(noClip === true, `Task text has no clipping overflow at ${width}px`, noClip);
      await cdp.screenshot(path.join(SHOTS_DIR, `${width}px.png`));
      const scrollAfter = await readTranscriptScrollTop(cdp);
      assertEqual(scrollAfter, scrollBefore, `Transcript scroll position unchanged at ${width}px (no jump from the panel's own presence)`);
    }
    await clearWidth(cdp);

    // ---- Five-theme screenshots + a live contrast read of the Blocked (amber) status word ----
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await cdp.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
      const warningColor = await resolveCssVarColor(cdp, '--severity-warning', 'color');
      const panelBg = await cdp.evaluate(`getComputedStyle(document.body).backgroundColor`);
      const ratio = measuredContrastRatio(warningColor, panelBg);
      assertTrue(ratio >= 4.5, `${theme.name}: Blocked status word (--severity-warning) contrast >= 4.5:1 against the page background`, { ratio, warningColor, panelBg });
      await cdp.screenshot(path.join(SHOTS_DIR, `pinned-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- Turn 2 on Session A (already the current pane, unchanged since the switch-back
    // above): complete everything -> "All N done" ----
    assertTrue(!!(await cdp.evaluate(`!!(${PANEL_SELECTOR})`)), 'Still on Session A, panel still pinned');
    await cdp.typeIntoByLabel('Message', 'finish the rest');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(${PANEL_SELECTOR}).textContent.includes('All 6 done')`, { timeoutMs: 20_000, label: 'Panel collapses its header to "All 6 done" once every open task is complete' });

    // ---- Turn 3 on Session A: clear the plan -> panel unmounts, pin survives ----
    await cdp.typeIntoByLabel('Message', 'clear the plan');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 20_000, label: 'Panel unmounts once the agent clears its plan entirely' });
    assertTrue(!!(await cdp.evaluate(`!(${TODO_PILL_SELECTOR})`)), 'Pill is also hidden with no plan (FR-021, unchanged)');
    notExercised.push('"The pin stays" with no plan (decision item 5): with both the pill and panel absent (no plan at all), there is no DOM-observable trace of the underlying per-Session `pinned` flag to assert against in a built (non-`vite dev`) asset bundle, which exposes no `window.__refractStores` hook -- `useTodoPinStore`\'s own `pinned`/`setPinned` logic (it is never cleared by `PinnedTodoPanel.tsx`, which only ever READS it) was verified by code inspection, not a live DOM read; a fourth tape turn re-creating a plan and observing the panel reappear pinned with no click would prove it live and was not built this round.');

    notExercised.push('Up next hiding while pinned (FR-030): this tape\'s turns never include a task()/subagent batch, so UpNextList never renders at all regardless of pin state (gated on stagesCount > 0) -- the hide-while-pinned rule could not be exercised against a real appear/disappear transition without a second, subagent-carrying tape; UpNextList.tsx\'s own `pinned` read was verified by code inspection only.');

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
