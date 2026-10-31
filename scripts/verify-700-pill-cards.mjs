#!/usr/bin/env node
// Live CDP check for #700 (b): hover/focus cards on the Todo and Agents readouts, driven by the
// `700-pill-cards` fake-omp tape (scripts/fixtures/omp-frames/700-pill-cards.jsonl).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { TODO_PILL_SELECTOR, readPill, clickTodoPill, settleForScreenshot, waitTwoFrames } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-700b';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_700B_SHOTS_DIR || path.join(tmpdir(), 'refract-700-pill-cards-shots');

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

// Mirrors Rust `subagent_task_summary` (subagents.rs) step for step so the assertion is
// independent of the implementation's own output.
const BETA_TASK =
  'Draft the staged migration plan for the user settings schema covering backward compatibility, a rollback path, and the staged rollout sequence across every supported region, including rollback triggers and a communication plan for affected teams.';
function expectedTaskSummary(rawTask) {
  const collapsed = rawTask.split(/\s+/).filter(Boolean).join(' ');
  const withoutHeading = collapsed.startsWith('#') ? collapsed.replace(/^#+\s*/, '') : collapsed;
  if (!withoutHeading) return null;
  let sentenceEnd = -1;
  for (let i = 0; i < withoutHeading.length; i++) {
    const c = withoutHeading[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    const next = withoutHeading[i + 1];
    if (next === undefined || /\s/.test(next)) {
      sentenceEnd = i + 1;
      break;
    }
  }
  const sentence = (sentenceEnd === -1 ? withoutHeading : withoutHeading.slice(0, sentenceEnd)).trim();
  if (!sentence) return null;
  const chars = [...sentence];
  if (chars.length > 100) {
    const truncated = chars.slice(0, 97).join('').trimEnd();
    return `${truncated}...`;
  }
  return sentence;
}
const EXPECTED_BETA_SUMMARY = expectedTaskSummary(BETA_TASK);

const AGENTS_PILL_SELECTOR = `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.getAttribute('aria-label') ?? '').startsWith('Open subagents panel'))`;
const TODO_CARD_SELECTOR = `document.querySelector('[data-slot="todo-card"]')`;
const AGENTS_CARD_SELECTOR = `document.querySelector('[data-slot="agents-card"]')`;
const SUBAGENTS_PANEL_SELECTOR = `document.querySelector('[role="tree"][aria-label="Subagents"]')`;
const TODO_CARD_HEADER_SELECTOR = `(${TODO_CARD_SELECTOR})?.querySelector('[data-slot="todo-card-header"]')`;
const AGENTS_CARD_HEADER_SELECTOR = `(${AGENTS_CARD_SELECTOR})?.querySelector('[data-slot="agents-card-header"]')`;

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

/** Fails if an unrelated tooltip/hover-card is already open before this check's hover/focus move. */
async function assertNoStrayOverlay(cdp, label) {
  const stray = await cdp.evaluate(`!!document.querySelector('[role="tooltip"], [data-slot="tooltip-content"], [data-slot="hover-card-content"]')`);
  assertTrue(stray === false, `No unrelated tooltip/hover-card open before ${label}`);
}

/** Compares a completed row's icon/text colour with a throwaway `text-severity-success` span; the raw
 * CSS custom property may be an unresolved `oklch(...)` that never matches a computed RGB. */
async function completedRowMatchesSeveritySuccess(cdp, cardSelector, rowTextIncludes) {
  return cdp.evaluate(`(() => {
    const ref = document.createElement('span');
    ref.className = 'text-severity-success';
    document.body.appendChild(ref);
    const refColor = getComputedStyle(ref).color;
    ref.remove();
    const card = ${cardSelector};
    const row = Array.from(card.querySelectorAll('li')).find((li) => li.textContent.includes(${JSON.stringify(rowTextIncludes)}));
    const icon = row?.querySelector('svg') ?? null;
    const text = row?.querySelector('span.block') ?? null;
    return {
      found: !!row,
      refColor,
      iconColor: icon ? getComputedStyle(icon).color : null,
      textColor: text ? getComputedStyle(text).color : null
    };
  })()`);
}

async function hoverElement(cdp, selector) {
  const rect = await cdp.evaluate(`(() => { const el = ${selector}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
}

/** Moves the pointer in steps (not one teleport) so each step can trigger a stray `pointerleave`. */
async function hoverPathBetween(cdp, fromSelector, toSelector, { steps = 8 } = {}) {
  const rects = await cdp.evaluate(`(() => {
    const from = ${fromSelector};
    const to = ${toSelector};
    const f = from.getBoundingClientRect();
    const t = to.getBoundingClientRect();
    return { fx: f.x + f.width / 2, fy: f.y + f.height / 2, tx: t.x + t.width / 2, ty: t.y + t.height / 2 };
  })()`);
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const x = rects.fx + (rects.tx - rects.fx) * ratio;
    const y = rects.fy + (rects.ty - rects.fy) * ratio;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(40);
  }
}

async function moveToNeutralPoint(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 20 });
}

/** Real Tab key, not `.focus()`: Chromium suppresses `:focus-visible` after mouse-driven focus. */
async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}

/** Tabs (bounded) until `selector` is focused, independent of how many stops precede it. */
async function tabUntilFocused(cdp, selector, { maxTabs = 40 } = {}) {
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  for (let i = 0; i < maxTabs; i++) {
    await pressTab(cdp);
    await waitTwoFrames(cdp);
    const isTarget = await cdp.evaluate(`document.activeElement === (${selector})`);
    if (isTarget) return;
  }
  throw new Error(`tabUntilFocused: never reached ${selector} within ${maxTabs} Tab presses`);
}

/** Structural proxy for "inert text": no non-off `aria-live` and no implicit live-region role. */
async function assertCardIsInert(cdp, selector, label) {
  const inert = await cdp.evaluate(`(() => {
    const card = ${selector};
    if (!card) return null;
    const live = card.querySelector('[aria-live]:not([aria-live="off"])');
    const announcing = card.querySelector('[role="status"], [role="alert"], [role="log"]');
    return { noLiveRegion: !live, noAnnouncingRole: !announcing };
  })()`);
  assertTrue(inert?.noLiveRegion === true, `${label}: no non-off aria-live region inside the card`, inert);
  assertTrue(inert?.noAnnouncingRole === true, `${label}: no status/alert/log role inside the card`, inert);
}

async function settleCardScreenshot(cdp, { anchorSelector }) {
  await moveToNeutralPoint(cdp);
  await assertNoStrayOverlay(cdp, 'the themed card screenshot');
  await hoverElement(cdp, anchorSelector);
  await sleep(550); // past the 400ms open delay with margin
  await cdp.evaluate(`document.getAnimations().forEach((a) => { try { a.finish() } catch (e) {} })`);
}

/** Opens a row's "..." menu and picks "Open in split"; a Ctrl+click never arrives as `ctrlKey` in
 * this WebView2 build. The trigger is hidden until row hover, and the click is scoped to the open menu. */
async function openSessionInSplitViaMenu(cdp, sessionId) {
  const openBtnSelector = `document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]')`;
  await hoverElement(cdp, openBtnSelector);
  const menuBtnFinder = `(() => { const openBtn = ${openBtnSelector}; const row = openBtn?.closest('li'); return row?.querySelector('button[aria-label^="More actions for "]') ?? null; })()`;
  await cdp.click(menuBtnFinder);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'Session row actions menu open' });
  const clicked = await cdp.evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    const item = menu ? Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Open in split') : null;
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`openSessionInSplitViaMenu(${sessionId}): 'Open in split' menu item not found in the open menu.`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-700-pill-cards-shots', [...THEMES.map((t) => `todo-card-${t.id}.png`), ...THEMES.map((t) => `agents-card-${t.id}.png`), 'todo-card-split-360.png', 'agents-card-split-360.png', 'todo-card-completed-green.png', 'pinned-panel-completed-green.png', 'report.json']);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-700b-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-700b-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-700b-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-700-pill-cards');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-700b-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-700b-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-700b-shim-'));

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
        REFRACT_FAKE_OMP_SCENARIO: '700-pill-cards'
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
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    await cdp.typeIntoByLabel('Message', 'run the batch and the plan');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Todo pill appears once the first todo tool call lands' });
    await cdp.waitFor(`!!(${AGENTS_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Agents pill appears once the subagent batch starts' });
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 30_000, label: 'Turn settled, composer re-enabled' });
    // `get_state` reconciliation runs as a separate task after the composer re-enables; poll the pill.
    await cdp.waitFor(`(() => { const p = ${TODO_PILL_SELECTOR}; return !!p && (p.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Todo 5/7'; })()`, { timeoutMs: 10_000, label: 'Todo pill reads the settled "Todo 5/7" figure' });

    await assertNoStrayOverlay(cdp, 'the Todo card hover test');
    await hoverElement(cdp, TODO_PILL_SELECTOR);
    assertTrue(!!(await cdp.evaluate(`!!(${TODO_CARD_SELECTOR})`)) === false, 'Todo card is not yet open the instant the pointer arrives (the ~400ms delay has not elapsed)');
    await sleep(550);
    await cdp.waitFor(`!!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Todo card opens after the hover delay' });
    const todoCardRead = await cdp.evaluate(`(() => {
      const card = ${TODO_CARD_SELECTOR};
      const rows = Array.from(card.querySelectorAll('li')).map((li) => ({
        text: li.textContent.trim(),
        lineThrough: !!li.querySelector('.line-through'),
        hasBlockedLine: /Blocked:/.test(li.textContent)
      }));
      const phaseHeaders = Array.from(card.querySelectorAll('div')).map((d) => d.textContent.trim()).filter((t) => /^(Setup|Work) \\d+\\/\\d+$/.test(t));
      const headerText = (${TODO_CARD_HEADER_SELECTOR})?.textContent?.trim() ?? null;
      return { tagName: card.tagName, rows, phaseHeaders, headerText };
    })()`);
    assertEqual(todoCardRead.headerText, '5 of 7', 'Todo card header reads "5 of 7", matching the pill\'s own "Todo 5/7" figure');
    // `foldFinished={false}`: the finished Setup phase is not folded here, unlike the pinned panel.
    assertEqual(todoCardRead.rows.length, 8, 'Todo card shows all eight tasks across both phases (Setup never folds here, unlike the pinned panel)');
    assertTrue(todoCardRead.phaseHeaders.some((h) => h.startsWith('Setup')), 'Todo card shows the "Setup" phase header', todoCardRead.phaseHeaders);
    assertTrue(todoCardRead.phaseHeaders.some((h) => h.startsWith('Work')), 'Todo card shows the "Work" phase header', todoCardRead.phaseHeaders);
    assertTrue(todoCardRead.rows.some((r) => r.text.includes('Scaffold')), 'Todo card still shows the finished Setup phase\'s own "Scaffold" row (not folded)', todoCardRead.rows);
    assertTrue(todoCardRead.rows.some((r) => r.text.includes('Configure')), 'Todo card still shows the finished Setup phase\'s own "Configure" row (not folded)', todoCardRead.rows);
    const docsRow = todoCardRead.rows.find((r) => r.text.includes('Update docs'));
    assertTrue(!!docsRow?.hasBlockedLine && docsRow.text.includes('waiting on API docs'), 'Todo card shows the blocked task\'s own "Blocked: <reason>" line', docsRow);
    const cleanupRow = todoCardRead.rows.find((r) => r.text.includes('Clean up'));
    assertTrue(cleanupRow?.lineThrough === true, 'Todo card shows the abandoned task with a strike-through', cleanupRow);
    const finalizeRow = todoCardRead.rows.find((r) => r.text.includes('Finalize'));
    assertTrue(!!finalizeRow && /In progress/.test(finalizeRow.text), 'Todo card shows the in-progress task\'s visible "In progress" word', finalizeRow);
    const scaffoldColorInCard = await completedRowMatchesSeveritySuccess(cdp, TODO_CARD_SELECTOR, 'Scaffold');
    assertTrue(scaffoldColorInCard.found && scaffoldColorInCard.iconColor === scaffoldColorInCard.refColor && scaffoldColorInCard.textColor === scaffoldColorInCard.refColor, 'Todo card\'s completed "Scaffold" row -- icon AND text -- renders in text-severity-success, not neutral grey', scaffoldColorInCard);
    await cdp.screenshot(path.join(SHOTS_DIR, 'todo-card-completed-green.png'));
    await assertCardIsInert(cdp, TODO_CARD_SELECTOR, 'Todo card');

    await hoverElement(cdp, TODO_CARD_SELECTOR);
    await sleep(200);
    assertTrue(await cdp.evaluate(`!!(${TODO_CARD_SELECTOR})`), 'Todo card stays open while the pointer is over the card itself (hoverable)');
    await moveToNeutralPoint(cdp);
    await cdp.waitFor(`!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Todo card closes once the pointer leaves both the pill and the card' });

    await tabUntilFocused(cdp, TODO_PILL_SELECTOR);
    assertTrue(await cdp.evaluate(`document.activeElement.matches(':focus-visible')`), 'Tab-focused Todo pill genuinely matches :focus-visible');
    await cdp.waitFor(`!!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Todo card opens immediately on keyboard focus-visible (no hover delay)' });
    await pressEscape(cdp);
    await cdp.waitFor(`!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Escape closes the Todo card' });
    assertTrue(await cdp.evaluate(`document.activeElement === (${TODO_PILL_SELECTOR})`), 'Focus stays on the Todo pill after Escape closes the card');

    await clickTodoPill(cdp);
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'Todo pill is pinned');
    await cdp.waitFor(`!!document.querySelector('[data-slot="pinned-todo-panel"]')`, { timeoutMs: 2_000, label: 'Pinned todo panel mounts once pinned' });
    // "Scaffold" sits in the fully completed Setup phase, which the pinned panel folds away; "Write tests" is in the open Work phase.
    const writeTestsColorInPanel = await completedRowMatchesSeveritySuccess(cdp, `document.querySelector('[data-slot="pinned-todo-panel"]')`, 'Write tests');
    assertTrue(writeTestsColorInPanel.found && writeTestsColorInPanel.iconColor === writeTestsColorInPanel.refColor && writeTestsColorInPanel.textColor === writeTestsColorInPanel.refColor, 'Pinned todo panel\'s completed "Write tests" row -- icon AND text -- renders in text-severity-success, not neutral grey', writeTestsColorInPanel);
    await cdp.screenshot(path.join(SHOTS_DIR, 'pinned-panel-completed-green.png'));
    await assertNoStrayOverlay(cdp, 'the pinned-Todo-card-never-opens test');
    await hoverElement(cdp, TODO_PILL_SELECTOR);
    await sleep(700); // comfortably past the 400ms open delay
    assertTrue(!(await cdp.evaluate(`!!(${TODO_CARD_SELECTOR})`)), 'Todo card does not open on hover while the todo list is pinned');
    await moveToNeutralPoint(cdp);
    await tabUntilFocused(cdp, TODO_PILL_SELECTOR);
    await sleep(100);
    assertTrue(!(await cdp.evaluate(`!!(${TODO_CARD_SELECTOR})`)), 'Todo card does not open on keyboard focus-visible while the todo list is pinned');
    await moveToNeutralPoint(cdp);
    await clickTodoPill(cdp);
    assertEqual((await readPill(cdp)).ariaPressed, 'false', 'Todo pill unpinned again, restoring the hover/focus card for the remaining checks');

    await assertNoStrayOverlay(cdp, 'the Agents card hover test');
    await hoverElement(cdp, AGENTS_PILL_SELECTOR);
    await sleep(550);
    await cdp.waitFor(`!!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Agents card opens after the hover delay' });
    const agentsCardRead = await cdp.evaluate(`(() => {
      const card = ${AGENTS_CARD_SELECTOR};
      const rows = Array.from(card.querySelectorAll('li')).map((li) => ({
        text: li.textContent.trim(),
        name: li.querySelector('[data-slot="agents-card-name"]')?.textContent?.trim() ?? null,
        summary: li.querySelector('.truncate.text-muted-foreground')?.textContent?.trim() ?? null,
        elapsed: li.querySelector('.tabular-nums')?.textContent?.trim() ?? null
      }));
      const settledLine = card.querySelector('[data-slot="agents-card-settled"]')?.textContent?.trim() ?? null;
      const linkText = card.querySelector('button, a')?.textContent?.trim();
      const headerText = (${AGENTS_CARD_HEADER_SELECTOR})?.textContent?.trim() ?? null;
      return { rows, settledLine, linkText, headerText };
    })()`);
    assertEqual(agentsCardRead.headerText, '1 running', 'Agents card header reads "1 running"');
    assertEqual(agentsCardRead.rows.length, 1, 'Agents card shows exactly one running row (alpha finished, gamma failed, neither is running)');
    assertEqual(agentsCardRead.rows[0].name, 'beta', 'Agents card\'s running row leads with the subagent\'s own given name ("beta"), not its task text');
    assertEqual(agentsCardRead.rows[0].summary, EXPECTED_BETA_SUMMARY, 'Agents card\'s running row shows beta\'s own taskSummary, truncated at 100 chars with "..."');
    assertTrue(/\d/.test(agentsCardRead.rows[0].elapsed ?? ''), 'Agents card\'s running row includes a non-empty elapsed-time figure', agentsCardRead.rows[0]);
    assertEqual(agentsCardRead.settledLine, '1 finished, 1 failed', 'Agents card shows the quiet settled-counts line, worded distinctly per status');
    assertEqual(agentsCardRead.linkText, 'Open subagents panel', 'Agents card has a link control reading "Open subagents panel"');
    await assertCardIsInert(cdp, AGENTS_CARD_SELECTOR, 'Agents card');

    const elapsedBefore = agentsCardRead.rows[0].elapsed;
    await sleep(1500);
    const elapsedAfter = await cdp.evaluate(`(${AGENTS_CARD_SELECTOR}).querySelector('li .tabular-nums')?.textContent?.trim() ?? null`);
    assertTrue(elapsedAfter !== null && elapsedAfter !== elapsedBefore, 'Agents card\'s elapsed-time figure genuinely advances about 1.5s later', { elapsedBefore, elapsedAfter });

    await hoverPathBetween(cdp, AGENTS_PILL_SELECTOR, AGENTS_CARD_SELECTOR);
    assertTrue(await cdp.evaluate(`!!(${AGENTS_CARD_SELECTOR})`), 'Agents card stays open through a slow pointer traversal from the pill into the card');

    assertTrue(!(await cdp.evaluate(`!!(${SUBAGENTS_PANEL_SELECTOR})`)), 'Subagents panel is not open yet');
    await cdp.click(`(${AGENTS_CARD_SELECTOR}).querySelector('button, a')`);
    await cdp.waitFor(`!!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'The Agents card\'s own link opens the Subagents panel' });
    const subagentRows = await cdp.evaluate(`Array.from((${SUBAGENTS_PANEL_SELECTOR}).querySelectorAll('[role="treeitem"]')).map((el) => el.textContent.trim())`);
    assertTrue(subagentRows.length >= 3, 'Subagents panel lists all three subagents (alpha, beta, gamma)', subagentRows);
    notExercised.push('gamma\'s own taskSummary (no sentence-ending punctuation at all in its `task` text, so Rust falls back to the whole string) has no live DOM surface to assert against once it is `failed`: the Agents card only ever renders a row for a RUNNING agent, and the Subagents panel shows `nameOrTask`, never `taskSummary`.');

    // The pill only opens/re-focuses the panel (never toggles), so close it via its Close control.
    await cdp.click(`document.querySelector('[data-panel-close]')`);
    await cdp.waitFor(`!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Subagents panel closes via its own Close control' });

    await cdp.click(AGENTS_PILL_SELECTOR);
    await cdp.waitFor(`!!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Clicking the Agents pill itself still opens the Subagents panel' });

    await moveToNeutralPoint(cdp);
    await tabUntilFocused(cdp, AGENTS_PILL_SELECTOR);
    assertTrue(await cdp.evaluate(`document.activeElement.matches(':focus-visible')`), 'Tab-focused Agents pill genuinely matches :focus-visible');
    await cdp.waitFor(`!!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Agents card opens immediately on keyboard focus-visible' });
    await pressEscape(cdp);
    await cdp.waitFor(`!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Escape closes the Agents card' });
    assertTrue(await cdp.evaluate(`document.activeElement === (${AGENTS_PILL_SELECTOR})`), 'Focus stays on the Agents pill after Escape closes the card');

    // The panels are percentage-sized siblings, so close the Subagents panel to free width for the split maths below.
    if (await cdp.evaluate(`!!(${SUBAGENTS_PANEL_SELECTOR})`)) { await cdp.click(`document.querySelector('[data-panel-close]')`); await cdp.waitFor(`!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Subagents panel closed before the split-view section' }); }

    const sessionIdA = await cdp.evaluate(`document.querySelector('[data-session-pane]')?.getAttribute('data-session-pane') ?? null`);
    assertTrue(typeof sessionIdA === 'string' && sessionIdA.length > 0, 'Session A\'s own id read from its pane');
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Session B dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Session B dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session B composer enabled' });
    // A deferred focus-switch to B races later steps, and "Open in split" on the already-sole pane is a
    // no-op, so target the other session. The second pane only mounts once chat is >= 720px
    // (MIN_SPLIT_WIDTH_PX), so widen first; 1400px still left chat at 699.84px.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const sessionIdB = await cdp.evaluate(`(() => { const ids = Array.from(document.querySelectorAll('[data-session-open]')).map((el) => el.getAttribute('data-session-open')); return ids.find((id) => id !== ${JSON.stringify(sessionIdA)}) ?? null; })()`);
    assertTrue(typeof sessionIdB === 'string' && sessionIdB.length > 0 && sessionIdB !== sessionIdA, 'Session B\'s own id read from its row (distinct from Session A)', { sessionIdA, sessionIdB });
    const currentPaneId = await cdp.evaluate(`document.querySelector('[data-session-pane]')?.getAttribute('data-session-pane') ?? null`);
    const sessionToSplit = currentPaneId === sessionIdA ? sessionIdB : sessionIdA;
    await openSessionInSplitViaMenu(cdp, sessionToSplit);
    await cdp.waitFor(`document.querySelectorAll('[data-session-pane]').length === 2`, { timeoutMs: 15_000, label: 'Split view open: both panes rendered' });
    // Sidebar share is percentage-based, so step the width down and re-confirm the split stays open at each step.
    let paneWidth = await cdp.evaluate(`document.querySelector('[data-session-pane="${sessionIdA}"]').getBoundingClientRect().width`); let targetWindowWidth = 1800;
    for (const candidateWidth of [1600, 1450, 1300, 1150, 1050]) {
      if (paneWidth <= 420) break;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: candidateWidth, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      if ((await cdp.evaluate(`document.querySelectorAll('[data-session-pane]').length`)) !== 2) break;
      targetWindowWidth = candidateWidth;
      paneWidth = await cdp.evaluate(`document.querySelector('[data-session-pane="${sessionIdA}"]').getBoundingClientRect().width`);
    }
    assertTrue(paneWidth <= 420, `Session A's own split pane is narrowed to roughly 360px (actual ${Math.round(paneWidth)}px)`, { paneWidth, targetWindowWidth });

    await settleCardScreenshot(cdp, { anchorSelector: TODO_PILL_SELECTOR });
    const todoCardRectInSplit = await cdp.evaluate(`(() => { const r = (${TODO_CARD_SELECTOR}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, innerWidth: window.innerWidth, innerHeight: window.innerHeight }; })()`);
    assertTrue(todoCardRectInSplit.left >= 0 && todoCardRectInSplit.right <= todoCardRectInSplit.innerWidth && todoCardRectInSplit.top >= 0 && todoCardRectInSplit.bottom <= todoCardRectInSplit.innerHeight, 'Todo card stays fully inside the window at a 360px split pane width, never clipped', todoCardRectInSplit);
    await cdp.screenshot(path.join(SHOTS_DIR, 'todo-card-split-360.png'));
    await moveToNeutralPoint(cdp);
    await settleCardScreenshot(cdp, { anchorSelector: AGENTS_PILL_SELECTOR });
    const agentsCardRectInSplit = await cdp.evaluate(`(() => { const r = (${AGENTS_CARD_SELECTOR}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, innerWidth: window.innerWidth, innerHeight: window.innerHeight }; })()`);
    assertTrue(agentsCardRectInSplit.left >= 0 && agentsCardRectInSplit.right <= agentsCardRectInSplit.innerWidth && agentsCardRectInSplit.top >= 0 && agentsCardRectInSplit.bottom <= agentsCardRectInSplit.innerHeight, 'Agents card stays fully inside the window at a 360px split pane width, never clipped', agentsCardRectInSplit);
    await cdp.screenshot(path.join(SHOTS_DIR, 'agents-card-split-360.png'));
    await moveToNeutralPoint(cdp);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    await sleep(300);
    // Close Session B's pane so the theme screenshots show the single-pane layout.
    await cdp.click(`(() => { const paneB = Array.from(document.querySelectorAll('[data-session-pane]')).find((p) => p.getAttribute('data-session-pane') !== ${JSON.stringify(sessionIdA)}); return paneB?.querySelector('[aria-label^="Close "]'); })()`);
    await cdp.waitFor(`document.querySelectorAll('[data-session-pane]').length === 1`, { timeoutMs: 10_000, label: 'Split view closed, back to Session A alone' });

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      // switchTheme can leave a tooltip mid-close-animation, so settle on every iteration.
      await settleForScreenshot(cdp);
      await settleCardScreenshot(cdp, { anchorSelector: TODO_PILL_SELECTOR });
      await cdp.screenshot(path.join(SHOTS_DIR, `todo-card-${theme.id}.png`));
      await moveToNeutralPoint(cdp);
      await settleCardScreenshot(cdp, { anchorSelector: AGENTS_PILL_SELECTOR });
      await cdp.screenshot(path.join(SHOTS_DIR, `agents-card-${theme.id}.png`));
      await moveToNeutralPoint(cdp);
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // Turn 2 settles beta via an update to the same toolCallId (no new start); sent last because
    // earlier assertions need a running agent.
    await cdp.typeIntoByLabel('Message', 'check on beta');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 30_000, label: 'Turn 2 settled, composer re-enabled' });
    await cdp.waitFor(`(() => { const p = ${AGENTS_PILL_SELECTOR}; return !!p && !(p.getAttribute('aria-label') ?? '').includes('running'); })()`, { timeoutMs: 10_000, label: 'Agents pill no longer reads "running" once beta settles' });
    await assertNoStrayOverlay(cdp, 'the zero-running Agents card test');
    await hoverElement(cdp, AGENTS_PILL_SELECTOR);
    await sleep(700); // comfortably past the 400ms open delay
    assertTrue(!(await cdp.evaluate(`!!(${AGENTS_CARD_SELECTOR})`)), 'Agents card does not open on hover once no subagent is running, even with finished/failed counts non-zero');
    await moveToNeutralPoint(cdp);
    // Session B still in the list adds tab stops (needs 44, past the default 40).
    await tabUntilFocused(cdp, AGENTS_PILL_SELECTOR, { maxTabs: 60 });
    await sleep(100);
    assertTrue(!(await cdp.evaluate(`!!(${AGENTS_CARD_SELECTOR})`)), 'Agents card does not open on keyboard focus-visible once no subagent is running');
    await moveToNeutralPoint(cdp);

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `todo-card-${t.id}.png`), ...THEMES.map((t) => `agents-card-${t.id}.png`), 'todo-card-split-360.png', 'agents-card-split-360.png', 'todo-card-completed-green.png', 'pinned-panel-completed-green.png'])
    });
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
