#!/usr/bin/env node
// Live CDP check for #941 part 1: Stage naming, finished-Stage green, batch context, "Uses:"
// dependencies and the unified Stage header, driven by the recorded-frame fake `omp` fixture
// `stages-941.jsonl`. The fixture is one prompt/turn because Stage grouping runs once per turn,
// so a "Uses:" dependency can only resolve against an earlier Stage in the same turn.

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
  PLAIN_TOOL_TITLE,
  titleSelector
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
  // SHOTS_DIR must exist before anything that can throw so the catch can still write report.json;
  // both `let`s are read again in the catch.
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

    await cdp.openLocalFolderDialog();
    await clickScrolled(cdp, `document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await clickByTextScrolled(cdp, 'Add project', { inDialog: true });
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
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '00-all-stages-settled.png'));
    findings.push('All ten Stages, the solo Stages, and the plain non-Stage tool row rendered and settled.');

    for (const [themeIndex, theme] of THEMES.entries()) {
      // Only the first pass can assert the real `defaultOpen` value: switchTheme never reloads, so
      // rows expanded earlier stay open.
      const isFirstThemePass = themeIndex === 0;
      await switchTheme(cdp, theme.id, theme.name);
      await assertStageNaming(cdp, findings, failures, theme.name);
      await assertSoloAgentName(cdp, findings, failures, theme.name, notExercised);
      await assertStageMetaRollup(cdp, findings, failures, theme.name);
      // Order matters: assertGreenFinished and assertDependencies expand Stage 1/5/7, which would
      // falsify the "starts collapsed" first-pass checks if they ran first.
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
