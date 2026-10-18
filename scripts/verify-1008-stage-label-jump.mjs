#!/usr/bin/env node
// Live CDP check for issue #1008 (UI polish: Stage rows -- failed Stage label colour and jump to
// Stage from the chain row). Both items already Decided (Skippy, delegated by Stuart
// 2026-10-18) on the issue.
//
// Item 1: a failed Stage's own label now gets `text-severity-error` the same way a failed tool
// row's label already does (`ToolRow.tsx` :209/:405) -- `SubagentChainRow.tsx`'s `StageGroupRow`
// and `ChainStageLine` both read the new shared `subagentStatus.tsx`'s `subagentStatusTextClass`.
// Item 2: each "Stage N" label in the chain row (`ChainStageLine`) is now a real `<button>`
// ("Go to Stage N") that scrolls its own Stage row into view, opens it through the SAME
// persisted path `useStickyDisclosure` reads (`useStageToggleStore`, issue #991 -- so a jump
// counts as the user's own manual open), and moves focus to the Stage's own trigger
// (`SubagentChainRow.tsx`'s `jumpToStage`, split out to `stageJump.ts` for the #806 file-size cap).
//
// Reuses the recorded-frame fake `omp` harness and the SAME `stages-941.jsonl` fixture (scenario
// `stages-941`) every `verify-941-*`/`verify-991-*`/`verify-1000-*` script already shares
// (AGENTS.md: no new fixtures) -- it already carries a genuinely failed Stage (Stage 5, one
// FailAgent member) among ten Stages, so the turn already satisfies "2+ Stages where one fails"
// with no fixture change needed.
//
// Two Stages used as independent jump targets -- both multi-member, fully finished, and never
// otherwise touched by this script, so each starts genuinely CLOSED (no failed/cancelled/exited
// member, issue #1000's multi-Stage auto-open rule) and off-screen (the chain row renders at the
// very END of a ten-Stage turn, these Stages render near the top): Stage 1 (mouse click) and
// Stage 3 (keyboard: focus its own jump button directly, then a real Enter keypress -- native
// <button> Enter activation needs no special-casing in `jumpToStage` itself).
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus a real `import()` load-check (with `CARGO_TARGET_DIR` unset, per the build-slot guard)
// are the only commands that have actually been run against this file. Every DOM/class-name
// selector reused here (`stageTriggerSelector`, `titleSelector`, the chain row's own
// `[title="Subagents"]` trigger finder) was already grep-verified by the `verify-941-*`/
// `verify-1000-*` scripts that share them; the one new finder expression (`jumpButtonExpr`, the
// chain row's own "Go to Stage N" button by its accessible name) is built the same way.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath, resolveCssVarColor } from './verify-tauri-cdp.mjs';
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

