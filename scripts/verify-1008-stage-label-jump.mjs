#!/usr/bin/env node
// Live CDP check for issue #1008 (UI polish: Stage rows -- failed Stage label colour and jump to
// Stage from the chain row). Both items already Decided (Skippy, delegated by Stuart
// 2026-10-18) on the issue; gate round 1 remediation (Main, 2026-10-18) added items 6-9 below,
// decisions recorded in `research.md` decision 23 and `spec.md` FR-089.
//
// Item 1: a failed Stage's own label now gets `text-severity-error` the same way a failed tool
// row's label already does (`ToolRow.tsx` :209/:405) -- `SubagentChainRow.tsx`'s `StageGroupRow`
// and `ChainStageLine.tsx`'s own `ChainStageLine` both read the shared `subagentStatusTextClass`.
// Item 2: each "Stage N" label in the chain row (`ChainStageLine`) is a real `<button>` ("Go to
// Stage N, <label>") that scrolls its own Stage row into view (the transcript's own scroll
// viewport only, top-aligned), opens it through the SAME persisted path `useStickyDisclosure`
// reads (`useStageToggleStore`, issue #991 -- so a jump counts as the user's own manual open),
// and moves focus to the Stage's own trigger (`stageJump.ts`'s `jumpToStage`). Gate round 1 item
// 1 (High): the button only renders while its own Stage row is genuinely `'visible'`
// (`transcriptRowVisibility.ts`) -- "Show tool calls" off can drop a settled, problem-free Stage
// entirely, leaving no row to jump to.
//
// Reuses the recorded-frame fake `omp` harness and the SAME `stages-941.jsonl` fixture (scenario
// `stages-941`) every `verify-941-*`/`verify-991-*`/`verify-1000-*` script already shares
// (AGENTS.md: no new fixtures) -- it already carries a genuinely failed Stage (Stage 5, one
// FailAgent member) among ten Stages, so the turn already satisfies "2+ Stages where one fails"
// with no fixture change needed.
//
// Two Stages used as independent jump targets -- both multi-member, fully finished, and never
// otherwise touched by this script, so each starts genuinely CLOSED (no failed/cancelled/exited
// member, issue #1000's multi-Stage auto-open rule): Stage 1 (mouse click) and Stage 3 (keyboard:
// focus its own jump button directly, then a real Enter keypress -- native <button> Enter
// activation needs no special-casing in `jumpToStage` itself). Gate round 1 item 8 (Medium):
// the transcript is explicitly scrolled to its own end before EACH jump (Stage 1/Stage 3 sit
// near the top of a ten-Stage turn) and the target row's own off-screen state is asserted as a
// hard precondition, not assumed; after the jump, `cdp.waitFor` polls for in-viewport (the
// smooth scroll settles asynchronously) instead of a single immediate read.
//
// Gate round 1 item 9 (Medium): #991 persistence is exercised cheaply by toggling "Show tool
// calls" off then back on (a real IPC round trip, `window.refract.settings.setTranscriptDisplay`,
// the same dev-exposed call `verify-557-thought-runs.mjs` already uses) right after Stage 1's own
// mouse jump -- this is a genuine unmount/remount of Stage 1's own row (gate round 1 item 1's own
// visibility gate), doubling as the proof that Stage 1's manual-open (set by the jump) survives
// it, and that Stage 5 (a failed Stage, force-visible regardless of the toggle) never disappears.
// `prefers-reduced-motion` is NOT emulated by this CDP session, so `jumpToStage`'s own
// instant-jump branch is recorded in `notExercised`, never silently skipped without comment.
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus a real `import()` load-check (with `CARGO_TARGET_DIR` unset, per the build-slot guard)
// are the only commands that have actually been run against this file. Every DOM/class-name
// selector reused here (`stageTriggerSelector`, `titleSelector`, the chain row's own
// `[title="Subagents"]` trigger finder) was already grep-verified by the `verify-941-*`/
// `verify-1000-*` scripts that share them; the new finder expressions (`jumpButtonExpr`, the
// chain row's own "Go to Stage N, <label>" button by its full accessible name; `isInViewportExpr`)
// are built the same, already-proven way.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath, resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  clickScrolled,
  expandByFinder,
  titleSelector,
  stageTriggerSelector,
  STAGE1_TITLE,
  STAGE3_TITLE,
  STAGE5_TITLE
} from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressKey } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE =
  'Run the full ten-stage batch (issue #1008 live check: failed Stage label colour, jump to Stage from the chain row).';
