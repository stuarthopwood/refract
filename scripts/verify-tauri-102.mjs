#!/usr/bin/env node
// Live CDP check of the Issues list follow-ups (#1508, spec 102): sidebar badge scope and sharing,
// Show more focus and the exact-200 cap note, and New issue clearing hiding filters. Isolated per
// `refract-tauri-live-check-isolation`, with the spec 093 fake `gh` first on PATH. Aborts if the managed gh exists, since
// resolve_gh() would prefer it over PATH (#1343).

import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
const SHOTS_DIR = process.env.REFRACT_102_SHOTS_DIR || path.join(tmpdir(), 'refract-102-shots');
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
  log(`verify-tauri-102: git HEAD under test: ${head}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-102-data-');
    const importDir = scratch('refract-102-import-');
    const shimDir = scratch('refract-102-launcher-');
    const exeDir = scratch('refract-102-exe-');
    const ghDir = scratch('refract-102-gh-');
    const repoParent = scratch('refract-102-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-093-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = ghLog;
    process.env.FAKE_GH_STATE_DIR = ghDir;

    for (const [name, id] of [['hello-world', 'repo102a'], ['spoon-knife', 'repo102b']]) {
      const dir = makeScratchRepo(path.join(repoParent, name), id);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${name}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-102' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-102: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

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
    const BADGE = 'Pull requests, 4 open pull requests across your Projects';
    try {
      await cdp.waitFor(`${NAV('Pull requests')}.getAttribute('aria-label') === ${JSON.stringify(BADGE)}`, { timeoutMs: 30_000, label: 'sidebar count' });
    } catch { /* reported below */ }
    badge = await cdp.evaluate(`${NAV('Pull requests')}.getAttribute('aria-label')`);
    const searchCalls = () => calls().filter((l) => l.includes('"search", "prs"'));
    const beforeView = searchCalls();
    check(badge === BADGE, 'Sidebar badge names its scope and counts open pull requests across both Projects', badge);
    check(await cdp.evaluate(`!${NAV('Pull requests')}.textContent.includes('+')`), 'A complete count carries no "+" cue');
    const bothProjects = (l) => l.includes('"octocat/hello-world"') && l.includes('"octocat/spoon-knife"') && l.includes('201')
    check(beforeView.filter(bothProjects).length === 1, 'Startup fires one badge search for the full Project set, not two', `${beforeView.filter(bothProjects).length} of ${beforeView.length} search call(s)`);
    const lastSearch = beforeView[beforeView.length - 1] ?? '';
    check(bothProjects(lastSearch), 'The search behind the badge spans both Projects in one call');
    await shot(cdp, '01-sidebar-count.png');

    // 2. Opening the view on default filters shares the badge search; Refresh then issues one search, not two.
    await cdp.click(NAV('Pull requests'));
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Pull requests'`, { timeoutMs: 10_000, label: 'Pull requests heading' });
    check(await rowsAre(OPEN_ALL, 'open pull requests'), 'Pull requests view lists the four open pull requests', OPEN_ALL.join(', '));
    await sleep(1500);
    const afterOpen = searchCalls().length;
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => /^Refresh/.test(el.getAttribute('aria-label') ?? ''))`);
    await sleep(2500);
    const refreshCalls = searchCalls().length - afterOpen;
    check(refreshCalls === 1, 'Refresh on default filters issues one search for list and badge', `${refreshCalls} search call(s)`);
    await shot(cdp, '02-refresh-one-search.png');

    // 3. Show more focuses the first newly loaded row; 300 available means the cap note shows at 200.
    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.querySelector('#pull-request-filters-panel')`, { timeoutMs: 5_000, label: 'filters panel' });
    await search('bulk');
    check(await waitCount(50, 'first page'), 'Search "bulk" lists the first page', '50 rows');
    for (const n of [100, 150, 200]) {
      await pressMore();
      check(await waitCount(n, `page ${n}`), `Show more reaches ${n} rows`);
      await sleep(300);
      check(await cdp.evaluate(`document.activeElement === document.querySelectorAll('[data-pr-row]')[${n - 50}]`), `Focus lands on the first newly loaded row (#${n - 49})`);
    }
    await cdp.waitFor(`document.body.textContent.includes('Showing the first 200')`, { timeoutMs: 20_000, label: 'cap note' });
    pass('Cap note shows when more than the cap exists (300 available)');
    await shot(cdp, '03-cap-note-when-truncated.png');

    // 4. Exactly 200 results: the cap note shows, there is no Show more button, and focus is on a new row.
    await search('exact');
    check(await waitCount(50, 'exact first page'), 'Search "exact" lists the first page', '50 rows');
    for (const n of [100, 150, 200]) { await pressMore(); check(await waitCount(n, `exact page ${n}`), `Show more reaches ${n} rows`); }
    await sleep(1000);
    check(await cdp.evaluate(`document.body.textContent.includes('Showing the first 200') && !(${MORE})`), 'Exactly 200 results show the cap note and no Show more button');
    check(await cdp.evaluate(`document.activeElement === document.querySelectorAll('[data-pr-row]')[150]`), 'At exactly 200 focus is on the first row of the last page');
    await shot(cdp, '04-exactly-200-cap-note.png');

    // 5. Refresh restores the paging state (rows still listed, Show more not stuck).
    await search('bulk');
    await waitCount(50, 'bulk again');
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => /^Refresh/.test(el.getAttribute('aria-label') ?? ''))`);
    check(await waitCount(50, 'after refresh') && await cdp.evaluate(`!!(${MORE})`), 'Refresh keeps the list on its first page with Show more offered');

    // 6. New issue clears a filter that would hide it, selects it and focuses its row after the dialog closes.
    await cdp.click(NAV('Issues'));
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Issues'`, { timeoutMs: 10_000, label: 'Issues heading' });
    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.querySelector('input[aria-label="Search issues"]')`, { timeoutMs: 5_000, label: 'issues filters panel' });
    await cdp.click(`document.querySelector('input[aria-label="Search issues"]')`);
    await cdp.send('Input.insertText', { text: 'zzz' });
    await cdp.pressEnter();
    await cdp.waitFor(`document.querySelector('button[aria-label^="Filters"]').getAttribute('aria-label') === 'Filters, 1 active'`, { timeoutMs: 10_000, label: 'search applied' });
    await cdp.clickByText('New issue');
    await cdp.waitFor(`!!document.querySelector('#report-issue-title')`, { timeoutMs: 10_000, label: 'New issue dialog' });
    check(await cdp.evaluate(`document.querySelector('[role="dialog"]').textContent.includes('New issue') && !document.querySelector('[role="dialog"]').textContent.includes('Report an issue')`), 'Issues page dialog is titled "New issue"');
    await cdp.click(`document.querySelector('#report-issue-title')`);
    await cdp.send('Input.insertText', { text: 'Created by live check' });
    await shot(cdp, '05-new-issue-dialog.png');
    await cdp.clickByText('Create issue', { inDialog: true });
    await cdp.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('#99')`, { timeoutMs: 20_000, label: 'created panel' });
    await cdp.clickByText('Close', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'dialog closed' });
    await cdp.waitFor(`document.querySelector('[data-issue-row][data-issue-number="99"]')?.getAttribute('aria-current') === 'true'`, { timeoutMs: 20_000, label: 'created issue selected' });
    pass('After create the new issue is listed and selected', '#99 aria-current');
    check(await cdp.evaluate(`document.querySelector('button[aria-label^="Filters"]').getAttribute('aria-label') === 'Filters'`), 'The hiding search filter was cleared');
    check(await cdp.evaluate(`document.activeElement === document.querySelector('[data-issue-row][data-issue-number="99"]')`), 'Focus is on the new issue row after the dialog closes');
    await shot(cdp, '06-created-issue-focused.png');

  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-102');
  }
  const report = { gitHead: head, result: failures.length === 0 ? 'PASS' : 'FAIL', failures, steps, screenshots: shots };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
