#!/usr/bin/env node
// Live CDP check for issue #897 (focus must not fall to <body> when the Stop button unmounts at
// the end of a turn). Modelled on `scripts/verify-911-stop-neutral.mjs` (same launch, fake omp,
// scratch repo and cleanup helpers); fixture `fixtures/omp-frames/stop-focus-897.jsonl`.
//   Turn A: the script focuses the real Stop button (what a Tab would do), the fixture ends the
//     turn on its own, and `document.activeElement` must then be the composer textarea.
//   Turn B: the script focuses Stop, presses it with a real click, and the same assertion holds.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
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
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_897_SHOTS_DIR || path.join(tmpdir(), `refract-897-stop-focus-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = ['01-turn-a-ended.png', '02-turn-b-stopped.png', 'report.json', 'app.log', 'fake-omp-invocations.log'];

const ACTIVE = `(() => { const a = document.activeElement; return a ? { tag: a.tagName, label: a.getAttribute('aria-label'), isBody: a === document.body } : null; })()`;

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir, child, targetPid, cdp;
  const findings = [];
  const failures = [];
  let gitHeadSha = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-897-stop-focus-shots', SHOT_NAMES);
    const buildOutputDir = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-897-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-897-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-897-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-897-repo-')), 'verify-897-stop-focus');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-897-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-897-launcher-'));
    const port = await getFreePort();
    console.log(`verify-897: git HEAD ${gitHeadSha}, shots dir ${SHOTS_DIR}, CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildOutputDir, REPO_ROOT, { label: 'verify-897' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stop-focus-897',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, targetPid)) throw new Error('CDP target is not owned by the launched process');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLog) || !/^pid=\d+ argv=/.test(readFileSync(debugLog, 'utf8').split('\n')[0] ?? '')) {
      throw new Error('fake omp shim never ran (debug log missing or malformed)');
    }
    findings.push('Fake omp shim confirmed.');

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await latestSessionIdAndName(cdp, path.basename(repoDir), []);

    // ---- Turn A: natural end while Stop holds focus ----
    await cdp.typeIntoByLabel('Message', 'Turn A (issue #897): ends on its own while Stop is focused.');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!document.querySelector('[aria-label="Stop"]')`, { timeoutMs: 15_000, label: 'Stop mounted (turn A)' });
    await cdp.evaluate(`document.querySelector('[aria-label="Stop"]').focus()`);
    const beforeA = await cdp.evaluate(ACTIVE);
    if (beforeA?.label !== 'Stop') failures.push(`Could not focus Stop before turn A ended: ${JSON.stringify(beforeA)}`);
    await cdp.waitFor(`!document.querySelector('[aria-label="Stop"]')`, { timeoutMs: 30_000, label: 'Stop unmounted (turn A natural end)' });
    const afterA = await cdp.evaluate(ACTIVE);
    if (afterA?.isBody || afterA?.label !== 'Message') {
      failures.push(`Turn A natural end: document.activeElement is ${JSON.stringify(afterA)}, expected the composer textarea (aria-label "Message").`);
    } else {
      findings.push('Turn A (natural end, Stop focused): activeElement is the composer textarea, not body.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-turn-a-ended.png'));

    // ---- Turn B: real Stop click ----
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 30_000,
      label: 'Composer enabled after turn A'
    });
    await cdp.typeIntoByLabel('Message', 'Turn B (issue #897): a Stop click.');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const b = document.querySelector('[aria-label="Stop"]'); return !!b && !b.disabled; })()`, {
      timeoutMs: 15_000,
      label: 'Stop enabled (turn B)'
    });
    await cdp.evaluate(`document.querySelector('[aria-label="Stop"]').focus()`);
    await cdp.clickByLabel('Stop');
    await cdp.waitFor(`!document.querySelector('[aria-label="Stop"]')`, { timeoutMs: 20_000, label: 'Stop unmounted (turn B)' });
    const afterB = await cdp.evaluate(ACTIVE);
    if (afterB?.isBody || afterB?.label !== 'Message') {
      failures.push(`Turn B Stop click: document.activeElement is ${JSON.stringify(afterB)}, expected the composer textarea.`);
    } else {
      findings.push('Turn B (Stop clicked): activeElement is the composer textarea, not body.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-b-stopped.png'));

    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, verdict }, null, 2));
    console.log(`FAILURES: ${failures.length ? failures.join(' | ') : '(none)'}`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`verify-897: ${verdict}.`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-897: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const n of ['app.log', 'fake-omp-invocations.log']) {
        if (exeDir && existsSync(path.join(exeDir, n))) copyFileSync(path.join(exeDir, n), path.join(SHOTS_DIR, n));
      }
    } catch {
      // best-effort only
    }
    for (const d of [shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir]) await safeRmSync(d);
  }
}

main().catch((err) => {
  console.error('verify-897: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
