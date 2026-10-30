#!/usr/bin/env node
// Live CDP check for #1436 (chain row card) and #1437 (chain row settles from progress updates while the
// turn is still running). Fixture: scripts/fixtures/omp-frames/stages-1437.jsonl.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1437_SHOTS_DIR || path.join(tmpdir(), `refract-1437-shots-${Date.now()}`);
const CHAIN_TRIGGER = `Array.from(document.querySelectorAll('[data-slot="collapsible-trigger"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('Subagents, '))`;

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync_(SHOTS_DIR);
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(tmpdir(), `refract-1437-${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1437-repo-')), 'verify-1437');
    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1437' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-1437'
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
    await cdp.typeIntoByLabel('Message', 'Run the two-Stage chain (issues #1436, #1437 live check).');
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(`!!(${CHAIN_TRIGGER})`, { timeoutMs: 30_000, label: 'Subagents chain row mounted' });
    await cdp.waitFor(`document.querySelectorAll('[role="group"][data-status]').length === 0 || !!(${CHAIN_TRIGGER})?.innerText.includes('Finished')`, { timeoutMs: 30_000, label: 'chain settled' });
    const state = await cdp.evaluate(`(() => {
      const t = ${CHAIN_TRIGGER};
      const root = t.closest('[data-slot="collapsible"]');
      return { label: t.getAttribute('aria-label'), cls: root.className, text: t.innerText, turnDone: document.body.innerText.includes('Both Stages settled.') };
    })()`);
    findings.push(`chain trigger state: ${JSON.stringify(state)}`);
    if (state.turnDone) failures.push('turn already ended; the settle-before-turn-end condition was not exercised');
    if (/running/i.test(state.label) || /running/i.test(state.text)) failures.push(`#1437: chain row still shows running while agents finished: ${state.label}`);
    if (!/Finished/.test(state.text)) failures.push(`#1437: chain row text does not read Finished: ${state.text}`);
    if (!/\bring-divider\b/.test(state.cls) || !/\bbg-card\b/.test(state.cls) || !/\brounded-lg\b/.test(state.cls)) failures.push(`#1436: chain row card classes missing: ${state.cls}`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1437-chain-settled-dark.png'));
    await switchTheme(cdp, 'obsidian', 'Obsidian');
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1436-chain-card-obsidian.png'));
    await cdp.click(CHAIN_TRIGGER);
    await new Promise((r) => setTimeout(r, 800));
    await cdp.screenshot(path.join(SHOTS_DIR, '1436-chain-expanded-obsidian.png'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ findings, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {}
    console.error('verify-1437: FAILED:', err?.stack ?? err);
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

import { mkdirSync } from 'node:fs';
function mkdirSync_(p) {
  mkdirSync(p, { recursive: true });
}

main();
