#!/usr/bin/env node
// Live CDP check for issue #874 (cross-Project Pull requests view on the shared list shell, spec
// 057). Drives the real Tauri debug build, isolated per the `refract-tauri-live-check-isolation`
// skill (own REFRACT_DATA_DIR, WebView2 profile and import dir; never %APPDATA%/refract-tauri). A
// fake `gh` (verify-tauri-874-fake-gh.rs) is put first on PATH, so nothing here can reach GitHub.
// Aborts if the managed gh at %LOCALAPPDATA%\refract\tools\gh\gh.exe exists, because resolve_gh()
// would prefer it over PATH (#1343). Four Projects: two point at the SAME GitHub repository (must
// list once), one at a second repository, one with no GitHub remote (skipped note).
// Checks: the Pull requests view listing both repositories once each, the skipped note, every tab,
// the State and Project filters, search, the empty state, the detail pane with its Review actions,
// the recorded gh calls, and the Issues view still working on the same shell.

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
const SHOTS_DIR = process.env.REFRACT_874_SHOTS_DIR || path.join(tmpdir(), 'refract-874-shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const ROWS = `Array.from(document.querySelectorAll('[data-pr-row]')).map((el) => el.getAttribute('data-pr-repository').split('/')[1] + '#' + el.getAttribute('data-pr-number')).sort()`;
const OPEN_ALL = ['hello-world#1', 'hello-world#2', 'spoon-knife#4', 'spoon-knife#5'];

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const pass = (name, detail) => log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  const fail = (name, detail) => { failures.push(name); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); log(`SCREENSHOT ${file}`); };
  log(`verify-tauri-874: git HEAD under test: ${gitHead(REPO_ROOT)}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-874-data-');
    const importDir = scratch('refract-874-import-');
    const shimDir = scratch('refract-874-launcher-');
    const exeDir = scratch('refract-874-exe-');
    const ghDir = scratch('refract-874-gh-');
    const repoParent = scratch('refract-874-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-874-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = ghLog;

    const projects = [
      ['hello-world', 'repo874a', 'hello-world'],
      ['hello-world-copy', 'repo874b', 'hello-world'],
      ['spoon-knife', 'repo874c', 'spoon-knife'],
      ['local-only', 'repo874d', null]
    ];
    for (const [name, id, remote] of projects) {
      const dir = makeScratchRepo(path.join(repoParent, name), id);
      if (remote) spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${remote}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-874' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-874: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready' });
    for (const [name] of projects) await addRepository(cdp, path.join(repoParent, name));
    pass('Added four scratch Projects (two share one GitHub repository, one has no remote)');

    const rowsAre = async (expected, label) => {
      const want = JSON.stringify([...expected].sort());
      try {
        await cdp.waitFor(`JSON.stringify(${ROWS}) === ${JSON.stringify(want)}`, { timeoutMs: 15_000, label });
        return true;
      } catch {
        log(`  rows seen: ${JSON.stringify(await cdp.evaluate(ROWS))}, wanted ${want}`);
        return false;
      }
    };
    const clickTab = async (name) => {
      const find = `Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === ${JSON.stringify(name)})`;
      await cdp.waitFor(`!!(${find})`, { timeoutMs: 10_000, label: `tab ${name}` });
      await cdp.evaluate(`(${find}).scrollIntoView({ inline: 'center', block: 'nearest' })`);
      await sleep(300);
      await cdp.click(find);
    };
    const pickSelect = async (triggerLabel, optionText) => {
      await cdp.clickByLabel(triggerLabel);
      await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === ${JSON.stringify(optionText)})`);
    };
    const pressEscape = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    };
    const toggleProject = async (name) => {
      await cdp.click(`document.querySelector('button[aria-label^="Project:"]')`);
      await cdp.click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="checkbox"]')).find((el) => el.textContent.trim() === ${JSON.stringify(name)})`);
      await pressEscape();
    };

    // 1. Open the view; both repositories listed, the shared repository once.
    await cdp.waitFor(`!!document.querySelector('[role="group"][aria-label="GitHub"]')`, { timeoutMs: 20_000, label: 'GitHub nav group' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="group"][aria-label="GitHub"] button')).find((el) => el.textContent.trim().startsWith('Pull requests'))`);
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Pull requests'`, { timeoutMs: 10_000, label: 'Pull requests heading' });
    check(await rowsAre(OPEN_ALL, 'open pull requests'), 'Pull requests view lists open pull requests from two repositories, the shared one once', OPEN_ALL.join(', '));
    check(await cdp.evaluate(`document.querySelector('[role="group"][aria-label="GitHub"] button[aria-current="page"]')?.textContent.trim().startsWith('Pull requests')`), 'Pull requests nav item is aria-current="page"');
    await shot(cdp, '01-two-projects-listed.png');

    // 2. Skipped note for the Project with no GitHub repository.
    await cdp.waitFor(`document.body.textContent.includes('1 project skipped')`, { timeoutMs: 10_000, label: 'skipped note' });
    await cdp.clickByText('1 project skipped');
    await cdp.waitFor(`document.body.textContent.includes('local-only')`, { timeoutMs: 5_000, label: 'skipped detail' });
    pass('A Project with no GitHub repository shows in the skipped note', 'local-only');
    await shot(cdp, '02-skipped-project-note.png');

    // 3. Tabs
    await clickTab('Authored by me');
    check(await rowsAre(['hello-world#1'], 'authored'), 'Tab "Authored by me"', 'hello-world#1');
    await shot(cdp, '03-tab-authored.png');
    await clickTab('Assigned to me');
    check(await rowsAre(['hello-world#1', 'spoon-knife#4'], 'assigned'), 'Tab "Assigned to me"', 'hello-world#1, spoon-knife#4');
    await clickTab('Involves me');
    check(await rowsAre(OPEN_ALL, 'involves'), 'Tab "Involves me"', OPEN_ALL.join(', '));
    await clickTab('Review requested');
    check(await rowsAre(['hello-world#2', 'spoon-knife#5'], 'review requested'), 'Tab "Review requested"', 'hello-world#2, spoon-knife#5');
    await shot(cdp, '04-tab-review-requested.png');
    await clickTab('All');
    await rowsAre(OPEN_ALL, 'back to all');

    // 4. Filters
    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.querySelector('#pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'filters panel' });
    await pickSelect('State', 'Any state');
    check(await rowsAre([...OPEN_ALL, 'hello-world#3'], 'any state'), 'State filter "Any state" adds the closed pull request', 'hello-world#3 appears');
    await shot(cdp, '05-filter-state-any.png');
    await pickSelect('State', 'Closed');
    check(await rowsAre(['hello-world#3'], 'closed'), 'State filter "Closed"', 'hello-world#3 only');
    await pickSelect('State', 'Open');
    await rowsAre(OPEN_ALL, 'open again');

    await toggleProject('spoon-knife');
    check(await rowsAre(['hello-world#1', 'hello-world#2'], 'project filter'), 'Project filter limits the list to the selected Projects', 'hello-world#1, #2');
    check(await cdp.evaluate(`document.querySelector('button[aria-label^="Filters"]').getAttribute('aria-label').includes('1 active')`), 'Project filter counts as an active filter', 'Filters, 1 active');
    await shot(cdp, '06-filter-project.png');
    await toggleProject('spoon-knife');
    await rowsAre(OPEN_ALL, 'project cleared');

    // 5. Search (applies on Enter)
    await cdp.click(`document.querySelector('input[aria-label="Search pull requests"]')`);
    await cdp.send('Input.insertText', { text: 'spoon' });
    await cdp.pressEnter();
    check(await rowsAre(['spoon-knife#4'], 'search'), 'Search "spoon" applied on Enter', 'spoon-knife#4 only');
    await shot(cdp, '07-search.png');

    // 6. Shared empty state and Clear filters
    await cdp.click(`document.querySelector('input[aria-label="Search pull requests"]')`);
    await cdp.send('Input.insertText', { text: ' zzz-no-match' });
    await cdp.pressEnter();
    await cdp.waitFor(`document.body.textContent.includes('No pull requests match these filters.')`, { timeoutMs: 15_000, label: 'empty state' });
    await shot(cdp, '08-empty-state.png');
    await cdp.clickByText('Clear filters');
    check(await rowsAre(OPEN_ALL, 'cleared'), 'Clear filters restores the full list', 'four open pull requests');

    // 7. Detail pane with the Review actions
    await cdp.click(`document.querySelector('[data-pr-row][data-pr-repository="octocat/hello-world"][data-pr-number="1"]')`);
    await cdp.waitFor(`document.body.textContent.includes('Description for pull request #1.')`, { timeoutMs: 15_000, label: 'detail body' });
    const actions = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).map((el) => el.textContent.trim()).filter((t) => /review|approve|merge|request changes/i.test(t))`);
    check(actions.length > 0, 'Detail pane shows its Review actions', JSON.stringify(actions));
    await shot(cdp, '09-detail-review-actions.png');

    // 8. What gh was actually asked
    const calls = readFileSync(ghLog, 'utf8');
    const searches = calls.split('\n').filter((line) => line.includes('"search", "prs"'));
    const dupSlug = searches.some((l) => (l.match(/"octocat\/hello-world"/g) || []).length > 1);
    check(
      searches.length > 0 && !dupSlug && searches.every((l) => l.includes('"--json"')) &&
        searches.some((l) => l.includes('"octocat/hello-world"') && l.includes('"octocat/spoon-knife"')) &&
        calls.includes('"rate_limit"') && calls.includes('"--author"') && calls.includes('"--review-requested"'),
      'Recorded gh calls: one search with a --repo per distinct repository (no duplicates), the rate-limit probe, and the tab flags',
      `${searches.length} search calls`
    );

    // 9. Issues still works on the shared shell
    await cdp.click(`Array.from(document.querySelectorAll('[role="group"][aria-label="GitHub"] button')).find((el) => el.textContent.trim() === 'Issues')`);
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Issues'`, { timeoutMs: 10_000, label: 'Issues heading' });
    await cdp.waitFor(`document.body.textContent.includes('No issues match these filters.')`, { timeoutMs: 15_000, label: 'issues empty state' });
    check(await cdp.evaluate(`!!document.querySelector('button[aria-label^="Filters"]')`), 'Issues view renders on the shared shell', 'heading, Filters toggle, shared empty state');
    await shot(cdp, '10-issues-still-works.png');
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-874');
  }
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
