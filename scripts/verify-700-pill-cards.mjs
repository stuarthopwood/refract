#!/usr/bin/env node
// Live CDP check for issue #700 slice (b): hover/focus cards on the Todo and Agents readouts,
// plus the Rust `taskSummary` field the Agents card shows. Driven by the `700-pill-cards`
// fake-omp tape (`scripts/fixtures/omp-frames/700-pill-cards.jsonl`): one turn, a three-subagent
// `task()` batch (one finishes immediately, one stays genuinely running, one is later settled to
// failed by a separate `tool_execution_update`) plus a six-task Todo phase running through every
// live status (`pending`/`in_progress`/`completed`/`blocked`/`abandoned`).
//
// Reuses slice (a)'s own `TODO_PILL_SELECTOR`/`readPill`/`clickTodoPill`/`settleForScreenshot`/
// `waitTwoFrames` from `verify-700-todo-pin-helpers.mjs` rather than re-defining them a second,
// slightly different way.

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

// The exact beta `task` text from the tape, and the expected `taskSummary` Rust computes from it
// (first `.`/`!`/`?`-delimited sentence, inclusive, capped at 100 chars with `...`) -- mirrors
// `subagent_task_summary` (`subagents.rs`) byte-for-byte so this assertion is independent proof,
// not a copy of the implementation's own expected output.
const BETA_TASK =
  'Draft the staged migration plan for the user settings schema covering backward compatibility, a rollback path, and the staged rollout sequence across every supported region, including rollback triggers and a communication plan for affected teams.';
function expectedTaskSummary(task) {
  const sentenceEndIndex = [...task].findIndex((c) => c === '.' || c === '!' || c === '?');
  const sentence = sentenceEndIndex === -1 ? task : task.slice(0, sentenceEndIndex + 1);
  const chars = [...sentence];
  return chars.length > 100 ? `${chars.slice(0, 100).join('')}...` : sentence;
}
const EXPECTED_BETA_SUMMARY = expectedTaskSummary(BETA_TASK);

const AGENTS_PILL_SELECTOR = `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.getAttribute('aria-label') ?? '').startsWith('Open subagents panel'))`;
const TODO_CARD_SELECTOR = `document.querySelector('[data-slot="todo-card"]')`;
const AGENTS_CARD_SELECTOR = `document.querySelector('[data-slot="agents-card"]')`;
const SUBAGENTS_PANEL_SELECTOR = `document.querySelector('[role="tree"][aria-label="Subagents"]')`;

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

/** Fails loudly (per the brief's own rule) if an UNRELATED tooltip/hover-card is already open
 * before this check's own hover/focus move -- never silently coexists with one. */
async function assertNoStrayOverlay(cdp, label) {
  const stray = await cdp.evaluate(`!!document.querySelector('[role="tooltip"], [data-slot="tooltip-content"], [data-slot="hover-card-content"]')`);
  assertTrue(stray === false, `No unrelated tooltip/hover-card open before ${label}`);
}

