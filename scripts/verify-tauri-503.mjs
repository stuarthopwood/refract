#!/usr/bin/env node
// Live CDP check for issue #503 (Report an issue, spec 049). Drives the real Tauri debug build,
// isolated per the `refract-tauri-live-check-isolation` skill (own REFRACT_DATA_DIR, WebView2
// profile and import dir; never %APPDATA%/refract-tauri). A fake `gh` (verify-tauri-503-fake-gh.rs)
// is put first on PATH and records every call's argv and stdin, so no real issue is ever filed.
// Checks: the repository menu item, the dialog, empty-title validation (nothing recorded), the
// duplicate disclosure, a label pick, and the recorded `gh issue create` call.

import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, assertExeMatchesProcess, createReportLogger } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, makeScratchRepo, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_503_SHOTS_DIR || path.join(tmpdir(), 'refract-503-shots');
const TITLE = 'Crash when saving a draft on exit';
const BODY = 'Steps: open a draft, press Ctrl+S, close the window.\nObserved: the app exits without saving.';

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const pass = (name, detail) => log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  const fail = (name, detail) => { failures.push(name); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); log(`SCREENSHOT ${file}`); };
  log(`verify-tauri-503: git HEAD under test: ${gitHead(REPO_ROOT)}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-503-data-');
    const importDir = scratch('refract-503-import-');
    const shimDir = scratch('refract-503-launcher-');
    const exeDir = scratch('refract-503-exe-');
    const ghDir = scratch('refract-503-gh-');
    const repoParent = scratch('refract-503-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-503-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = ghLog;

    const repoDir = makeScratchRepo(path.join(repoParent, 'hello-world'), 'repo503');
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/octocat/hello-world.git'], { windowsHide: true });

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-503' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-503: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready' });
    await addRepository(cdp, repoDir);
    const triggerSel = `document.querySelector('[aria-label="Project actions for hello-world"]')`;
    await cdp.waitFor(`!!${triggerSel}`, { timeoutMs: 20_000, label: 'repository actions trigger' });
    pass('Added scratch repository with a github.com origin');

    // A newly added repository's remote is detected on the next window-focus sweep (5 s throttle),
    // so wait it out and fire a focus event, exactly what a real user's alt-tab does.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const rect = await cdp.evaluate(`(() => { const r = ${triggerSel}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdp.click(triggerSel);
    const itemSel = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'GitHub report…')`;
    await cdp.waitFor(`!!${itemSel}`, { timeoutMs: 10_000, label: 'Report an issue menu item' });
    await shot(cdp, '01-menu-item.png');
    pass('Repository menu shows "Report an issue…"');

    await cdp.click(itemSel);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] #report-issue-title')`, { timeoutMs: 10_000, label: 'dialog open' });
    const header = await cdp.evaluate(`document.querySelector('[role="dialog"]').textContent`);
    check(header.includes('Report an issue') && header.includes('octocat/hello-world') && header.includes('@octotest'), 'Dialog opens scoped to octocat/hello-world as @octotest');
    await shot(cdp, '02-dialog.png');

    await cdp.clickByText('Create issue', { inDialog: true });
    await cdp.waitFor(`document.querySelector('[role="dialog"]').textContent.includes('Enter a title.')`, { timeoutMs: 5_000, label: 'title validation' });
    const focusId = await cdp.evaluate(`document.activeElement && document.activeElement.id`);
    const createdEarly = existsSync(ghLog) && readFileSync(ghLog, 'utf8').includes('"issue", "create"');
    check(focusId === 'report-issue-title' && !createdEarly, 'Empty title shows "Enter a title.", focuses Title, files nothing', `activeElement=${focusId}`);
    await shot(cdp, '03-validation.png');

    await cdp.click(`document.querySelector('#report-issue-title')`);
    await cdp.send('Input.insertText', { text: TITLE });
    await cdp.waitFor(`document.querySelector('[role="dialog"]').textContent.includes('2 possible duplicates')`, { timeoutMs: 10_000, label: 'duplicates disclosure' });
    pass('Typing a title shows "2 possible duplicates" (from the fake gh)');

    await cdp.click(`document.querySelector('[role="dialog"] textarea')`);
    await cdp.send('Input.insertText', { text: BODY });
    await cdp.clickByText('Add labels', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[role="checkbox"]')`, { timeoutMs: 5_000, label: 'label checklist' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="checkbox"]')).find((el) => el.textContent.trim() === 'bug')`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').textContent.includes('bug') && !document.querySelector('[role="checkbox"]')`, { timeoutMs: 5_000, label: 'label chip shown, popover closed' });
    await shot(cdp, '04-filled.png');
    pass('Filled Title, Description and the "bug" label');

    await cdp.clickByText('Create issue', { inDialog: true });
    await cdp.waitFor(`document.querySelector('[role="dialog"]').textContent.includes('Issue #99 created')`, { timeoutMs: 15_000, label: 'created panel' });
    await shot(cdp, '05-created.png');
    pass('Created panel shows "Issue #99 created"');

    const lines = readFileSync(ghLog, 'utf8').split('\n').filter((line) => line.includes('"issue", "create"'));
    log(`RECORDED gh issue create call(s): ${JSON.stringify(lines)}`);
    const line = lines[0] ?? '';
    check(
      lines.length === 1 && line.includes('"--repo", "octocat/hello-world"') && line.includes(`"--title=${TITLE}"`) && line.includes('"--label=bug"') && line.includes('"--body-file", "-"') && line.includes('Steps: open a draft'),
      'Exactly one recorded gh issue create with --repo, --title=, --label=, --body-file - and the body on stdin'
    );
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-503');
  }
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
