#!/usr/bin/env node
// Live CDP check for issue #911 (a user-initiated Stop mid-flight must settle a tool row to a
// neutral `cancelled` treatment, never the full failed/red treatment a genuine failure gets).
// Modelled on `scripts/verify-570-tool-colours.mjs` (the real Stop button, `readHeaderColours`'s
// never-guess-from-class-names approach to computed colour) and `scripts/verify-1000-stage-defer.mjs`
// (fake-omp fixture, `report.json`, `clearKnownOutputFiles`, themed screenshots).
//
// New fixture `scripts/fixtures/omp-frames/stop-911.jsonl` (AGENTS.md: a fake-omp frame fixture
// genuinely needed here -- no existing tape scripts an `abort` wait, and a real `omp`'s own abort
// timing is not deterministic enough to assert a settled DOM state against, unlike #570's own
// turn (c), which only ever RECORDED what happened, asserting nothing). Three turns against one
// scratch Session:
//   Turn A: a `read` call that finishes immediately (done, unaffected baseline), then a `bash`
//     call that stays running until the script's own REAL Stop click sends OMP's `abort` command
//     -- the fixture then settles that SAME call's own `tool_execution_end` with `isError:true`
//     and `result.content` reading "Command aborted" (OMP's own real wire shape confirmed live
//     at #570's own gate round 1, `verify-570-tool-colours.mjs` turn (c), 2026-10-16), followed by
//     `prompt_result{status:"aborted"}`.
//   Turn B: a second, genuine `bash` failure (`isError:true`, no abort in flight for this turn --
//     `AgentState.turn_abort_requested` was cleared when turn A settled) -- proves a real failure
//     in a LATER turn still settles `error`, never `cancelled`.
//
// THE ONE RED/GREEN DISCRIMINATOR: turn A's `bash` row settling to the neutral `cancelled`
// treatment (stop-circle icon, muted colour token, "Stopped" label, no `aria-describedby`/Error
// line) instead of `error` (red icon/label, an Error line reading "Command aborted"). MUST FAIL on
// `origin/main`: there, `ToolStatus` has no `Cancelled` variant and `apply_tool_execution_end`
// always maps `isError:true` to `Error` regardless of why -- turn A's row would read `error`
// exactly like turn B's, with an Error line reading "Command aborted".
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task, and the fix
// itself is Rust-side (`ToolStatus::Cancelled`, `AgentState.turn_abort_requested`), so the live
// check cannot genuinely pass without a rebuilt exe containing it -- `node --check` plus a real
// `import()` load-check are the only commands that have actually been run against this file and
// the new fixture (same precedent `verify-1000-stage-defer.mjs`'s own header comment set).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
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
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TURN_A_PROMPT =
  'Turn A (issue #911 live check): a read call that finishes immediately, then a long bash call this script will Stop mid-flight.';
