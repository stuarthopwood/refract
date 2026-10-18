#!/usr/bin/env node
// Live CDP check for issue #941 part 1 (Stage naming, the one green exception for a finished
// Subagent/Stage, the Stage's own batch context on expansion, real "Uses:" dependencies, the
// per-turn Subagent chain row, and the now-UNIFIED solo-vs-multi-agent Stage header).
//
// Reuses the recorded-frame fake `omp` harness (`verify-tauri.mjs`/`verify-tauri-cdp.mjs`),
// driving the fixture (`scripts/fixtures/omp-frames/stages-941.jsonl`,
// `REFRACT_FAKE_OMP_SCENARIO=stages-941`) via a local `launchBuiltExeWithEnv` (the shared
// `verify-tauri-scratch-helpers.mjs`'s own `launchBuiltExe` has no `pathPrepend`/`extraEnv`
// params -- every OTHER `verify-9xx-*.mjs` drives a REAL `omp`, never this fake-frame harness),
// the same approach `verify-563-subagent-stage.mjs` already uses. That tape scripts ONE user
// prompt, ONE agent turn, SEVEN serial `task()` batches (Stages) plus one plain, non-Stage
// `read` tool call -- deliberately never several separate prompt turns: `groupSubagentStages.ts`
// runs once PER TURN (`Transcript.tsx`'s own `splitIntoTurns`, keyed on `kind: 'user'` items), so
// a later Stage's own "Uses:" dependency can only resolve against an earlier Stage inside the
// SAME turn's own `stages` array.
//
// Gate round 1 rewrite: reworked against the NEW DOM contract (every Stage, solo or not, gets
// the same unified header) and a seven-Stage fixture covering every item in the gate round 1
// fix list (bare-label Stage, over-60-char truncation, a mixed finished+failed Stage, a solo
// Stage with a real dependency, a context-brief overflow/toggle, a same-Stage self-reference
// drop, a cross-Stage repeated-name "latest occurrence wins" resolution, and a plain non-Stage
// tool row for the "tool rows stay neutral" regression guard). Item 13 (CRITICAL, previously a
// missing-at-runtime import of `resolveCssVarColor` from the WRONG module in the helpers file)
// is proven fixed by loading both this script and its helpers with a real `import()`, not just
// `node --check`'s syntax-only pass:
//
//   $ node -e "import('./scripts/verify-941-stage-naming-helpers.mjs').then(() => console.log('helpers OK'))"
//   helpers OK
//   $ node -e "import('./scripts/verify-941-stage-naming.mjs')"
//   (module loads; execution then proceeds into main(), which requires a build slot to finish --
//   see the main script's own report for the actual run)
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus the real `import()` load-check above are the only commands that have actually been run
// against these two files. Every DOM/class-name selector they use was grep-verified against the
// real source it claims to match; see `verify-941-stage-naming-helpers.mjs`'s own header comment
// for the selector strategy.
//
// PR2 scope (the Subagent panel's own Stage grouping, and the "Up next" todo-phase list) is NOT
// built yet and is not exercised here (recorded in `report.json`'s own `notExercised`).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  clickScrolled,
  clickByLabelScrolled,
  clickByTextScrolled,
  assertStageNaming,
  assertSoloAgentName,
  assertStageMetaRollup,
  assertGreenFinished,
  assertDetailsOnExpand,
  assertChainRow,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE4_TITLE,
  STAGE5_TITLE,
  STAGE6_SOLO_TITLE,
  STAGE7_TITLE,
  STAGE8_PREFIX_TITLE,
  STAGE9_SOLO_NOCTX_TITLE,
  STAGE10_BORDERLINE_TITLE,
  PLAIN_TOOL_TITLE
} from './verify-941-stage-naming-helpers.mjs';
import { assertDependencies } from './verify-941-stage-naming-panel-helpers.mjs';
import { assertContextBriefOverflow, assertNarrowViewportOverflow } from './verify-941-stage-naming-overflow-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE =
  'Run the #923 quality gate, then the #559/#560 fixes, then read the README, then the zeta/omega probes, the label check, the Story559 polish and fail probe, the final solo check, the long-context investigation, the shared-prefix probes, the solo bare-label check, and the borderline-length context check.';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

