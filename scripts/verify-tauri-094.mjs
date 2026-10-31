#!/usr/bin/env node
// Live CDP check of the chat header PR badge, View PR / View issue buttons and pinned panels (#1315, spec 094),
// isolated per `refract-tauri-live-check-isolation`, with a fake `gh` and the recorded-frame fake `omp` first on PATH.

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, createReportLogger } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, makeScratchRepo, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_094_SHOTS_DIR || path.join(tmpdir(), 'refract-094-shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const VIEW_PR = `document.querySelector('button[aria-label="View pull request #7"]')`;
const VIEW_ISSUE = `Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').startsWith('View issue'))`;
const ISSUE_BADGE = `Array.from(document.querySelectorAll('[role="img"]')).find((e) => (e.getAttribute('aria-label') || '').startsWith('Issue #11'))`;
const CHECKS_ICON = `Array.from(document.querySelectorAll('[role="img"]')).find((e) => e.getAttribute('aria-label') === 'Checks passed')`;
const PANEL = `document.querySelector('[data-right-pane-content]')`;
const MESSAGE_BOX = `document.querySelector('[aria-label="Message"]')`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const steps = [];
  const pass = (name, detail) => { steps.push({ name, ok: true, detail }); log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const fail = (name, detail) => { failures.push(name); steps.push({ name, ok: false, detail }); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shots = [];
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); shots.push(name); log(`SCREENSHOT ${file}`); };
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-094: git HEAD under test: ${head}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-094-data-');
    const importDir = scratch('refract-094-import-');
    const shimDir = scratch('refract-094-shim-');
    const launcherDir = scratch('refract-094-launcher-');
    const exeDir = scratch('refract-094-exe-');
    const repoParent = scratch('refract-094-repo-');
    const ghLog = path.join(shimDir, 'gh-calls.log');

    buildOmpShim(shimDir);
    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-094-fake-gh.rs'), '-o', path.join(shimDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);

    // A saved settings file that still carries the removed pull-request readout kind must load without error.
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      version: 1, approvalMode: 'ask', split: null, theme: 'dark', watermarkEnabled: true,
      sessionReadout: { 'pull-request': true, pullRequest: true, subagents: true }
    }));

    for (const name of ['hello-world', 'spoon-knife']) {
      const dir = makeScratchRepo(path.join(repoParent, name), `repo094-${name}`);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${name}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(launcherDir);
    const { dest: exePath } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-094' });
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port, dataDir, importSourceDir: importDir, pathPrepend: shimDir, logFile: path.join(SHOTS_DIR, 'app-run.log'),
      extraEnv: {
        FAKE_GH_LOG: ghLog,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    pass('App launched with a settings.json that still holds the removed pull-request readout key');

    await addRepository(cdp, path.join(repoParent, 'hello-world'));
    await addRepository(cdp, path.join(repoParent, 'spoon-knife'));
    await createSessionViaQuickCreate(cdp, 'hello-world');

    // 1. The badge, number and checks icon appear with a PR; the accessible names carry the state.
    await cdp.waitFor(`!!(${VIEW_PR})`, { timeoutMs: 60_000, label: 'View PR button' });
    check(await cdp.evaluate(`document.body.textContent.includes('#7')`), 'Header shows the PR number');
    check(await cdp.evaluate(`!!(${CHECKS_ICON})`), 'Checks icon has the accessible name "Checks passed"');
    check(await cdp.evaluate(`(${ISSUE_BADGE})?.getAttribute('aria-label') === 'Issue #11, open, and 1 more'`), 'Issue badge names the first issue, its state and "and 1 more"', await cdp.evaluate(`(${ISSUE_BADGE})?.getAttribute('aria-label')`));
    await shot(cdp, '01-header-badges.png');

    // 2. View PR opens the pinned Pull request panel; Escape-free close returns focus to the button.
    await cdp.click(VIEW_PR);
    await cdp.waitFor(`document.body.textContent.includes('Description for pull request #7.')`, { timeoutMs: 20_000, label: 'pinned PR detail' });
    check(await cdp.evaluate(`document.activeElement === (${PANEL})`), 'Opening View PR moves focus into the panel');
    await shot(cdp, '02-pinned-pull-request-panel.png');
    await cdp.click(`document.querySelector('[data-panel-close]')`);
    await cdp.waitFor(`!document.body.textContent.includes('Description for pull request #7.')`, { timeoutMs: 10_000, label: 'PR panel closed' });
    check(await cdp.evaluate(`document.activeElement === (${VIEW_PR})`), 'Closing the pinned panel returns focus to View PR');

    // 3. View issue offers a menu for two issues; choosing one pins the Issue panel.
    await cdp.click(VIEW_ISSUE);
    await cdp.waitFor(`!!document.querySelector('[role="menuitem"]')`, { timeoutMs: 5_000, label: 'issue menu' });
    check(await cdp.evaluate(`document.querySelectorAll('[role="menuitem"]').length === 2`), 'View issue menu lists both closing issues');
    await shot(cdp, '03-issue-menu.png');
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((e) => e.textContent.includes('#12'))`);
    await cdp.waitFor(`document.body.textContent.includes('Body of issue #12.')`, { timeoutMs: 20_000, label: 'pinned issue detail' });
    await shot(cdp, '04-pinned-issue-panel.png');

    // 4. A Session whose Project has no PR shows no badge and no buttons.
    await createSessionViaQuickCreate(cdp, 'spoon-knife');
    await sleep(2500);
    check(await cdp.evaluate(`!(${VIEW_PR}) && !(${VIEW_ISSUE}) && !(${ISSUE_BADGE})`), 'No badge or buttons when the Session has no pull request');
    check(await cdp.evaluate(`!!(${MESSAGE_BOX})`), 'Chat composer still renders');
    await shot(cdp, '05-no-pr-no-badges.png');
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-094');
  }
  const report = { gitHead: head, result: failures.length === 0 ? 'PASS' : 'FAIL', failures, steps, screenshots: shots };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