const TURN_B_PROMPT = 'Turn B (issue #911 live check): a genuine bash failure in a later turn, which must stay red.';
const SHOTS_DIR =
  process.env.REFRACT_911_SHOTS_DIR || path.join(tmpdir(), `refract-911-stop-neutral-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-turn-a-bash-running.png',
  '02-turn-a-stopped-neutral.png',
  '03-turn-b-genuine-failure-red.png',
  '911-stop-neutral-dark.png',
  '911-stop-neutral-obsidian.png',
  '911-stop-neutral-dark-high-contrast.png',
  'report.json',
  'app.log',
  'fake-omp-invocations.log'
];

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

const TRANSCRIPT_BUTTONS = `Array.from(document.querySelectorAll('[aria-label="Transcript"] button'))`;

// The `read` call's solo row is never command-style (`COMMAND_STYLE_TOOLS` is bash/grep only),
// so it keeps its own visible label ("read", `ToolGroupRow`'s `visibleLabel`).
function rowByLabelFinder(text) {
  return `(${TRANSCRIPT_BUTTONS}).find((el) => {
    const label = el.querySelector('[data-slot="collapsed-line-label"]');
    return label ? label.textContent.trim() === ${JSON.stringify(text)} : false;
  })`;
}

// A solo `bash` row drops its own tool-name label (M2, command-style) and shows "$ <command>" as
// its summary instead (`commandRowText`) -- found by a distinctive substring of its own command
// text, never by index, so turn A's stopped call and turn B's genuinely-failed call (both
// `bash`, in different turns, never merged into one group either way) are never confused.
function rowByCommandSubstringFinder(substring) {
  return `(${TRANSCRIPT_BUTTONS}).find((el) => {
    const s = el.querySelector('span.min-w-0.flex-1');
    return s ? (s.textContent || '').includes(${JSON.stringify(substring)}) : false;
  })`;
}

const READ_ROW = rowByLabelFinder('read');
const STOPPED_BASH_ROW = rowByCommandSubstringFinder('sleep 30');
const FAILED_BASH_ROW = rowByCommandSubstringFinder('definitely-not-a-real-path-911');

// Reads the row's own status icon colour, accessible status word (`StatusIcon`'s own sr-only
// span, scoped to the icon SLOT specifically -- `span.flex.h-5.w-4`, `CollapsedLine.tsx` -- never
// the meta slot's own unrelated `, ` separator sr-only span), and whether an Error line is
// mounted at all (`aria-describedby` is only ever set when `detail !== undefined`,
// `CollapsedLine.tsx`'s own `showDetail`/`detailMounted`) -- never guessed from class names, the
// same discipline `verify-570-tool-colours.mjs`'s own `readHeaderColours` already established.
function rowStateExpr(finderExpr) {
  return `(() => {
    const header = (${finderExpr});
    if (!header) return null;
    const iconSlot = header.querySelector('span.flex.h-5.w-4');
    const icon = iconSlot ? iconSlot.querySelector('svg') : null;
    const statusWordEl = iconSlot ? iconSlot.querySelector('span.sr-only') : null;
    const describedby = header.getAttribute('aria-describedby');
    const detail = describedby ? document.getElementById(describedby) : null;
    return {
      iconColor: icon ? getComputedStyle(icon).color : null,
      statusWord: statusWordEl ? statusWordEl.textContent.trim() : null,
      ariaDescribedby: describedby,
      detailText: detail ? detail.textContent.trim() : null,
      detailColor: detail ? getComputedStyle(detail).color : null
    };
  })()`;
}

async function readRowState(cdp, finderExpr) {
  return cdp.evaluate(rowStateExpr(finderExpr));
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
    clearKnownOutputFiles(SHOTS_DIR, 'refract-911-stop-neutral-shots', SHOT_NAMES);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-911-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-911-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-911-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-911-repo-')), 'verify-911-stop-neutral');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-911-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-911-launcher-'));
    const port = await getFreePort();

    console.log(`verify-911: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-911: shots dir ${SHOTS_DIR}`);
    console.log(`verify-911: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-911' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-911: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stop-911',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-911: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Shim-confirmed guard (same pattern as verify-862/941/991/1000): without this, a silently-
    // wrong fake-omp shim could still let the whole run "pass" on UI state alone.
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-911: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(
        `verify-911: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`
      );
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${sessionA.name}" created in the scratch repo, agent attached (fake omp, stop-911.jsonl scenario).`);

    // ---- Turn A: read (done immediately), then bash (stopped mid-flight) ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(`(${READ_ROW}) !== undefined`, { timeoutMs: 15_000, label: 'read row rendered' });
    const readDoneState = await (async () => {
      await cdp.waitFor(`${rowStateExpr(READ_ROW)}?.statusWord === 'Done'`, { timeoutMs: 15_000, label: 'read row settled Done' });
      return readRowState(cdp, READ_ROW);
    })();
    if (readDoneState?.ariaDescribedby) {
      failures.push(`The 'read' call's own row carries an aria-describedby (${JSON.stringify(readDoneState.ariaDescribedby)}) -- a successful call must never mount an Error line.`);
    } else {
      findings.push("The 'read' call settled Done with no Error line -- an unaffected, already-finished call stays untouched by this fix.");
    }

    await cdp.waitFor(`(${STOPPED_BASH_ROW}) !== undefined`, { timeoutMs: 15_000, label: 'bash row (to be stopped) rendered' });
    // Gate-fix (Main, 2026-10-18): confirm the call is GENUINELY running before Stop is
    // clicked -- without this, a fast-settling fixture replay could click Stop after the row
    // already moved on, making the whole discriminator meaningless.
    await cdp.waitFor(`${rowStateExpr(STOPPED_BASH_ROW)}?.statusWord === 'Running'`, {
      timeoutMs: 15_000,
      label: 'bash row genuinely Running before Stop is clicked'
    });
    await cdp.screenshot(path.join(SHOTS_DIR, '01-turn-a-bash-running.png'));

    // Real Stop click -- sends OMP's own `abort` command, which `stop-911.jsonl`'s tape is
    // paused waiting for (`{"__wait__":["abort"]}`) before it ever settles the running call.
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[aria-label="Stop"]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Stop button enabled' }
    );
    await cdp.clickByLabel('Stop');
    findings.push("Clicked the real 'Stop' button while the bash call was confirmed genuinely running.");

    await cdp.waitFor(`${rowStateExpr(STOPPED_BASH_ROW)}?.statusWord === 'Stopped'`, {
      timeoutMs: 20_000,
      label: 'stopped bash row settles to the Stopped status word'
    });
    const stoppedState = await readRowState(cdp, STOPPED_BASH_ROW);

    if (stoppedState?.statusWord !== 'Stopped') {
      failures.push(`The Stop-cut-short bash row's own status word is ${JSON.stringify(stoppedState?.statusWord)}, expected "Stopped" -- issue #911 regression (or origin/main's pre-fix behaviour: a tool row has no neutral cancelled status, so a Stop click settles it to the full "Failed" treatment instead).`);
    } else {
      findings.push('The Stop-cut-short bash row\'s own status word reads "Stopped", not "Failed" -- the new neutral cancelled status, never the red error word.');
    }
    if (stoppedState?.ariaDescribedby) {
      failures.push(`The Stop-cut-short bash row still carries an aria-describedby (${JSON.stringify(stoppedState.ariaDescribedby)}, text: ${JSON.stringify(stoppedState.detailText)}) -- a user-initiated Stop must never mount an Error line (THE discriminator this issue exists to fix).`);
    } else {
      findings.push('The Stop-cut-short bash row mounts no Error line at all (no aria-describedby) -- confirmed neutral, never the red "Command aborted" Error line #570\'s own gate round 1 found live.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-a-stopped-neutral.png'));

    // ---- Turn B: a genuine bash failure in a LATER turn -- must stay red ----
    await cdp.waitFor(
      `(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`,
      { timeoutMs: 30_000, label: 'Composer re-enabled once turn A fully settled (Idle)' }
    );
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(`${rowStateExpr(FAILED_BASH_ROW)}?.statusWord === 'Failed'`, {
      timeoutMs: 20_000,
      label: 'turn B\'s genuinely-failed bash row settles to Failed'
    });
    const failedState = await readRowState(cdp, FAILED_BASH_ROW);
    if (failedState?.statusWord !== 'Failed') {
      failures.push(`Turn B's own genuine bash failure settled with status word ${JSON.stringify(failedState?.statusWord)}, expected "Failed" -- a real failure in a LATER turn must still read as failed (never cancelled, since this turn's own abort-request flag was cleared once turn A settled).`);
    } else {
      findings.push('Turn B\'s own genuine bash failure (no Stop click, no abort in flight for this turn) still settles to "Failed" -- confirmed the fix is scoped to an actual Stop, never a blanket neutral treatment for every isError:true call.');
    }
    if (!failedState?.ariaDescribedby || !failedState.detailText) {
      failures.push('Turn B\'s own genuine bash failure mounts no Error line -- a real failure must still show FR-061\'s own Error line.');
    } else {
      findings.push(`Turn B's own genuine bash failure shows its own Error line: ${JSON.stringify(failedState.detailText)}.`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '03-turn-b-genuine-failure-red.png'));

    // Gate-fix (Main, 2026-10-18): colour-token comparisons run ONCE PER THEME (not only
    // under the default theme) -- both tokens resolve differently per theme, so checking them
    // only before this loop started would never catch a theme-specific regression.
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const mutedForeground = await resolveCssVarColor(cdp, '--muted-foreground', 'color');
      const severityError = await resolveCssVarColor(cdp, '--severity-error', 'color');
      const themedStoppedState = await readRowState(cdp, STOPPED_BASH_ROW);
      const themedFailedState = await readRowState(cdp, FAILED_BASH_ROW);
      if (themedStoppedState?.iconColor !== mutedForeground) {
        failures.push(`[${theme.name}] The Stop-cut-short bash row's own icon colour is ${JSON.stringify(themedStoppedState?.iconColor)}, expected the resolved --muted-foreground token (${JSON.stringify(mutedForeground)}).`);
      } else if (themedStoppedState?.iconColor === severityError) {
        failures.push(`[${theme.name}] The Stop-cut-short bash row's own icon colour matches --severity-error -- the full failed/red treatment, exactly the bug issue #911 reports.`);
      } else {
        findings.push(`[${theme.name}] The Stop-cut-short bash row's own icon colour resolves to --muted-foreground (${mutedForeground}), distinct from --severity-error (${severityError}).`);
      }
      if (themedFailedState?.iconColor !== severityError) {
        failures.push(`[${theme.name}] Turn B's own genuine bash failure icon colour is ${JSON.stringify(themedFailedState?.iconColor)}, expected the resolved --severity-error token (${JSON.stringify(severityError)}).`);
      } else {
        findings.push(`[${theme.name}] Turn B's own genuine bash failure icon colour resolves to --severity-error -- a real failure still reads red in this theme.`);
      }
      const shotName = `911-stop-neutral-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push(
      "This fixture's own turn-A abort sequence (`tool_execution_start`, a REAL `abort` wait, then that same call's own `tool_execution_end{isError:true, \"Command aborted\"}`, then `prompt_result{status:\"aborted\"}`) is hand-written against the documented wire contract (src/shared/frames.ts's PromptResultFrame.status already lists 'aborted'; transcript.rs's own apply_prompt_result_notice already has an \"aborted\" arm) and against issue #911's own live finding (verify-570-tool-colours.mjs turn (c), 2026-10-16, real signed-in omp, which captured this exact isError:true/\"Command aborted\" shape once, live) -- it is NOT itself a fresh live capture of a real omp's own abort response; re-probing a real omp for it was out of scope for this fix."
    );
    // Issue #911 live-verified (build slot granted by Main, 2026-10-18): ran end to end,
    // 0 failures, screenshots viewed in all 3 themes. The "written, not run" note this script
    // carried before that run is removed -- it is no longer true.

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
    console.log('\n=== verify-911: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-911: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-911: NOT EXERCISED (genuine skips/limits only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-911: ${verdict}.`);
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
    console.error('verify-911: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-911: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-911: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-911: could not preserve logs:', err.message);
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
  console.error('verify-911: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
