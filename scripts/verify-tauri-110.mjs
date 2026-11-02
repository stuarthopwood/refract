#!/usr/bin/env node
// Live CDP check for #1545 and #695: Advanced rows, the overlay passed to omp, and the Session prewalk menu item.
// Fixture: scripts/fixtures/omp-frames/prewalk-695.jsonl.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
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
const SHOTS_DIR = process.env.REFRACT_110_SHOTS_DIR || path.join(tmpdir(), `refract-110-shots-${Date.now()}`);
const MENU_ITEM = (text) => `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.includes(${JSON.stringify(text)}))`;

async function openKebab(cdp, repoName) {
  await cdp.click(`document.querySelector('[aria-label^="More actions for"]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Session menu open' });
}

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(tmpdir(), `refract-110-${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-110-repo-')), 'verify-110');
    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-110' });
    const debugLog = path.join(dirs.exe, 'fake-omp-debug.log');
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'prewalk-695',
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog
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
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
    await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Advanced')`);
    for (const label of ['File read line limit', 'Summarise files on read', 'Automatic todo lists', 'Start Sessions with prewalk', 'Start in plan mode']) {
      const found = await cdp.evaluate(`document.body.textContent.includes(${JSON.stringify(label)})`);
      findings.push(`Advanced row "${label}": ${found}`);
      if (!found) failures.push(`Advanced row missing: ${label}`);
    }
    await cdp.evaluate(`Array.from(document.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent.trim() === 'File read line limit')?.scrollIntoView()`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '110-advanced-tool-output.png'));
    await cdp.evaluate(`Array.from(document.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent.trim() === 'Start in plan mode')?.scrollIntoView()`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '110-advanced-session-start.png'));
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings closed' });
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '110-after-back.png'));

    await openKebab(cdp, repoName);
    const before = await cdp.evaluate(`(${MENU_ITEM('prewalk')})?.textContent ?? null`);
    findings.push(`menu item before any report: ${before}`);
    if (before !== 'Arm prewalk') failures.push(`#695: expected "Arm prewalk" before OMP reports, got ${before}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '110-session-menu-unknown.png'));
    await cdp.click(MENU_ITEM('prewalk'));
    await cdp.waitFor(`document.body.innerText.includes('Prewalk on:')`, { timeoutMs: 20_000, label: 'omp /prewalk reply shown' });
    await openKebab(cdp, repoName);
    await cdp.waitFor(`!!(${MENU_ITEM('Cancel prewalk')})`, { timeoutMs: 10_000, label: 'menu reads armed after omp reply' });
    findings.push('menu item after omp reply: Cancel prewalk (armed)');
    await cdp.screenshot(path.join(SHOTS_DIR, '110-session-menu-armed.png'));

    const log = readFileSync(debugLog, 'utf8');
    const argvLine = log.split('\n').find((l) => l.includes('--mode') && l.includes('--config'));
    const argv = argvLine ? JSON.parse(argvLine.match(/argv=(\[.*?\]) cwd=/)[1]) : [];
    const cfg = argv[argv.indexOf('--config') + 1];
    if (!cfg || !existsSync(cfg)) failures.push(`overlay path not found in omp argv: ${cfg}`);
    else {
      const overlay = readFileSync(cfg, 'utf8');
      findings.push(`overlay passed to omp (${cfg}):\n${overlay}`);
      for (const needle of [/defaultOnStartup:\s*false/, /prewalk:[\s\S]*enabled:\s*false/, /auto:\s*"?off"?/, /defaultLimit:\s*1000/, /todo:[\s\S]*eager:\s*"?default"?/, /summarize:[\s\S]*enabled:\s*false/]) {
        if (!needle.test(overlay)) failures.push(`overlay missing ${needle}`);
      }
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ findings, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {}
    console.error('verify-110: FAILED:', err?.stack ?? err);
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