const SHOTS_DIR =
  process.env.REFRACT_1008_SHOTS_DIR || path.join(tmpdir(), `refract-1008-stage-label-jump-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-stage1-jumped-open-focused.png',
  '02-stage3-jumped-via-keyboard.png',
  '1008-stage-label-jump-dark.png',
  '1008-stage-label-jump-obsidian.png',
  '1008-stage-label-jump-dark-high-contrast.png',
  'report.json',
  'app.log',
  'fake-omp-invocations.log'
];

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// The chain row's own label is always the literal string "Subagents" (`SubagentChainRow.tsx`),
// never duplicated elsewhere -- same constant every `verify-941-*`/`verify-991-*`/`verify-1000-*`
// script shares.
const CHAIN_TRIGGER = `document.querySelector('[title="Subagents"]')?.closest('[data-slot="collapsible-trigger"]')`;

// Issue #1008 item 2/gate round 1 item 6: the jump button's own accessible name is "Go to
// <speech heading>" (`ChainStageLine.tsx`'s own `speechHeading`, `stageHeading(...,  true)`) --
// the SAME visible "·" form every `STAGE*_TITLE` constant already carries, with "·" swapped for
// ", " (the identical transform `stageHeading`'s own `forSpeech` branch applies). Never found at
// all on `origin/main`, where this label is still a plain, non-interactive `<span>`.
function jumpButtonExpr(titleText) {
  const ariaLabel = `Go to ${titleText.replace(' \u00b7 ', ', ')}`;
  return `document.querySelector('[aria-label="Transcript"] button[aria-label="${ariaLabel}"]')`;
}

/** Bounds-based "is this genuinely in the viewport" proof: a real, positive on-screen extent
 * inside the window's own viewport -- not merely present in the DOM, which
 * `message-scroller.tsx`'s own `content-visibility:auto` never removes regardless of scroll
 * position (there is no windowing-library virtualizer in this codebase to defeat). */
function viewportRectExpr(triggerExpr) {
  return `(() => { const el = (${triggerExpr}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, viewportHeight: window.innerHeight }; })()`;
}

function rectIsInViewport(rect) {
  return !!rect && rect.height > 0 && rect.bottom > 0 && rect.top < rect.viewportHeight;
}

// Gate round 1 item 8: a single boolean expression for `cdp.waitFor` to poll -- the jump's own
// smooth scroll (`stageJump.ts`) settles asynchronously, so a one-shot `evaluate` right after the
// click could read a mid-transition rect.
function isInViewportExpr(triggerExpr) {
  return `(() => { const el = (${triggerExpr}); if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; })()`;
}

// Gate round 1 item 8: scrolls ONLY the transcript's own viewport to its own end -- Stage 1/
// Stage 3 sit near the top of this ten-Stage turn, so from the end this is a hard, reproducible
// off-screen baseline for each jump's own "before" assertion, not an assumption about where the
// app happens to leave the scroll position after a turn settles.
function scrollTranscriptToEnd(cdp) {
  return cdp.evaluate(`(() => { const v = document.querySelector('[aria-label="Transcript"]'); if (v) v.scrollTop = v.scrollHeight; })()`);
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let BUILD_OUTPUT_DIR = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1008-stage-label-jump-shots', SHOT_NAMES);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1008-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1008-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1008-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1008-repo-')), 'verify-1008-stage-label-jump');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1008-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1008-launcher-'));
    const port = await getFreePort();

    console.log(`verify-1008: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-1008: shots dir ${SHOTS_DIR}`);
    console.log(`verify-1008: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1008' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-1008: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-941',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1008: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Shim-confirmed check (same pattern as `verify-941-part2.mjs`/`verify-1000-stage-defer.mjs`):
    // without this, a silently-wrong fake-omp shim could still let the whole run "pass" on UI
    // state alone. `exeDir` is freshly `mkdtemp`'d above, so this log can never be a stale one.
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-1008: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(
        `verify-1008: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`
      );
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${sessionA.name}" created in the scratch repo, agent attached (fake omp, stages-941.jsonl scenario -- ten Stages, Stage 5's own FailAgent member genuinely fails).`);

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // ---- Wait for the whole ten-Stage turn to settle; this feature (unlike issue #1000) has
    // no real-time running-state window to catch, so every proof below runs against the final,
    // settled state only. ----
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );

    // ---- Item 2: "Go to Stage N" in the chain row scrolls+opens+focuses the target Stage row,
    // by mouse click (Stage 1) and by keyboard (Stage 3, a real Enter keypress). Both targets
    // are multi-member, fully finished, never otherwise touched by this script, so each starts
    // genuinely CLOSED (no failed/cancelled/exited member) -- a clean baseline. The chain row
    // must be open first for `ChainStageLine`'s own jump buttons to exist in the DOM at all
    // (Stage 5's permanently-failed member keeps the whole turn "unsettled", so the chain row
    // should already default open -- `expandByFinder` is a no-op in that case, and a genuine
    // open-if-needed otherwise). ----
    await expandByFinder(cdp, CHAIN_TRIGGER);

    const stage1TriggerExpr = stageTriggerSelector(STAGE1_TITLE);
    const stage1BeforeExpanded = await cdp.evaluate(`(${stage1TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
    if (stage1BeforeExpanded !== 'false') {
      failures.push(`Stage 1's own row was not closed before the mouse jump proof (aria-expanded was ${JSON.stringify(stage1BeforeExpanded)}, expected "false") -- this script never touches Stage 1 before this point.`);
    } else {
      findings.push('Stage 1 starts genuinely CLOSED (never touched before this point, no failed member) -- a clean baseline for the mouse jump proof.');
    }
    await scrollTranscriptToEnd(cdp);
    const stage1RectBefore = await cdp.evaluate(viewportRectExpr(stage1TriggerExpr));
    if (rectIsInViewport(stage1RectBefore)) {
      failures.push(`Stage 1's own row is already in the viewport after scrolling the transcript to its own end (rect ${JSON.stringify(stage1RectBefore)}) -- the off-screen precondition for the mouse jump proof could not be established.`);
    } else {
      findings.push(`Stage 1's own row starts off-screen (rect ${JSON.stringify(stage1RectBefore)}) -- a clean baseline for the mouse jump proof (gate round 1, item 8).`);
    }
    let stage1JumpFound = false;
    try {
      await cdp.waitFor(`!!(${jumpButtonExpr(STAGE1_TITLE)})`, { timeoutMs: 10_000, label: 'The chain row\'s own "Go to Stage 1" button' });
      stage1JumpFound = true;
      findings.push('The chain row\'s own "Go to Stage 1" button exists (issue #1008 item 2: the Stage label is now a real button, not a plain span).');
    } catch (err) {
      failures.push(`The chain row's own "Go to Stage 1" jump button was never found: ${err.message} -- issue #1008 item 2 regression.`);
    }
    if (stage1JumpFound) {
      await clickScrolled(cdp, jumpButtonExpr(STAGE1_TITLE));
      const stage1AfterExpanded = await cdp.evaluate(`(${stage1TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
      if (stage1AfterExpanded !== 'true') {
        failures.push(`Clicking "Go to Stage 1" did not open Stage 1's own row (aria-expanded is ${JSON.stringify(stage1AfterExpanded)}, expected "true").`);
      } else {
        findings.push('Clicking "Go to Stage 1" opened Stage 1\'s own row.');
      }
      const stage1Focused = await cdp.evaluate(`document.activeElement === (${stage1TriggerExpr})`);
      if (!stage1Focused) {
        failures.push('Clicking "Go to Stage 1" did not move keyboard focus to Stage 1\'s own trigger.');
      } else {
        findings.push('Clicking "Go to Stage 1" moved keyboard focus to Stage 1\'s own trigger.');
      }
      try {
        await cdp.waitFor(isInViewportExpr(stage1TriggerExpr), { timeoutMs: 5_000, label: 'Stage 1 row in the viewport after the mouse jump (smooth scroll settles)' });
        const stage1Rect = await cdp.evaluate(viewportRectExpr(stage1TriggerExpr));
        findings.push(`Stage 1's own row is in the viewport after the jump (rect ${JSON.stringify(stage1Rect)}).`);
      } catch (err) {
        failures.push(`Stage 1's own row never entered the viewport after the jump: ${err.message}`);
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-stage1-jumped-open-focused.png'));

    // ---- Gate round 1 items 1 & 9: toggling "Show tool calls" off genuinely unmounts Stage 1's
    // own row (no bad member -- `rowVisibility` returns 'hidden') and its own jump button
    // disappears; Stage 5 (a failed Stage) stays force-visible regardless. Toggling back on
    // remounts Stage 1, and its manual-open (set by the jump above) must survive the remount
    // (issue #991 persistence) -- a real IPC round trip, not a store mutation. ----
    if (stage1JumpFound) {
      const toolCallsOff = await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('toolCalls', false)`);
      if (!toolCallsOff || toolCallsOff.ok !== true) {
        failures.push(`settings.setTranscriptDisplay('toolCalls', false) failed: ${JSON.stringify(toolCallsOff)}`);
      } else {
        await sleep(300);
        const stage1ButtonGoneWhileHidden = await cdp.evaluate(`!(${jumpButtonExpr(STAGE1_TITLE)})`);
        if (!stage1ButtonGoneWhileHidden) {
          failures.push('The "Go to Stage 1" button is still present with "Show tool calls" off, even though Stage 1 has no failed/cancelled/exited member -- issue #1008 gate round 1 item 1 regression.');
        } else {
          findings.push('The "Go to Stage 1" button disappears with "Show tool calls" off (its own Stage row is genuinely hidden -- issue #1008 gate round 1 item 1 fix confirmed).');
        }
        const stage5ButtonStillThereWhileHidden = await cdp.evaluate(`!!(${jumpButtonExpr(STAGE5_TITLE)})`);
        if (!stage5ButtonStillThereWhileHidden) {
          failures.push('The "Go to Stage 5" button disappeared with "Show tool calls" off, even though Stage 5 has a failed member and must stay force-visible.');
        } else {
          findings.push('The "Go to Stage 5" button stays present with "Show tool calls" off (Stage 5 has a failed member, force-visible regardless of the toggle).');
        }
        const toolCallsOn = await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('toolCalls', true)`);
        if (!toolCallsOn || toolCallsOn.ok !== true) {
          failures.push(`settings.setTranscriptDisplay('toolCalls', true) failed: ${JSON.stringify(toolCallsOn)}`);
        } else {
          await sleep(300);
          const stage1ReappearedExpanded = await cdp.evaluate(`(${stage1TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
          if (stage1ReappearedExpanded !== 'true') {
            failures.push(`Stage 1's own manual-open did not survive the "Show tool calls" off/on remount (aria-expanded is ${JSON.stringify(stage1ReappearedExpanded)}, expected "true") -- issue #991 persistence regression.`);
          } else {
            findings.push("Stage 1's own manual-open (set by the earlier jump) survived a genuine unmount/remount cycle (\"Show tool calls\" off then on) -- issue #991 persistence confirmed (issue #1008 gate round 1, item 9).");
          }
        }
      }
    } else {
      notExercised.push('The "Show tool calls" visibility-gating and #991 persistence-across-remount proof did not run because the "Go to Stage 1" button was never found.');
    }

    const stage3TriggerExpr = stageTriggerSelector(STAGE3_TITLE);
    const stage3BeforeExpanded = await cdp.evaluate(`(${stage3TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
    if (stage3BeforeExpanded !== 'false') {
      failures.push(`Stage 3's own row was not closed before the keyboard jump proof (aria-expanded was ${JSON.stringify(stage3BeforeExpanded)}, expected "false") -- this script never touches Stage 3 before this point.`);
    } else {
      findings.push('Stage 3 starts genuinely CLOSED (never touched before this point, no failed member) -- a clean baseline for the keyboard jump proof.');
    }
    await scrollTranscriptToEnd(cdp);
    const stage3RectBefore = await cdp.evaluate(viewportRectExpr(stage3TriggerExpr));
    if (rectIsInViewport(stage3RectBefore)) {
      failures.push(`Stage 3's own row is already in the viewport after scrolling the transcript to its own end (rect ${JSON.stringify(stage3RectBefore)}) -- the off-screen precondition for the keyboard jump proof could not be established.`);
    } else {
      findings.push(`Stage 3's own row starts off-screen (rect ${JSON.stringify(stage3RectBefore)}) -- a clean baseline for the keyboard jump proof (gate round 1, item 8).`);
    }
    let stage3JumpFound = false;
    try {
      await cdp.waitFor(`!!(${jumpButtonExpr(STAGE3_TITLE)})`, { timeoutMs: 10_000, label: 'The chain row\'s own "Go to Stage 3" button' });
      stage3JumpFound = true;
      findings.push('The chain row\'s own "Go to Stage 3" button exists.');
    } catch (err) {
      failures.push(`The chain row's own "Go to Stage 3" jump button was never found: ${err.message} -- issue #1008 item 2 regression.`);
    }
    if (stage3JumpFound) {
      // Keyboard path (distinct from Stage 1's mouse click above): focus the jump button itself
      // directly (proving it is keyboard-reachable), then a REAL Enter keypress -- a native
      // `<button>` needs no special key handling to activate on Enter, so this also proves
      // `jumpToStage` was wired through `onClick`, not a click-only handler.
      await cdp.evaluate(`(() => { const el = (${jumpButtonExpr(STAGE3_TITLE)}); if (el) el.scrollIntoView({ block: 'center' }); })()`);
      await cdp.evaluate(`(${jumpButtonExpr(STAGE3_TITLE)})?.focus()`);
      const stage3ButtonFocused = await cdp.evaluate(`document.activeElement === (${jumpButtonExpr(STAGE3_TITLE)})`);
      if (!stage3ButtonFocused) {
        failures.push('Could not place keyboard focus on the "Go to Stage 3" button itself before pressing Enter.');
      } else {
        findings.push('Keyboard focus placed on the "Go to Stage 3" button itself (keyboard-reachable, issue #1008 item 2).');
        await pressKey(cdp, 13, 'Enter', 'Enter');
        const stage3AfterExpanded = await cdp.evaluate(`(${stage3TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
        if (stage3AfterExpanded !== 'true') {
          failures.push(`Pressing Enter on "Go to Stage 3" did not open Stage 3's own row (aria-expanded is ${JSON.stringify(stage3AfterExpanded)}, expected "true").`);
        } else {
          findings.push('Pressing Enter on "Go to Stage 3" opened Stage 3\'s own row (native <button> Enter activation, the same onClick handler as a mouse click).');
        }
        const stage3Focused = await cdp.evaluate(`document.activeElement === (${stage3TriggerExpr})`);
        if (!stage3Focused) {
          failures.push('Pressing Enter on "Go to Stage 3" did not move keyboard focus to Stage 3\'s own trigger.');
        } else {
          findings.push('Pressing Enter on "Go to Stage 3" moved keyboard focus to Stage 3\'s own trigger.');
        }
        try {
          await cdp.waitFor(isInViewportExpr(stage3TriggerExpr), { timeoutMs: 5_000, label: 'Stage 3 row in the viewport after the keyboard jump (smooth scroll settles)' });
          const stage3Rect = await cdp.evaluate(viewportRectExpr(stage3TriggerExpr));
          findings.push(`Stage 3's own row is in the viewport after the keyboard jump (rect ${JSON.stringify(stage3Rect)}).`);
        } catch (err) {
          failures.push(`Stage 3's own row never entered the viewport after the keyboard jump: ${err.message}`);
        }
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-stage3-jumped-via-keyboard.png'));

    // ---- Item 1/gate round 1 item 7: re-resolve --severity-error/--severity-success INSIDE the
    // theme loop, after each switchTheme -- a theme preset's own resolved value is never assumed
    // to carry over from an earlier pass. Checks both the in-place Stage label (StageGroupRow)
    // and the chain row's own "Go to Stage 5" button text, in all 3 themes. ----
    const labelColorExpr = (titleText) => `(() => { const el = (${titleSelector(titleText)}); return el ? getComputedStyle(el).color : null; })()`;
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const expectedErrorColor = await resolveCssVarColor(cdp, '--severity-error', 'color');
      const expectedSuccessColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
      const stage5LabelColor = await cdp.evaluate(labelColorExpr(STAGE5_TITLE));
      if (stage5LabelColor !== expectedErrorColor) {
        failures.push(`[${theme.name}] Stage 5's own label (one FailAgent member failed) is ${JSON.stringify(stage5LabelColor)}, expected the theme's resolved --severity-error (${JSON.stringify(expectedErrorColor)}) -- issue #1008 item 1 regression.`);
      } else {
        findings.push(`[${theme.name}] Stage 5's own label (failed) resolves to --severity-error (${expectedErrorColor}).`);
      }
      const stage1LabelColor = await cdp.evaluate(labelColorExpr(STAGE1_TITLE));
      if (stage1LabelColor !== expectedSuccessColor) {
        failures.push(`[${theme.name}] Stage 1's own label (fully finished) is ${JSON.stringify(stage1LabelColor)}, expected the theme's resolved --severity-success (${JSON.stringify(expectedSuccessColor)}).`);
      } else {
        findings.push(`[${theme.name}] Stage 1's own label (fully finished) resolves to --severity-success (${expectedSuccessColor}).`);
      }
      const chainStage5ButtonColor = await cdp.evaluate(`(() => { const el = (${jumpButtonExpr(STAGE5_TITLE)}); return el ? getComputedStyle(el).color : null; })()`);
      if (chainStage5ButtonColor !== expectedErrorColor) {
        failures.push(`[${theme.name}] The chain row's own "Go to Stage 5" button text is ${JSON.stringify(chainStage5ButtonColor)}, expected --severity-error (${JSON.stringify(expectedErrorColor)}).`);
      } else {
        findings.push(`[${theme.name}] The chain row's own "Go to Stage 5" button text resolves to --severity-error.`);
      }
      const shotName = `1008-stage-label-jump-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push("prefers-reduced-motion is not emulated by this CDP session, so jumpToStage's own instant-jump branch (vs the smooth scroll exercised above) is never exercised by this script.");

    const verdict = failures.length > 0 ? 'FAILED' : 'DONE';
    const exitCode = failures.length > 0 ? 1 : 0;
    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      verdict,
      exitCode
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-1008: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1008: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1008: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1008: ${verdict}.`);
    process.exitCode = exitCode;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-1008: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-1008: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-1008: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-1008: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-1008: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
