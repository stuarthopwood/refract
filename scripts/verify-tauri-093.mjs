#!/usr/bin/env node
// Live CDP check of the Issues and Pull requests follow-ups (#1347, #1361, spec 093), isolated per
// `refract-tauri-live-check-isolation`, with a fake `gh` first on PATH. Aborts if the managed gh exists, since
// resolve_gh() would prefer it over PATH (#1343).

import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
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
const SHOTS_DIR = process.env.REFRACT_093_SHOTS_DIR || path.join(tmpdir(), 'refract-093-shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const ROWS = `Array.from(document.querySelectorAll('[data-pr-row]')).map((el) => el.querySelector('[data-pr-repository]').getAttribute('data-pr-repository').split('/')[1] + '#' + el.getAttribute('data-pr-number')).sort()`;
const OPEN_ALL = ['hello-world#1', 'hello-world#2', 'spoon-knife#4', 'spoon-knife#5'];
const NAV = (label) => `Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const MORE = `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Show more pull requests')`;
const ROW_COUNT = `document.querySelectorAll('[data-pr-row]').length`;

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
  log(`verify-tauri-093: git HEAD under test: ${head}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-093-data-');
    const importDir = scratch('refract-093-import-');
    const shimDir = scratch('refract-093-launcher-');
    const exeDir = scratch('refract-093-exe-');
    const ghDir = scratch('refract-093-gh-');
    const repoParent = scratch('refract-093-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-093-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = ghLog;
    process.env.FAKE_GH_STATE_DIR = ghDir;
    const failFile = path.join(ghDir, 'fail-paging');
    process.env.FAKE_GH_FAIL_FILE = failFile;

    for (const [name, id] of [['hello-world', 'repo093a'], ['spoon-knife', 'repo093b']]) {
      const dir = makeScratchRepo(path.join(repoParent, name), id);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${name}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-093' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-093: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

    const TRIGGER = `(document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project'))`;
    await cdp.waitFor(`!!${TRIGGER} && !${TRIGGER}.disabled`, { timeoutMs: 45_000, label: 'app ready' });
    await addRepository(cdp, path.join(repoParent, 'hello-world'));
    await addRepository(cdp, path.join(repoParent, 'spoon-knife'));
    pass('Added two scratch Projects with github.com origins');

    const calls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n') : []);
    const rowsAre = async (expected, label) => {
      const want = JSON.stringify([...expected].sort());
      try { await cdp.waitFor(`JSON.stringify(${ROWS}) === ${JSON.stringify(want)}`, { timeoutMs: 15_000, label }); return true; } catch { return false; }
    };
    const waitCount = async (n, label) => {
      try { await cdp.waitFor(`${ROW_COUNT} === ${n}`, { timeoutMs: 40_000, label }); return true; } catch { log(`  rows seen: ${await cdp.evaluate(ROW_COUNT)}, wanted ${n}`); return false; }
    };
    const search = async (text) => {
      await cdp.click(`document.querySelector('input[aria-label="Search pull requests"]')`);
      await cdp.evaluate(`document.querySelector('input[aria-label="Search pull requests"]').select()`);
      await cdp.send('Input.insertText', { text });
      await cdp.pressEnter();
    };
    const pressMore = async () => {
      await cdp.waitFor(`!!(${MORE}) && (${MORE}).getAttribute('aria-disabled') !== 'true'`, { timeoutMs: 20_000, label: 'Show more idle' });
      await cdp.evaluate(`(${MORE}).focus()`);
      await cdp.pressEnter();
    };

    // 1. #1361 item 1: the sidebar count is cross-Project and arrives before the view is opened.
    await cdp.waitFor(`!!${NAV('Pull requests')}`, { timeoutMs: 20_000, label: 'GitHub nav group' });
    let badge = '';
    try {
      await cdp.waitFor(`${NAV('Pull requests')}.getAttribute('aria-label') === 'Pull requests, 4 active'`, { timeoutMs: 30_000, label: 'sidebar count' });
    } catch { /* reported below */ }
    badge = await cdp.evaluate(`${NAV('Pull requests')}.getAttribute('aria-label')`);
    const beforeView = calls().filter((l) => l.includes('"search", "prs"'));
    check(badge === 'Pull requests, 4 active', 'Sidebar badge counts open pull requests across both Projects before the view is opened', badge);
    check(beforeView.length === 1 && beforeView[0].includes('"octocat/hello-world"') && beforeView[0].includes('"octocat/spoon-knife"'), 'One cross-Project search fed the badge', `${beforeView.length} search call(s)`);
    await shot(cdp, '01-sidebar-count.png');

    // 2. #1361 item 4: the list issues no per-row gh pr view; detail loads for the selected row only.
    await cdp.click(NAV('Pull requests'));
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Pull requests'`, { timeoutMs: 10_000, label: 'Pull requests heading' });
    check(await rowsAre(OPEN_ALL, 'open pull requests'), 'Pull requests view lists the four open pull requests', OPEN_ALL.join(', '));
    await sleep(1500);
    check(calls().filter((l) => l.includes('"pr", "view"')).length === 0, 'No gh pr view call while only the list is shown');
    check(await cdp.evaluate(`!/Checks (passed|failed|running)|No checks/.test(document.querySelector('[data-pr-row]').textContent)`), 'List rows carry no check segment');
    await shot(cdp, '02-list-no-row-detail.png');
    await cdp.click(`Array.from(document.querySelectorAll('[data-pr-row]')).find((el) => el.getAttribute('data-pr-number') === '1')`);
    await cdp.waitFor(`document.body.textContent.includes('Description for pull request #1.')`, { timeoutMs: 15_000, label: 'detail body' });
    const views = calls().filter((l) => l.includes('"pr", "view"'));
    check(views.length > 0 && views.every((l) => l.includes('"1"')), 'Selecting a row loads detail for that row only', `${views.length} pr view call(s), all for #1`);
    await shot(cdp, '03-selected-row-detail.png');

    // 3. #1361 item 2: the Project filter is visible in the Filters panel.
    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.querySelector('#pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'filters panel' });
    check(await cdp.evaluate(`!!document.querySelector('button[aria-label^="Project:"]')`), 'Project filter is visible in the Filters panel');
    await shot(cdp, '04-project-filter-visible.png');
    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);

    // 4. #1361 items 3, 8: the failed-Show-more alert reads with a full stop; the cap note shows when more than the cap exists.
    await search('bulk');
    check(await waitCount(50, 'first page'), 'Search "bulk" lists the first page', '50 rows');
    writeFileSync(failFile, 'fail');
    await pressMore();
    await cdp.waitFor(`Array.from(document.querySelectorAll('[role="alert"]')).some((el) => /\\. Try Show more again\\./.test(el.textContent))`, { timeoutMs: 20_000, label: 'inline failure alert' });
    pass('Failed Show more alert has a full stop before "Try Show more again."');
    await shot(cdp, '05-show-more-alert-full-stop.png');
    unlinkSync(failFile);
    for (const n of [100, 150, 200]) { await pressMore(); check(await waitCount(n, `page ${n}`), `Show more reaches ${n} rows`); }
    await cdp.waitFor(`document.body.textContent.includes('Showing the first 200')`, { timeoutMs: 20_000, label: 'cap note' });
    pass('Cap note shows when the fetch returned more than the cap (300 available)');
    await shot(cdp, '06-cap-note-when-truncated.png');

    // 5. Exactly 200 results: no cap note, no Show more button.
    await search('exact');
    check(await waitCount(50, 'exact first page'), 'Search "exact" lists the first page', '50 rows');
    for (const n of [100, 150, 200]) { await pressMore(); await waitCount(n, `exact page ${n}`); }
    await sleep(1000);
    check(await cdp.evaluate(`!document.body.textContent.includes('Showing the first 200') && !(${MORE})`), 'Exactly 200 results show no cap note and no Show more button');
    await shot(cdp, '07-exactly-200-no-cap-note.png');

    // 6. #1361 item 6: Refresh restores the paging state (rows still listed, Show more not stuck).
    await search('bulk');
    await waitCount(50, 'bulk again');
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => /^Refresh/.test(el.getAttribute('aria-label') ?? ''))`);
    check(await waitCount(50, 'after refresh') && await cdp.evaluate(`!!(${MORE})`), 'Refresh keeps the list on its first page with Show more offered');

    // 7. #1347 items 3, 4: Report an issue keeps its title; New issue is titled "New issue" and selects the created issue.
    await cdp.click(NAV('Issues'));
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Issues'`, { timeoutMs: 10_000, label: 'Issues heading' });
    await cdp.clickByText('New issue');
    await cdp.waitFor(`!!document.querySelector('#report-issue-title')`, { timeoutMs: 10_000, label: 'New issue dialog' });
    check(await cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('New issue') && !document.querySelector('[role="dialog"]').textContent.includes('Report an issue')`), 'Issues page dialog is titled "New issue"');
    await cdp.click(`document.querySelector('#report-issue-title')`);
    await cdp.send('Input.insertText', { text: 'Created by live check' });
    await shot(cdp, '08-new-issue-dialog.png');
    await cdp.clickByText('Create issue', { inDialog: true });
    await cdp.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('#99')`, { timeoutMs: 20_000, label: 'created panel' });
    await cdp.clickByText('Close', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'dialog closed' });
    await cdp.waitFor(`document.querySelector('[data-issue-row][data-issue-number="99"]')?.getAttribute('aria-current') === 'true'`, { timeoutMs: 20_000, label: 'created issue selected' });
    pass('After create the list refreshes and the new issue is selected', '#99 aria-current');
    await shot(cdp, '09-created-issue-selected.png');

  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-093');
  }
  const report = { gitHead: head, result: failures.length === 0 ? 'PASS' : 'FAIL', failures, steps, screenshots: shots };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
