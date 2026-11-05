#!/usr/bin/env node
// Live CDP check for #1623: a background (async) task agent stays Running after spawn and settles
// only when a later `wait` reports it. Fixture: scripts/fixtures/omp-frames/subagents-background-turn.jsonl.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1623_SHOTS_DIR || path.join(tmpdir(), `refract-1623-shots-${Date.now()}`);
const CHAIN_TRIGGER = `Array.from(document.querySelectorAll('[data-slot="collapsible-trigger"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('Subagents, '))`;

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(tmpdir(), `refract-1623-${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1623-repo-')), 'verify-1623');
    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1623' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'subagents-background-turn'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    const repoName = path.basename(dirs.repo);
    await addRepository(cdp, dirs.repo);
    await createSessionViaQuickCreate(cdp, repoName);
    await latestSessionIdAndName(cdp, repoName, []);
    const snap = () => cdp.evaluate(`(() => { const t = ${CHAIN_TRIGGER}; return t ? { label: t.getAttribute('aria-label'), text: t.innerText } : null; })()`);

    await cdp.typeIntoByLabel('Message', 'Start gamma in the background (issue #1623 live check).');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.body.innerText.includes('Started gamma in the background')`, { timeoutMs: 30_000, label: 'turn 1 settled' });
    await cdp.waitFor(`!!(${CHAIN_TRIGGER})`, { timeoutMs: 30_000, label: 'Subagents row mounted' });
    const afterSpawn = await snap();
    findings.push(`after spawn: ${JSON.stringify(afterSpawn)}`);
    if (/finished/i.test(afterSpawn.text) || !/running/i.test(`${afterSpawn.label} ${afterSpawn.text}`)) failures.push(`#1623: not Running after spawn: ${JSON.stringify(afterSpawn)}`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1623-after-spawn-running.png'));

    await cdp.typeIntoByLabel('Message', 'Check on gamma.');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.body.innerText.includes('gamma finished investigating.')`, { timeoutMs: 30_000, label: 'turn 2 done' });
    await cdp.waitFor(`!!(${CHAIN_TRIGGER})?.innerText.includes('Finished')`, { timeoutMs: 15_000, label: 'settled by wait' });
    const afterWait = await snap();
    findings.push(`after wait: ${JSON.stringify(afterWait)}`);
    if (/running/i.test(afterWait.label)) failures.push(`#1623: still Running after wait: ${JSON.stringify(afterWait)}`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1623-after-wait-finished.png'));

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ findings, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {}
    console.error('verify-1623: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (dirs.exe && existsSync(path.join(dirs.exe, 'app.log'))) copyFileSync(path.join(dirs.exe, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
