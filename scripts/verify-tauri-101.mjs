#!/usr/bin/env node
// Live CDP check of the header PR badge follow-ups (#1511, spec 101): subtle pill, no pill tab stop,
// named narrow breakpoint, pinned-panel shell. Reuses the spec 094 fake gh and the recorded-frame fake omp.

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
const SHOTS_DIR = process.env.REFRACT_101_SHOTS_DIR || path.join(tmpdir(), 'refract-101-shots');

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh (#1343).`);
  process.exit(2);
}

const VIEW_PR = `document.querySelector('button[aria-label="View pull request #7"]')`;
const PR_BADGE = `Array.from(document.querySelectorAll('[role="img"]')).find((e) => /^Pull request #7/.test(e.getAttribute('aria-label') || ''))`;
const PANEL = `document.querySelector('[data-right-pane-content]')`;

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
  log(`verify-tauri-101: git HEAD under test: ${head}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-101-data-');
    const importDir = scratch('refract-101-import-');
    const shimDir = scratch('refract-101-shim-');
    const launcherDir = scratch('refract-101-launcher-');
    const exeDir = scratch('refract-101-exe-');
    const repoParent = scratch('refract-101-repo-');

    buildOmpShim(shimDir);
    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-094-fake-gh.rs'), '-o', path.join(shimDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);

    const dir = makeScratchRepo(path.join(repoParent, 'hello-world'), 'repo101-hello-world');
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/octocat/hello-world.git'], { windowsHide: true });

    const launcherExe = buildLauncher(launcherDir);
    const { dest: exePath } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-101' });
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port, dataDir, importSourceDir: importDir, pathPrepend: shimDir, logFile: path.join(SHOTS_DIR, 'app-run.log'),
      extraEnv: {
        FAKE_GH_LOG: path.join(shimDir, 'gh-calls.log'),
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    await addRepository(cdp, path.join(repoParent, 'hello-world'));
    await createSessionViaQuickCreate(cdp, 'hello-world');
    await cdp.waitFor(`!!(${VIEW_PR})`, { timeoutMs: 60_000, label: 'View PR button' });

    check(await cdp.evaluate(`!!(${PR_BADGE})`), 'PR badge renders with an accessible name', await cdp.evaluate(`(${PR_BADGE})?.getAttribute('aria-label')`));
    check(await cdp.evaluate(`(${PR_BADGE})?.getAttribute('tabindex') === null && (${PR_BADGE})?.parentElement?.getAttribute('tabindex') === null`), 'PR badge is not a tab stop');
    check(await cdp.evaluate(`(() => { const b = ${PR_BADGE}; return !!b && getComputedStyle(b).borderTopWidth !== '0px'; })()`), 'PR badge uses the subtle outlined variant');
    await shot(cdp, '01-header-wide.png');

    await cdp.click(VIEW_PR);
    await cdp.waitFor(`document.body.textContent.includes('Description for pull request #7.')`, { timeoutMs: 20_000, label: 'pinned PR detail' });
    check(await cdp.evaluate(`!!(${PANEL})`), 'Pinned panel renders inside the shared shell');
    check(!(await cdp.evaluate(`document.body.textContent.includes('From another session')`)), 'No cross-session note for the owning session');
    await shot(cdp, '02-pinned-panel.png');

    await cdp.evaluate(`window.resizeTo && window.resizeTo(620, 800)`);
    await new Promise((r) => setTimeout(r, 800));
    await shot(cdp, '03-header-narrow.png');
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-101');
  }
  const report = { gitHead: head, result: failures.length === 0 ? 'PASS' : 'FAIL', failures, steps, screenshots: shots };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