function titleSelector(titleText) {
  return `document.querySelector('[title=${JSON.stringify(titleText)}]')`;
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  // Gate round 1 fix (item 17): `SHOTS_DIR` is established and created, `requireSharedCargoTarget`
  // is called, and `gitHead`/`dirty` are read all at the very TOP of this try block, before
  // anything else that could throw (the scratch-dir creation below, the build itself, the
  // launch) -- so if ANY of that later throws, the `catch` below still has a real, EXISTING
  // `SHOTS_DIR` plus real `gitHead`/`dirty` values to write `report.json` into, instead of an
  // uncaught module-scope throw leaving no report at all (the bug this item names: the previous
  // version called `requireSharedCargoTarget` at MODULE scope, entirely outside any try/catch,
  // and before `SHOTS_DIR` even existed on disk). `SHOTS_DIR` is established and `mkdirSync`'d
  // FIRST, ahead of `requireSharedCargoTarget` itself (a deliberate, more robust reordering of
  // the three steps named in item 17: a throw from `requireSharedCargoTarget` must land on a
  // `SHOTS_DIR` that already exists, or the `catch`'s own `writeFileSync` would itself fail with
  // ENOENT and still leave no report at all -- the exact failure mode this fix exists to close).
  // `let`, not `const`, and declared OUTSIDE the try body itself: both are read again in `catch`.
  let SHOTS_DIR = path.join(tmpdir(), 'refract-941-stage-naming-shots', new Date().toISOString().replace(/[:.]/g, '-'));
  let BUILD_OUTPUT_DIR = null;
  try {
    SHOTS_DIR = process.env.REFRACT_941_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-941-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-941-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-941-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-941-repo-')), 'verify-941-stage-naming');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-941-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-941-launcher-'));
    const port = await getFreePort();

    console.log(`verify-941: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-941: shim dir ${shimDir}`);
    console.log(`verify-941: data dir ${dataDir}`);
    console.log(`verify-941: shots dir ${SHOTS_DIR}`);
    console.log(`verify-941: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-941' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-941: built exe copied to ${exePath}`);

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
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-941: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    findings.push('Readiness screen green (fake omp, stages-941 scenario).');

    // Gate round 5 fix (issue #941, item 9, MEDIUM): every real click below scrolls its own
    // target into view first (`clickScrolled`/`clickByLabelScrolled`/`clickByTextScrolled`,
    // `verify-tauri-cdp.mjs`'s own `click()` never does) -- a no-op when already in view.
    await clickScrolled(cdp, `document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await clickScrolled(cdp, `document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await clickByTextScrolled(cdp, 'Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await clickByLabelScrolled(cdp, 'New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await clickByTextScrolled(cdp, 'Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created, agent attached (fake omp, stages-941.jsonl scenario).');

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await clickByLabelScrolled(cdp, 'Send message');

    // Wait for all ten Stage rows, the solo Stages, and the plain non-Stage tool row to settle:
    // every one of their own `title`-bearing label spans present in the transcript.
    for (const titleText of [
      STAGE1_TITLE,
      STAGE2_TITLE,
      STAGE3_TITLE,
      STAGE4_TITLE,
      STAGE5_TITLE,
      STAGE6_SOLO_TITLE,
      STAGE7_TITLE,
      STAGE8_PREFIX_TITLE,
      STAGE9_SOLO_NOCTX_TITLE,
      STAGE10_BORDERLINE_TITLE,
      PLAIN_TOOL_TITLE
    ]) {
      await cdp
        .waitFor(`!!${titleSelector(titleText)}`, { timeoutMs: 30_000, label: `"${titleText}" row rendered` })
        .catch((err) => {
          console.error('verify-941: stage-wait diagnostics:', err.message);
          throw err;
        });
    }
    // Every Stage/tool row settled (no running word anywhere left in the transcript). Stage 5's
    // own FailAgent settles to "failed", not "running", so this still holds with a genuine
    // failure present.
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '00-all-stages-settled.png'));
    findings.push('All ten Stages, the solo Stages, and the plain non-Stage tool row rendered and settled.');

    for (const [themeIndex, theme] of THEMES.entries()) {
      // Gate round 3 fix (item 11): only the FIRST pass through this loop can assert a row's
      // own REAL `defaultOpen` starting value exactly -- `switchTheme` never reloads the app,
      // so a row a later pass already expanded stays expanded across every subsequent theme.
      const isFirstThemePass = themeIndex === 0;
      await switchTheme(cdp, theme.id, theme.name);
      await assertStageNaming(cdp, findings, failures, theme.name);
      await assertSoloAgentName(cdp, findings, failures, theme.name, notExercised);
      await assertStageMetaRollup(cdp, findings, failures, theme.name);
      // Gate round 5 fix (items 6/7, HIGH): both expand-cycle "starts collapsed" first-pass
      // checks now run BEFORE anything else ever expands that same row -- `assertGreenFinished`
      // below expands Stage 1 (and Stage 5) for its own member-colour check, and
      // `assertDependencies` expands Stage 7 for its own self-reference check; either one
      // running FIRST made the later "starts collapsed" assertion a false failure (the row was
      // already open by the time it ran). `assertDetailsOnExpand`'s own re-expand is a no-op
      // once `assertGreenFinished` later re-touches the same row (`expandByFinder` only clicks
      // when not already open); `assertContextBriefOverflow` leaves Stage 7's own BRIEF
      // (the "Show full brief"/"Show less" toggle content nested inside it) re-collapsed at
      // the end of its own cycle -- the Stage 7 ROW itself stays EXPANDED throughout, opened
      // once at that function's own start and never closed again -- so `assertDependencies`'s
      // later plain `expandRow` call for Stage 7 is unaffected either way (already open).
      await assertDetailsOnExpand(cdp, findings, failures, theme.name, isFirstThemePass);
      await assertContextBriefOverflow(cdp, findings, failures, theme.name, isFirstThemePass);
      await assertGreenFinished(cdp, findings, failures, theme.name);
      await assertDependencies(cdp, findings, failures, theme.name, isFirstThemePass);
      await assertNarrowViewportOverflow(cdp, findings, failures, theme.name);
      await assertChainRow(cdp, findings, failures, theme.name, isFirstThemePass);

      const shotName = `stages-941-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Stages under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push(
      'PR2 scope (Subagent panel Stage grouping, Up next) is not built yet and is not exercised here.'
    );

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-941: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-941: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-941: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-941: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-941: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-941: could not preserve logs:', err.message);
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
  console.error('verify-941: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
