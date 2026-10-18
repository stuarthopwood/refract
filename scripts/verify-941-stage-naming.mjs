#!/usr/bin/env node
// Live CDP check for issue #941 part 1 (Stage naming, the one green exception for a finished
// Subagent/Stage, the Stage's own batch context on expansion, real "Uses:" dependencies, the
// per-turn Subagent chain row, and the solo-Stage regression guard).
//
// Reuses the recorded-frame fake `omp` harness (`verify-tauri.mjs`/`verify-tauri-cdp.mjs`),
// driving a NEW fixture (`scripts/fixtures/omp-frames/stages-941.jsonl`,
// `REFRACT_FAKE_OMP_SCENARIO=stages-941`) via a local `launchBuiltExeWithEnv` (the shared
// `verify-tauri-scratch-helpers.mjs`'s own `launchBuiltExe` has no `pathPrepend`/`extraEnv`
// params -- every OTHER `verify-9xx-*.mjs` drives a REAL `omp`, never this fake-frame harness),
// the same approach `verify-563-subagent-stage.mjs` already uses. That tape scripts ONE user
// prompt, ONE agent turn, FOUR serial `task()` batches (Stages) -- deliberately never four
// separate prompt turns: `groupSubagentStages.ts` runs once PER TURN (`Transcript.tsx`'s own
// `splitIntoTurns`, keyed on `kind: 'user'` items), so Stage 2's "Uses: G923Code (Stage 1)"
// dependency can only resolve against an earlier Stage inside the SAME turn's own `stages` array.
//
// WRITTEN, NOT RUN: no build slot has been granted for this sub-task -- `node --check` is the
// only command that has actually been run against this script. Every DOM/class-name selector it
// (and its helpers) use was grep-verified against the real source it claims to match; see
// `verify-941-stage-naming-helpers.mjs`'s own header comment for the selector strategy.
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
  assertStageNaming,
  assertGreenFinished,
  assertDetailsOnExpand,
  assertDependencies,
  assertChainRow,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE4_SOLO_TITLE
} from './verify-941-stage-naming-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_941_SHOTS_DIR || path.join(tmpdir(), 'refract-941-stage-naming-shots', new Date().toISOString().replace(/[:.]/g, '-'));
const PROMPT_MESSAGE = 'Run the #923 quality gate, then the #559/#560 fixes, then the two R8 suites, then the final solo check.';

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
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-941-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-941-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-941-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-941-repo-')), 'verify-941-stage-naming');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-941-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-941-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
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

    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created, agent attached (fake omp, stages-941.jsonl scenario).');

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // Wait for all four Stage rows (and the solo row) to settle: every one of their own
    // `title`-bearing label spans present in the transcript.
    for (const titleText of [STAGE1_TITLE, STAGE2_TITLE, STAGE3_TITLE, STAGE4_SOLO_TITLE]) {
      await cdp
        .waitFor(`!!${titleSelector(titleText)}`, { timeoutMs: 30_000, label: `"${titleText}" row rendered` })
        .catch((err) => {
          console.error('verify-941: stage-wait diagnostics:', err.message);
          throw err;
        });
    }
    // All four Stages finished (no running/failed word anywhere left in the transcript).
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running') && !t.textContent.includes('Failed'); })()`,
      { timeoutMs: 30_000, label: 'All four Stages settled (finished)' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '00-all-stages-settled.png'));
    findings.push('All four Stages rendered and settled to finished.');

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await assertStageNaming(cdp, findings, failures, theme.name);
      await assertGreenFinished(cdp, findings, failures, theme.name);
      await assertDetailsOnExpand(cdp, findings, failures, theme.name);
      await assertDependencies(cdp, findings, failures, theme.name);
      await assertChainRow(cdp, findings, failures, theme.name);
      const shotName = `stages-941-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Stages under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push(
      'PR2 scope (Subagent panel Stage grouping, Up next) is not built yet and is not exercised here.'
    );
    notExercised.push(
      'No plain (non-task) tool row exists anywhere in this fixture\'s own transcript, so the regression guard "a tool row elsewhere in the same transcript stays neutral, never green" (toolStatus.tsx, untouched by issue #941) could not be exercised by THIS tape -- it is covered structurally instead: toolStatus.tsx is a wholly separate module from subagentStatus.tsx (grep-verified, no shared GLYPH_KEY_BY_STATUS/success-done mapping), so there is no code path through which a tool row could pick up the green token this story added.'
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