async function hoverElement(cdp, selector) {
  const rect = await cdp.evaluate(`(() => { const el = ${selector}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
}

async function moveToNeutralPoint(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 20 });
}

/** Real Tab key navigation (not a bare JS `.focus()`), the established per-script convention
 * (`verify-tauri-ask.mjs` et al.): Chromium suppresses `:focus-visible` after a mouse-driven
 * focus, so only a genuine keyboard-caused focus reliably matches it. */
async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}

/** Repeatedly Tabs (bounded) until `selector` itself is the focused element -- robust to exactly
 * how many stops precede it in the real build's tab order, unlike a hardcoded Tab count. */
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

/** No live-region announcement anywhere inside the card (decision record: "inert text") --
 * structural proxy for "nothing in the card is announced unexpectedly": no `aria-live` other
 * than an explicit `"off"`, and no implicit-live-region role. */
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

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-700-pill-cards-shots', [...THEMES.map((t) => `todo-card-${t.id}.png`), ...THEMES.map((t) => `agents-card-${t.id}.png`), 'report.json']);
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

    // ---- Readiness, Add repository, Session ----
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

    // ---- Kick off the scripted tape, then run it fully to settle (deterministic final state) ----
    await cdp.typeIntoByLabel('Message', 'run the batch and the plan');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Todo pill appears once the first todo tool call lands' });
    await cdp.waitFor(`!!(${AGENTS_PILL_SELECTOR})`, { timeoutMs: 15_000, label: 'Agents pill appears once the subagent batch starts' });
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 30_000, label: 'Turn settled, composer re-enabled' });
    // The settle-time `get_state` reconciliation runs as a separate spawned task after the
    // composer re-enables (same ordering slice (a)'s own gate round 6 fix documents) -- poll the
    // real DOM effect (the pill's own final figure) instead of racing it with a fixed sleep.
    await cdp.waitFor(`(() => { const p = ${TODO_PILL_SELECTOR}; return !!p && (p.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Todo 3/5'; })()`, { timeoutMs: 10_000, label: 'Todo pill reads the settled "Todo 3/5" figure' });

    // ---- Todo card: hover opens it, hidden when empty is moot here (a real plan exists) ----
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
      return { tagName: card.tagName, rows };
    })()`);
    assertEqual(todoCardRead.rows.length, 6, 'Todo card shows all six tasks (one phase, no header, nothing folded)');
    const docsRow = todoCardRead.rows.find((r) => r.text.includes('Update docs'));
    assertTrue(!!docsRow?.hasBlockedLine && docsRow.text.includes('waiting on API docs'), 'Todo card shows the blocked task\'s own "Blocked: <reason>" line', docsRow);
    const cleanupRow = todoCardRead.rows.find((r) => r.text.includes('Clean up'));
    assertTrue(cleanupRow?.lineThrough === true, 'Todo card shows the abandoned task with a strike-through', cleanupRow);
    const finalizeRow = todoCardRead.rows.find((r) => r.text.includes('Finalize'));
    assertTrue(!!finalizeRow && /In progress/.test(finalizeRow.text), 'Todo card shows the in-progress task\'s visible "In progress" word', finalizeRow);
    await assertCardIsInert(cdp, TODO_CARD_SELECTOR, 'Todo card');

    // Pointer leaves the pill but travels into the card itself -- "hoverable": stays open.
    await hoverElement(cdp, TODO_CARD_SELECTOR);
    await sleep(200);
    assertTrue(await cdp.evaluate(`!!(${TODO_CARD_SELECTOR})`), 'Todo card stays open while the pointer is over the card itself (hoverable)');
    // Pointer leaves both -- closes (past the close grace window).
    await moveToNeutralPoint(cdp);
    await cdp.waitFor(`!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Todo card closes once the pointer leaves both the pill and the card' });

    // ---- Todo card: keyboard focus-visible opens it, Escape closes it, focus stays on the pill ----
    await tabUntilFocused(cdp, TODO_PILL_SELECTOR);
    assertTrue(await cdp.evaluate(`document.activeElement.matches(':focus-visible')`), 'Tab-focused Todo pill genuinely matches :focus-visible');
    await cdp.waitFor(`!!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Todo card opens immediately on keyboard focus-visible (no hover delay)' });
    await pressEscape(cdp);
    await cdp.waitFor(`!(${TODO_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Escape closes the Todo card' });
    assertTrue(await cdp.evaluate(`document.activeElement === (${TODO_PILL_SELECTOR})`), 'Focus stays on the Todo pill after Escape closes the card');

    // ---- Decision item 1: the Todo card never opens while pinned ----
    await clickTodoPill(cdp);
    assertEqual((await readPill(cdp)).ariaPressed, 'true', 'Todo pill is pinned');
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

    // ---- Agents card: hover opens it, shows the running agent's summary + elapsed, the quiet
    // settled count, and a link that opens the Subagents panel ----
    await assertNoStrayOverlay(cdp, 'the Agents card hover test');
    await hoverElement(cdp, AGENTS_PILL_SELECTOR);
    await sleep(550);
    await cdp.waitFor(`!!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Agents card opens after the hover delay' });
    const agentsCardRead = await cdp.evaluate(`(() => {
      const card = ${AGENTS_CARD_SELECTOR};
      const rows = Array.from(card.querySelectorAll('li')).map((li) => li.textContent.trim());
      const settledLine = card.querySelector('[data-slot="agents-card-settled"]')?.textContent?.trim() ?? null;
      const linkText = card.querySelector('button, a')?.textContent?.trim();
      return { rows, settledLine, linkText };
    })()`);
    assertEqual(agentsCardRead.rows.length, 1, 'Agents card shows exactly one running row (alpha finished, gamma failed, neither is running)');
    assertTrue(agentsCardRead.rows[0].includes(EXPECTED_BETA_SUMMARY), 'Agents card\'s running row shows beta\'s own taskSummary, truncated at 100 chars with "..."', { actual: agentsCardRead.rows[0], expected: EXPECTED_BETA_SUMMARY });
    assertTrue(/\d/.test(agentsCardRead.rows[0] ?? ''), 'Agents card\'s running row includes a non-empty elapsed-time figure', agentsCardRead.rows[0]);
    assertEqual(agentsCardRead.settledLine, '1 finished, 1 failed', 'Agents card shows the quiet settled-counts line, worded distinctly per status');
    assertEqual(agentsCardRead.linkText, 'Open subagents panel', 'Agents card has a link control reading "Open subagents panel"');
    await assertCardIsInert(cdp, AGENTS_CARD_SELECTOR, 'Agents card');

    // ---- Agents card: its own link opens the Subagents panel ----
    assertTrue(!(await cdp.evaluate(`!!(${SUBAGENTS_PANEL_SELECTOR})`)), 'Subagents panel is not open yet');
    await cdp.click(`(${AGENTS_CARD_SELECTOR}).querySelector('button, a')`);
    await cdp.waitFor(`!!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'The Agents card\'s own link opens the Subagents panel' });
    const subagentRows = await cdp.evaluate(`Array.from((${SUBAGENTS_PANEL_SELECTOR}).querySelectorAll('[role="treeitem"]')).map((el) => el.textContent.trim())`);
    assertTrue(subagentRows.length >= 3, 'Subagents panel lists all three subagents (alpha, beta, gamma)', subagentRows);
    notExercised.push('gamma\'s own taskSummary (no sentence-ending punctuation at all in its `task` text, so Rust falls back to the whole string) has no live DOM surface to assert against once it is `failed`: the Agents card only ever renders a row for a RUNNING agent, and the Subagents panel shows `nameOrTask`, never `taskSummary`.');

    // Close the panel via its own real Close control (`data-panel-close`, `PanelTabBar.tsx`) --
    // `openHostedPanel` (the pill's own `onActivate`) only ever OPENS/re-focuses a panel, it is
    // never a toggle (that is `toggleHostedPanelFromRail`'s own, separate job, not wired to this
    // chip), confirmed by reading `hosted-panel-actions.ts` directly rather than assuming.
    await cdp.click(`document.querySelector('[data-panel-close]')`);
    await cdp.waitFor(`!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Subagents panel closes via its own Close control' });

    // ---- Decision record: "click still opens it" -- the Agents pill's own click is unaffected
    // by the hover/focus card work ----
    await cdp.click(AGENTS_PILL_SELECTOR);
    await cdp.waitFor(`!!(${SUBAGENTS_PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Clicking the Agents pill itself still opens the Subagents panel' });

    // ---- Agents card: keyboard focus-visible opens it, Escape closes it, focus stays on the pill ----
    await moveToNeutralPoint(cdp);
    await tabUntilFocused(cdp, AGENTS_PILL_SELECTOR);
    assertTrue(await cdp.evaluate(`document.activeElement.matches(':focus-visible')`), 'Tab-focused Agents pill genuinely matches :focus-visible');
    await cdp.waitFor(`!!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Agents card opens immediately on keyboard focus-visible' });
    await pressEscape(cdp);
    await cdp.waitFor(`!(${AGENTS_CARD_SELECTOR})`, { timeoutMs: 2_000, label: 'Escape closes the Agents card' });
    assertTrue(await cdp.evaluate(`document.activeElement === (${AGENTS_PILL_SELECTOR})`), 'Focus stays on the Agents pill after Escape closes the card');

    // ---- Screenshots: Dark (default) and Obsidian, card genuinely open in both ----
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      else await settleForScreenshot(cdp); // clears any stray overlay left by the theme switcher itself
      await settleCardScreenshot(cdp, { anchorSelector: TODO_PILL_SELECTOR });
      await cdp.screenshot(path.join(SHOTS_DIR, `todo-card-${theme.id}.png`));
      await moveToNeutralPoint(cdp);
      await settleCardScreenshot(cdp, { anchorSelector: AGENTS_PILL_SELECTOR });
      await cdp.screenshot(path.join(SHOTS_DIR, `agents-card-${theme.id}.png`));
      await moveToNeutralPoint(cdp);
    }
    await switchTheme(cdp, 'dark', 'Dark');

    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `todo-card-${t.id}.png`), ...THEMES.map((t) => `agents-card-${t.id}.png`)]) });
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
