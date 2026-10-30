#!/usr/bin/env node
// Live CDP check: once a turn has two or more Stages, a running Stage stays closed (the chain row
// shows the live overview) while failed/cancelled/exited Stages still auto-open, and a manual open
// plus focus survive settling. Needs the fixture's additive delay window; if it is missed the run
// reports NOT PROVEN (exit 2), never DONE.

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

// Always the literal "Subagents" (`SubagentChainRow.tsx`).
const CHAIN_TRIGGER = `document.querySelector('[title="Subagents"]')?.closest('[data-slot="collapsible-trigger"]')`;

// Read "running" from the trigger's aria-label: Radix does not render closed content, and Stage 2
// is deliberately closed while running.
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

    // Guards against a silently-wrong fake-omp shim; `exeDir` is fresh, so the log can't be stale.
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

    // Phase 1: wait for Stage 1 to settle so Phase 2 starts from a known state.
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

    // Phase 2: Stage 2 runs while the turn already has two Stages; it must stay closed.
    let phase2Exercised = true;
    let manuallyOpened = false;
    let focusPlaced = false;
    try {
      await cdp.waitFor(stageIsRunningExpr(STAGE2_TITLE), {
        timeoutMs: 15_000,
        label: 'Stage 2 genuinely running (second additive fixture delay window)'
      });
    } catch (err) {
      phase2Exercised = false;
      notExercised.push(`Stage 2 never showed as genuinely running within the 15s window -- the additive fixture delay may have already elapsed, or the turn settled unusually fast; the defer-auto-open proof (issue #1000) could not run as designed this pass (${err.message}).`);
    }
    // A missed window must stop Phase 2 (NOT PROVEN), not run the checks against a settled Stage.
    if (phase2Exercised) {
      const stillRunning = await cdp.evaluate(stageIsRunningExpr(STAGE2_TITLE));
      if (!stillRunning) {
        phase2Exercised = false;
        notExercised.push('Stage 2 settled before its own auto-open state could be confirmed while still genuinely running -- the additive 1.5s delay window closed before this check landed; the defer-auto-open proof (issue #1000) did not run as designed this pass.');
      }
    }
    if (phase2Exercised) {
      const stage2TriggerWhileRunning = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      if (stage2TriggerWhileRunning !== 'false') {
        failures.push(`Stage 2 auto-opened while running even though this turn already has two Stages (aria-expanded was ${JSON.stringify(stage2TriggerWhileRunning)}, expected "false") -- issue #1000 (FR-087) regression: a multi-Stage turn's own running Stage must defer to the chain row, not auto-open itself. THE ONE RED/GREEN DISCRIMINATOR in this script: this is the only check here that fails on unpatched \`origin/main\` and passes once fixed.`);
      } else {
        findings.push('Stage 2 stayed CLOSED while genuinely running, with this turn already at two Stages -- issue #1000 (FR-087) fix confirmed (the one red/green discriminator in this script).');
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

      // Taken before the manual open so it actually shows the closed state.
      await cdp.screenshot(path.join(SHOTS_DIR, '01-stage2-running-chain-open-stage2-closed.png'));

      // Manual open and focus inside it must survive Stage 2 settling (WCAG 2.4.3).
      await expandByFinder(cdp, stageTriggerSelector(STAGE2_TITLE));
      const stage2TriggerAfterManualOpen = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      const stillRunningAfterManualOpen = await cdp.evaluate(stageIsRunningExpr(STAGE2_TITLE));
      if (stage2TriggerAfterManualOpen !== 'true') {
        failures.push(`Manually clicking Stage 2's own trigger did not open it (aria-expanded is ${JSON.stringify(stage2TriggerAfterManualOpen)}, expected "true") -- a user's own choice must still open an auto-open-exempt Stage.`);
      } else {
        manuallyOpened = true;
        if (!stillRunningAfterManualOpen) {
          notExercised.push('Stage 2 settled before the manual-open-plus-focus check could place focus while it was still genuinely running; the keyboard-focus-survives-settling proof did not run as designed this pass.');
        } else {
          await cdp.evaluate(`(${story559Stage2TriggerExpr()})?.focus()`);
          const focusedInStage2 = await cdp.evaluate(`document.activeElement === (${story559Stage2TriggerExpr()})`);
          if (!focusedInStage2) {
            failures.push("Could not place keyboard focus on Stage 2's own Story559 member row trigger while Stage 2 was still genuinely running.");
          } else {
            focusPlaced = true;
            findings.push("Keyboard focus placed on Stage 2's own Story559 member row trigger, inside Stage 2's own manually-opened content, while Stage 2 was still genuinely running.");
          }
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '02-stage2-manually-opened-focus-inside.png'));
    } else {
      // Capture both shots anyway so the known-file list stays accurate.
      await cdp.screenshot(path.join(SHOTS_DIR, '01-stage2-running-chain-open-stage2-closed.png'));
      await cdp.screenshot(path.join(SHOTS_DIR, '02-stage2-manually-opened-focus-inside.png'));
    }

    // Phase 3: after the whole turn settles, a never-touched Stage 3 stays closed and failed Stage 5 is open.
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '03-all-stages-settled.png'));

    if (manuallyOpened) {
      const stage2TriggerAfterSettle = await cdp.evaluate(`(${stageTriggerSelector(STAGE2_TITLE)})?.getAttribute('aria-expanded') ?? null`);
      if (stage2TriggerAfterSettle !== 'true') {
        failures.push(`Stage 2's own manual open did not survive it settling and the rest of the turn streaming in behind it (aria-expanded is now ${JSON.stringify(stage2TriggerAfterSettle)}, expected "true") -- #991's own upward-only rule regressed for an auto-open-exempt Stage.`);
      } else {
        findings.push("Stage 2's own manual open survived it settling all-success and every later Stage streaming in -- #991's own upward-only rule, confirmed for an issue #1000 auto-open-exempt Stage.");
      }
    } else {
      notExercised.push("Stage 2 was never manually opened this pass, so its own manual-open-survives-settling proof did not run.");
    }
    if (focusPlaced) {
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
    } else {
      notExercised.push('Keyboard focus was never placed inside Stage 2 this pass, so the focus-survives-settling proof did not run.');
    }

    const stage3Trigger = await cdp.evaluate(`(${stageTriggerSelector(STAGE3_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage3Trigger !== 'false') {
      failures.push(`Stage 3 (two agents, never failed, never manually touched by this script) is not closed once settled (aria-expanded was ${JSON.stringify(stage3Trigger)}, expected "false") -- issue #1000 (FR-087) regression: it never had any failed/cancelled/exited member, so it should never have auto-opened at all, in a multi-Stage turn.`);
    } else {
      findings.push('Stage 3 (two agents, never failed, never manually touched) stayed closed through the whole settled turn -- the clean "settled and never touched stays closed" proof, confirming it never auto-opened at all (issue #1000, FR-087).');
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

    // Only the closed-while-running check separates the fix from `origin/main`; if it was
    // skipped, the run must not claim DONE.
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
      // best-effort
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