// Issue #1008 item 2: the new "Go to Stage N" jump button, found by its own accessible name
// (`aria-label`, `SubagentChainRow.tsx`'s `ChainStageLine`) -- never found at all on
// `origin/main`, where this label is still a plain, non-interactive `<span>`.
function jumpButtonExpr(stageNumber) {
  return `document.querySelector('[aria-label="Transcript"] button[aria-label="Go to Stage ${stageNumber}"]')`;
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

    // ---- Item 1: a failed Stage's own label matches the resolved --severity-error token; a
    // done Stage's own label does not. Read straight off the always-mounted trigger's own label
    // SPAN (never inside `CollapsibleContent`, so no expand is needed here), the same selector
    // `verify-941-stage-naming-helpers.mjs`'s own `assertGreenFinished` already uses for the
    // green half of this exact rule. ----
    const expectedErrorColor = await resolveCssVarColor(cdp, '--severity-error', 'color');
    const labelColorExpr = (titleText) => `(() => { const el = (${titleSelector(titleText)}); return el ? getComputedStyle(el).color : null; })()`;
    const stage5LabelColor = await cdp.evaluate(labelColorExpr(STAGE5_TITLE));
    if (stage5LabelColor !== expectedErrorColor) {
      failures.push(`Stage 5's own label (one FailAgent member failed) is ${JSON.stringify(stage5LabelColor)}, expected the theme's resolved --severity-error (${JSON.stringify(expectedErrorColor)}) -- issue #1008 item 1 regression.`);
    } else {
      findings.push(`Stage 5's own label (failed) resolves to --severity-error (${expectedErrorColor}), matching ToolRow.tsx's own failed-call label (issue #1008 item 1).`);
    }
    const stage1LabelColor = await cdp.evaluate(labelColorExpr(STAGE1_TITLE));
    if (stage1LabelColor === expectedErrorColor) {
      failures.push(`Stage 1's own label (fully finished, no failed member) is ${JSON.stringify(stage1LabelColor)}, the SAME as the theme's resolved --severity-error -- a done Stage must never read as failed.`);
    } else {
      findings.push(`Stage 1's own label (fully finished) does NOT resolve to --severity-error (is ${JSON.stringify(stage1LabelColor)}, error is ${expectedErrorColor}) -- a done Stage stays its own colour, never the failed one.`);
    }

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
    let stage1JumpFound = false;
    try {
      await cdp.waitFor(`!!(${jumpButtonExpr(1)})`, { timeoutMs: 10_000, label: 'The chain row\'s own "Go to Stage 1" button' });
      stage1JumpFound = true;
      findings.push('The chain row\'s own "Go to Stage 1" button exists (issue #1008 item 2: the Stage label is now a real button, not a plain span).');
    } catch (err) {
      failures.push(`The chain row's own "Go to Stage 1" jump button was never found: ${err.message} -- issue #1008 item 2 regression.`);
    }
    if (stage1JumpFound) {
      await clickScrolled(cdp, jumpButtonExpr(1));
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
      const stage1Rect = await cdp.evaluate(viewportRectExpr(stage1TriggerExpr));
      if (!rectIsInViewport(stage1Rect)) {
        failures.push(`Stage 1's own row is not in the viewport after the jump (rect ${JSON.stringify(stage1Rect)}).`);
      } else {
        findings.push(`Stage 1's own row is in the viewport after the jump (rect ${JSON.stringify(stage1Rect)}).`);
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-stage1-jumped-open-focused.png'));

    const stage3TriggerExpr = stageTriggerSelector(STAGE3_TITLE);
    const stage3BeforeExpanded = await cdp.evaluate(`(${stage3TriggerExpr})?.getAttribute('aria-expanded') ?? null`);
    if (stage3BeforeExpanded !== 'false') {
      failures.push(`Stage 3's own row was not closed before the keyboard jump proof (aria-expanded was ${JSON.stringify(stage3BeforeExpanded)}, expected "false") -- this script never touches Stage 3 before this point.`);
    } else {
      findings.push('Stage 3 starts genuinely CLOSED (never touched before this point, no failed member) -- a clean baseline for the keyboard jump proof.');
    }
    let stage3JumpFound = false;
    try {
      await cdp.waitFor(`!!(${jumpButtonExpr(3)})`, { timeoutMs: 10_000, label: 'The chain row\'s own "Go to Stage 3" button' });
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
      await cdp.evaluate(`(() => { const el = (${jumpButtonExpr(3)}); if (el) el.scrollIntoView({ block: 'center' }); })()`);
      await cdp.evaluate(`(${jumpButtonExpr(3)})?.focus()`);
      const stage3ButtonFocused = await cdp.evaluate(`document.activeElement === (${jumpButtonExpr(3)})`);
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
        const stage3Rect = await cdp.evaluate(viewportRectExpr(stage3TriggerExpr));
        if (!rectIsInViewport(stage3Rect)) {
          failures.push(`Stage 3's own row is not in the viewport after the keyboard jump (rect ${JSON.stringify(stage3Rect)}).`);
        } else {
          findings.push(`Stage 3's own row is in the viewport after the keyboard jump (rect ${JSON.stringify(stage3Rect)}).`);
        }
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-stage3-jumped-via-keyboard.png'));

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const shotName = `1008-stage-label-jump-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}).`);
    }

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
