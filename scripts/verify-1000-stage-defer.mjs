#!/usr/bin/env node
// Live CDP check for issue #1000 (UI polish: Stage rows defer running auto-open to the chain
// row once a turn has two or more Stages; FR-086, amends FR-067). ui-architect-v3 ruling at
// PR #999's own gate, recorded on #1000 and in research.md decision 21: once a turn has two or
// more Stages, a Stage row's own `running` state no longer auto-opens it by itself -- only
// `failed`/`cancelled`/`exited` still do, so a turn's running agents are no longer shown
// expanded TWICE over (once in the Stage row in place, once again in the per-turn Subagent
// chain row at the end of the turn). A turn with only one Stage so far (the second has not
// started streaming) keeps today's single-Stage running auto-open; #991's own upward-only
// disclosure rule is unchanged and still governs every row here (`StageGroupRow`'s own
// `isOpenByDefault`/`useStickyDisclosure`, `SubagentChainRow.tsx`).
//
// Reuses the recorded-frame fake `omp` harness and the SAME `stages-941.jsonl` fixture and
// `verify-941-stage-naming-helpers.mjs` STAGE*_TITLE/titleSelector/stageContentSelector/
// stageTriggerSelector exports every `verify-941-*`/`verify-991-*` script already shares
// (AGENTS.md: no new fixtures). The fixture already carried one additive `{"__delay__": 1500}`
// after Stage 1's own assistant-message echo (issue #991); this issue adds a SECOND, identical
// additive delay after Stage 2's own echo (Main-approved 2026-10-18, fixture's own header has
// the full note) -- the only window in this fixture where a Stage is genuinely, observably
// running WHILE the turn already has two or more Stages (Stage 1, settled; Stage 2, running).
// Without that second delay, Stage 2 (and every other non-Stage-1 Stage here) arrives unpaced,
// inside the renderer's own 50ms patch-batching window, so whether it was ever observably
// running before settling is not reliably reproducible (the same reason Stage 2/7's own
// expand-cycle checks in `verify-941-stage-naming-expand-helpers.mjs` accept either boolean).
//
// Five things proved, in this order (each needs the state the previous one left, so they run
// once, not per theme -- a theme pass takes a screenshot only, at the very end):
//   1. While Stage 2 is genuinely still running (the additive delay window) and this turn
//      already has two Stages, Stage 2's own trigger is CLOSED (`aria-expanded="false"`) --
//      the CORE discriminator. MUST fail on `origin/main`: there, `isOpenByDefault` auto-opens
//      any multi-agent Stage whenever it is running, with no Stage-count exception, so Stage 2
//      would read "true" here. Read from the trigger's own `aria-label`, never the collapsible
//      content (Radix does not render it while closed -- see `stageIsRunningExpr` below).
//      Stage 1 (auto-opened earlier while it was this turn's ONLY Stage) stays open throughout
//      (`aria-expanded="true"`) -- upward-only, unaffected by the turn later growing past it;
//      true on both `origin/main` and the fix (not itself a red/green discriminator), included
//      to prove "nothing closes itself" holds across the transition. If this window is ever
//      missed (the additive delay already elapsed), the run is NOT allowed to claim DONE/exit
//      0 -- see the NOT-PROVEN verdict at the bottom of `main()`.
//   2. The per-turn Subagent chain row is already rendered (`stages.length >= 2`) and OPEN
//      (`isUnsettled`, Stage 2 still running), its own visible summary naming "2 stages" and
//      the live "Running" word -- the chain row carries the live overview while a Stage itself
//      stays collapsed, exactly the behaviour #1000 asks for. A screenshot is taken
//      immediately after this point, BEFORE anything below ever touches Stage 2 by hand, so it
//      genuinely shows the closed-while-running state.
//   3. Once the whole ten-Stage turn settles: Stage 3 (two agents, Zeta/Omega, both finished,
//      and NEVER touched anywhere in this script) stays CLOSED (`aria-expanded="false"`) --
//      the clean "settled and never touched stays closed" proof, on a Stage this run never
//      manually opens (unlike Stage 2, used below for the manual-open/focus proof instead, so
//      its own post-settle state is no longer a "never touched" witness). MUST fail on
//      `origin/main` (reads "true" there: once observed running at all -- even inside the
//      renderer's own unpaced 50ms patch-batching window, which this fixture cannot
//      deterministically land Stage 3 inside, so this is a STRUCTURAL guarantee from the code
//      path, not a timing-dependent repro -- `useStickyDisclosure`'s own upward-only latch
//      commits it permanently open, the exact duplicate-expansion bug #1000 reports). Stage 5
//      (its own FailAgent member failed) is OPEN (`aria-expanded="true"`) -- the one exception
//      the new rule keeps, auto-opening regardless of Stage count.
//   4. A user's OWN manual expand on Stage 2 (exempted from auto-open by the new rule, but
//      never exempt from the user's own choice) survives it settling and the rest of the turn
//      streaming in behind it -- keyboard focus placed inside Stage 2's own content while it is
//      still genuinely running stays there once settled, never dropping to `<body>` (WCAG
//      2.4.3, the same guarantee #991 proved for auto-opened Stage 1, now re-proved for a
//      manually-opened, auto-open-exempted Stage).
//   5. (Code-level, not independently exercised by this fixture) `StageGroupRow`'s own
//      `isOpenByDefault` reads `hasBadMember` -- the raw failed/cancelled/exited COUNTS, not
//      the Stage's own overall `status` -- so a Stage opens the instant any ONE member goes
//      bad, even while a sibling member is still running, rather than waiting for the whole
//      Stage to settle (Decided, Skippy, delegated by Stuart, UI architect's suggested fix).
//      This fixture's own Stage 5 settles both members in a single frame with no live split,
//      so it cannot discriminate this specific timing on its own; recorded here for the code
//      review trail, not claimed as a live-proven item.
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus a real `import()` load-check are the only commands that have actually been run against
// this file. Every DOM/class-name selector reused here was already grep-verified by the
// `verify-941-*`/`verify-991-*` scripts that share them; the one new finder expression (the
// Story559 member trigger scoped to Stage 2's own content) is built the same, already-proven way
// (`g923CodeTriggerExpr` in `verify-991-stage-focus.mjs`).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath } from './verify-tauri-cdp.mjs';
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
  stageContentSelector,
  stageTriggerSelector,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE5_TITLE
} from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the full ten-stage batch (issue #1000 live check: multi-Stage running auto-open deferred to the chain row).';
const SHOTS_DIR =
  process.env.REFRACT_1000_SHOTS_DIR || path.join(tmpdir(), `refract-1000-stage-defer-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-stage2-running-chain-open-stage2-closed.png',
  '02-stage2-manually-opened-focus-inside.png',
  '03-all-stages-settled.png',
  '1000-stage-defer-dark.png',
  '1000-stage-defer-obsidian.png',
  '1000-stage-defer-dark-high-contrast.png',
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
// never duplicated elsewhere -- same constant every `verify-941-*`/`verify-991-*` script shares.
const CHAIN_TRIGGER = `document.querySelector('[title="Subagents"]')?.closest('[data-slot="collapsible-trigger"]')`;

// Gate round 1 fix (issue #1000, item 1, Critical, code-reviewer/test-reviewer): "is this Stage
// genuinely running" must be read from the TRIGGER's own `aria-label` (built at
// `SubagentChainRow.tsx`'s `triggerAriaLabel`, which states the live status word while
// running), never from the collapsible CONTENT -- Radix does not render `CollapsibleContent`
// at all while a row is closed, and under this fix Stage 2 stays CLOSED while running (that is
// the very behaviour under test), so a content-based check could never see it and would
// silently time out, masking the whole discriminating proof. The trigger itself always
// renders, open or closed, so this is reliable in both states.
function stageIsRunningExpr(titleText) {
  return `((${stageTriggerSelector(titleText)})?.getAttribute('aria-label') ?? '').includes('Running')`;
}

function story559Stage2TriggerExpr() {
  return `(${stageContentSelector(STAGE2_TITLE)})?.querySelector('[title="Story559"]')?.closest('[data-slot="collapsible-trigger"]')`;
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
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1000-stage-defer-shots', SHOT_NAMES);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1000-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1000-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1000-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1000-repo-')), 'verify-1000-stage-defer');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1000-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1000-launcher-'));
    const port = await getFreePort();

    console.log(`verify-1000: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-1000: shots dir ${SHOTS_DIR}`);
    console.log(`verify-1000: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1000' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-1000: built exe copied to ${exePath}`);

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
      throw new Error(`verify-1000: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Shim-confirmed check (same pattern as `verify-941-part2.mjs`/`verify-991-stage-focus.mjs`):
    // without this, a silently-wrong fake-omp shim (a stale PATH entry shadowing it, or the shim
    // crashing before its first `debugLog` call) could still let the whole run "pass" on UI
    // state alone. `exeDir` is freshly `mkdtemp`'d above, so this log can never be a stale one
    // left over from an earlier run (fresh-log guard).
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-1000: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(
        `verify-1000: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`
      );
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${sessionA.name}" created in the scratch repo, agent attached (fake omp, stages-941.jsonl scenario, additively delayed after Stage 1 AND Stage 2 for this check).`);

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // ---- Phase 1: Stage 1 settles and stays open (single-Stage-so-far auto-open, unaffected
    // by #1000) before Stage 2 ever starts; wait past it so Phase 2 begins from a clean,
    // known state (Stage 1 done, Stage 2 about to start). ----
    await cdp.waitFor(
      `(() => { const c = (${stageContentSelector(STAGE1_TITLE)}); return !!c && !c.textContent.includes('Running'); })()`,
      { timeoutMs: 15_000, label: 'Stage 1 settled (its own additive delay window closed)' }
    );
    const stage1TriggerBeforeStage2 = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage1TriggerBeforeStage2 !== 'true') {
      failures.push(`Stage 1 was not open once settled (aria-expanded was ${JSON.stringify(stage1TriggerBeforeStage2)}, expected "true") -- its own single-Stage-so-far auto-open (unaffected by #1000) or #991's upward-only rule regressed.`);
    } else {
      findings.push('Stage 1 settled and stayed open (single-Stage-so-far auto-open, #991 upward-only) before Stage 2 ever started.');
    }

    // ---- Phase 2: Stage 2 is genuinely running WHILE this turn already has two Stages (the
    // second additive delay window) -- Stage 2 itself stays CLOSED, the chain row is already
    // open and shows the live overview, and Stage 1 (opened earlier) has not closed itself
    // (issue #1000, FR-086). "Running" is read from the TRIGGER's own `aria-label`
    // (`stageIsRunningExpr`), never the collapsible content -- Radix does not render content at
    // all while Stage 2 stays closed, which is exactly the state under test (gate round 1 fix,
    // item 1, Critical). ----
    let phase2Exercised = true;
    try {
      await cdp.waitFor(stageIsRunningExpr(STAGE2_TITLE), {
        timeoutMs: 15_000,
        label: 'Stage 2 genuinely running (second additive fixture delay window)'
      });
    } catch (err) {
      phase2Exercised = false;
      notExercised.push(`Stage 2 never showed as genuinely running within the 15s window -- the additive fixture delay may have already elapsed, or the turn settled unusually fast; the defer-auto-open proof (issue #1000) could not run as designed this pass (${err.message}).`);
    }
    if (phase2Exercised) {
      const stage2TriggerWhileRunning = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      const stillRunning = await cdp.evaluate(stageIsRunningExpr(STAGE2_TITLE));
      if (!stillRunning) {
        phase2Exercised = false;
        notExercised.push('Stage 2 settled before its own auto-open state could be confirmed while still genuinely running -- the additive 1.5s delay window closed before this check landed; the defer-auto-open proof (issue #1000) did not run as designed this pass.');
      } else if (stage2TriggerWhileRunning !== 'false') {
        failures.push(`Stage 2 auto-opened while running even though this turn already has two Stages (aria-expanded was ${JSON.stringify(stage2TriggerWhileRunning)}, expected "false") -- issue #1000 (FR-086) regression: a multi-Stage turn's own running Stage must defer to the chain row, not auto-open itself.`);
      } else {
        findings.push('Stage 2 stayed CLOSED while genuinely running, with this turn already at two Stages -- issue #1000 (FR-086) fix confirmed.');
      }

      const chainState = await cdp.evaluate(`(() => {
        const trigger = (${CHAIN_TRIGGER});
        return {
          present: !!trigger,
          expanded: trigger?.getAttribute('aria-expanded') ?? null,
          text: trigger?.textContent ?? ''
        };
      })()`);
      if (!chainState.present) {
        failures.push('The per-turn Subagent chain row is not rendered while Stage 2 is running and this turn already has two Stages -- it should already carry the live overview (issue #1000).');
      } else if (chainState.expanded !== 'true') {
        failures.push(`The Subagent chain row is not open while Stage 2 is still running (aria-expanded was ${JSON.stringify(chainState.expanded)}, expected "true") -- it should default open while anything is unsettled.`);
      } else if (!chainState.text.includes('2 stages') || !chainState.text.includes('Running')) {
        failures.push(`The Subagent chain row's own visible text does not show the live "2 stages"/"Running" overview while Stage 2 runs: ${JSON.stringify(chainState.text)}.`);
      } else {
        findings.push('The Subagent chain row is open and shows the live "2 stages"/"Running" overview while Stage 2 itself stays collapsed -- the chain row carries the live overview, as issue #1000 asks for.');
      }

      const stage1TriggerWhileStage2Running = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      if (stage1TriggerWhileStage2Running !== 'true') {
        failures.push(`Stage 1 (auto-opened earlier while it was this turn's only Stage) closed itself once Stage 2 reclassified the turn as multi-Stage (aria-expanded is now ${JSON.stringify(stage1TriggerWhileStage2Running)}) -- no row may ever close itself (#991 upward-only).`);
      } else {
        findings.push("Stage 1 stayed open once this turn grew to two Stages -- #991's own upward-only latch holds regardless of the later Stage-count reclassification, confirming nothing closes itself.");
      }

      // Gate round 1 fix (issue #1000, item 3, Medium): this screenshot is taken HERE, right
      // after the closed-while-running checks above and BEFORE `expandByFinder` below ever
      // touches Stage 2 by hand -- previously taken after the manual open, so it could never
      // actually show the closed state it claims to.
      await cdp.screenshot(path.join(SHOTS_DIR, '01-stage2-running-chain-open-stage2-closed.png'));

      // ---- Manual-open proof: a user's own choice on an auto-open-exempt Stage still opens
      // it, and that choice -- plus keyboard focus placed inside it -- survives Stage 2
      // settling and the remaining Stages streaming in behind it (WCAG 2.4.3). ----
      await expandByFinder(cdp, stageTriggerSelector(STAGE2_TITLE));
      const stage2TriggerAfterManualOpen = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      const stillRunningAfterManualOpen = await cdp.evaluate(stageIsRunningExpr(STAGE2_TITLE));
      if (stage2TriggerAfterManualOpen !== 'true') {
        failures.push(`Manually clicking Stage 2's own trigger did not open it (aria-expanded is ${JSON.stringify(stage2TriggerAfterManualOpen)}, expected "true") -- a user's own choice must still open an auto-open-exempt Stage.`);
      } else if (!stillRunningAfterManualOpen) {
        notExercised.push('Stage 2 settled before the manual-open-plus-focus check could place focus while it was still genuinely running; the keyboard-focus-survives-settling proof did not run as designed this pass.');
      } else {
        await cdp.evaluate(`(${story559Stage2TriggerExpr()})?.focus()`);
        const focusedInStage2 = await cdp.evaluate(`document.activeElement === (${story559Stage2TriggerExpr()})`);
        if (!focusedInStage2) {
          failures.push("Could not place keyboard focus on Stage 2's own Story559 member row trigger while Stage 2 was still genuinely running.");
        } else {
          findings.push("Keyboard focus placed on Stage 2's own Story559 member row trigger, inside Stage 2's own manually-opened content, while Stage 2 was still genuinely running.");
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '02-stage2-manually-opened-focus-inside.png'));
    } else {
      // Gate round 1 fix (issue #1000, item 3): still capture both named shots even on the
      // not-exercised path, so `clearKnownOutputFiles`'s own known-file list stays accurate and
      // a missing file is never mistaken for a tool crash.
      await cdp.screenshot(path.join(SHOTS_DIR, '01-stage2-running-chain-open-stage2-closed.png'));
      await cdp.screenshot(path.join(SHOTS_DIR, '02-stage2-manually-opened-focus-inside.png'));
    }

    // ---- Phase 3: once the whole ten-Stage turn settles: Stage 2 (manually opened above)
    // stays open with focus preserved (never drops to <body>); Stage 3 (two agents, Zeta/
    // Omega, never touched by this script) stays CLOSED -- the clean "settled and never
    // touched stays closed" proof, since Stage 2 itself is no longer a "never touched" witness
    // once manually opened above; Stage 5 (its own FailAgent member failed) is open regardless
    // of Stage count (issue #1000's one kept exception) ----
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '03-all-stages-settled.png'));

    const stage2TriggerAfterSettle = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage2TriggerAfterSettle !== 'true') {
      failures.push(`Stage 2's own manual open did not survive it settling and the rest of the turn streaming in behind it (aria-expanded is now ${JSON.stringify(stage2TriggerAfterSettle)}, expected "true") -- #991's own upward-only rule regressed for an auto-open-exempt Stage.`);
    } else {
      findings.push("Stage 2's own manual open survived it settling all-success and every later Stage streaming in -- #991's own upward-only rule, confirmed for an issue #1000 auto-open-exempt Stage.");
    }
    if (phase2Exercised) {
      const activeAfterSettle = await cdp.evaluate(`(() => {
        const active = document.activeElement;
        const expected = (${story559Stage2TriggerExpr()});
        return { isExpected: active === expected, isBody: active === document.body, tag: active?.tagName ?? null };
      })()`);
      if (activeAfterSettle.isBody) {
        failures.push('Keyboard focus fell to <body> once Stage 2 settled -- WCAG 2.4.3 regression on a manually-opened, auto-open-exempt Stage.');
      } else if (!activeAfterSettle.isExpected) {
        failures.push(`Keyboard focus moved away from Stage 2's own Story559 member trigger once it settled (now a ${activeAfterSettle.tag ?? 'null'} element), expected it to stay put.`);
      } else {
        findings.push("Keyboard focus stayed on Stage 2's own Story559 member row trigger after Stage 2 settled and every later Stage streamed in -- never dropped to <body> (WCAG 2.4.3, issue #1000 fix confirmed for a manually-opened Stage).");
      }
    }

    const stage3Trigger = await cdp.evaluate(`(${stageTriggerSelector(STAGE3_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage3Trigger !== 'false') {
      failures.push(`Stage 3 (two agents, never failed, never manually touched by this script) is not closed once settled (aria-expanded was ${JSON.stringify(stage3Trigger)}, expected "false") -- issue #1000 (FR-086) regression: it never had any failed/cancelled/exited member, so it should never have auto-opened at all, in a multi-Stage turn.`);
    } else {
      findings.push('Stage 3 (two agents, never failed, never manually touched) stayed closed through the whole settled turn -- the clean "settled and never touched stays closed" proof, confirming it never auto-opened at all (issue #1000, FR-086).');
    }

    const stage5Trigger = await cdp.evaluate(`(${stageTriggerSelector(STAGE5_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage5Trigger !== 'true') {
      failures.push(`Stage 5 (its own FailAgent member failed) is not open once settled (aria-expanded was ${JSON.stringify(stage5Trigger)}, expected "true") -- issue #1000's own kept exception (failed/cancelled/exited still auto-open regardless of Stage count) regressed.`);
    } else {
      findings.push("Stage 5's own failed member still auto-opens it, even though this turn has far more than two Stages -- issue #1000's kept exception confirmed.");
    }

    const stage1TriggerAfterFullSettle = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage1TriggerAfterFullSettle !== 'true') {
      failures.push(`Stage 1 closed itself by the time the whole ten-Stage turn settled (aria-expanded is now ${JSON.stringify(stage1TriggerAfterFullSettle)}) -- no row may ever close itself (#991 upward-only), regardless of this turn later growing to ten Stages.`);
    } else {
      findings.push("Stage 1 stayed open through the whole ten-Stage turn settling -- #991's own upward-only latch holds for the entire turn's own lifetime, confirming nothing closes itself.");
    }

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const shotName = `1000-stage-defer-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}) -- no colour-dependent assertion in this check, every proof above is structural (aria-expanded, document.activeElement, visible text).`);
    }

    // Gate round 1 fix (issue #1000, item 2, Medium): the defer-auto-open discriminator
    // (Phase 2's closed-while-running check) is the ONE proof that actually distinguishes this
    // fix from `origin/main` -- if the additive delay window was missed (`!phase2Exercised`),
    // this run must NEVER claim DONE/exit 0, since nothing here has genuinely proven the fix;
    // it gets its own distinct NOT-PROVEN verdict and exit code (2), separate from a real
    // FAILED (1) or a true DONE (0).
    const verdict = failures.length > 0 ? 'FAILED' : !phase2Exercised ? 'NOT PROVEN (critical check skipped)' : 'DONE';
    const exitCode = failures.length > 0 ? 1 : !phase2Exercised ? 2 : 0;
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
    console.log('\n=== verify-1000: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1000: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1000: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1000: ${verdict}.`);
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
    console.error('verify-1000: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-1000: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-1000: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-1000: could not preserve logs:', err.message);
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
  console.error('verify-1000: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
