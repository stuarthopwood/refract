#!/usr/bin/env node
// Live CDP check of the Issues page and GitHub tools block (#504), isolated from real app data.
// A fake `gh` on PATH keeps it off GitHub; aborts if the managed gh.exe exists, since resolve_gh() prefers it (#1343).

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
const SHOTS_DIR = process.env.REFRACT_504_SHOTS_DIR || path.join(tmpdir(), 'refract-504-shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const ROWS = `Array.from(document.querySelectorAll('[data-issue-row]')).map((el) => el.getAttribute('data-issue-repo').split('/')[1] + '#' + el.getAttribute('data-issue-number')).sort()`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const pass = (name, detail) => log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  const fail = (name, detail) => { failures.push(name); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); log(`SCREENSHOT ${file}`); };
  log(`verify-tauri-504: git HEAD under test: ${gitHead(REPO_ROOT)}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-504-data-');
    const importDir = scratch('refract-504-import-');
    const shimDir = scratch('refract-504-launcher-');
    const exeDir = scratch('refract-504-exe-');
    const ghDir = scratch('refract-504-gh-');
    const repoParent = scratch('refract-504-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-504-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = ghLog;

    for (const [name, id] of [['hello-world', 'repo504a'], ['spoon-knife', 'repo504b']]) {
      const dir = makeScratchRepo(path.join(repoParent, name), id);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${name}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-504' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-504: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready' });
    await addRepository(cdp, path.join(repoParent, 'hello-world'));
    await addRepository(cdp, path.join(repoParent, 'spoon-knife'));
    pass('Added two scratch repositories with github.com origins');

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
    // The tab strip scrolls horizontally in the narrow list pane; scroll the tab into view first.
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

    await cdp.waitFor(`!!document.querySelector('[role="group"][aria-label="Views"]')`, { timeoutMs: 20_000, label: 'GitHub nav group' });
    const group = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).map((el) => el.textContent.trim().replace(/\\s+/g, ' '))`);
    await shot(cdp, '01-github-nav-block.png');
    check(group.some((t) => t.startsWith('Pull requests')) && group.includes('Issues') && !!(await cdp.evaluate(`!!document.querySelector('[aria-label="Sessions"] [role="group"][aria-label="Views"]')`)), 'GitHub tools block shows Pull requests and Issues inside the Sessions nav', JSON.stringify(group));

    await cdp.click(`Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).find((el) => el.textContent.trim() === 'Issues')`);
    await cdp.waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Issues'`, { timeoutMs: 10_000, label: 'Issues heading' });
    check(await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'open issues from both repos'), 'Issues page lists open issues from two repositories', 'hello-world#12, #20; spoon-knife#3, #5');
    check(await cdp.evaluate(`document.querySelector('[role="group"][aria-label="Views"] button[aria-current="page"]')?.textContent.trim() === 'Issues'`), 'Issues nav item is aria-current="page"');
    await shot(cdp, '02-issues-two-repos.png');

    // #1740: hello-world#12 has four labels, so its "+2" overflow chip lists docs and p1; #20 has one label and no chip.
    const CHIP = `document.querySelector('[data-issue-row][data-issue-number="12"]').parentElement.querySelector('button[aria-label^="+2 more labels"]')`;
    const tooltipText = `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map((el) => el.textContent.trim().replace(/\\s+/g, ' ')).join('|')`;
    const chip = await cdp.evaluate(`(() => { const el = ${CHIP}; return el && { label: el.getAttribute('aria-label'), text: el.textContent.trim(), tabIndex: el.tabIndex }; })()`);
    check(chip && chip.label === '+2 more labels: docs, p1' && chip.text === '+2' && chip.tabIndex === 0, 'Overflow "+2" is a focusable button named "+2 more labels: docs, p1"', JSON.stringify(chip));
    check(await cdp.evaluate(`!document.querySelector('[data-issue-row][data-issue-number="20"]').parentElement.querySelector('button[aria-label*="more label"]')`), 'A row with one label renders no overflow chip');
    const chipCentre = await cdp.evaluate(`(() => { const r = ${CHIP}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chipCentre.x, y: chipCentre.y });
    await cdp.waitFor(`${tooltipText}.includes('docs') && ${tooltipText}.includes('p1')`, { timeoutMs: 10_000, label: 'hover tooltip' });
    check(true, 'Hovering "+2" shows the hidden labels in the tooltip', await cdp.evaluate(tooltipText));
    await shot(cdp, '02a-overflow-hover.png');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await pressEscape();
    await cdp.waitFor(`${tooltipText} === ''`, { timeoutMs: 10_000, label: 'hover tooltip closed' });
    await cdp.evaluate(`document.querySelector('[data-issue-row][data-issue-number="12"]').focus()`);
    let reached = false;
    for (let i = 0; i < 4 && !reached; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      reached = await cdp.evaluate(`document.activeElement === ${CHIP}`);
    }
    check(reached, 'Tab from the row title reaches the "+2" chip');
    await cdp.waitFor(`${tooltipText}.includes('docs') && ${tooltipText}.includes('p1')`, { timeoutMs: 10_000, label: 'focus tooltip' });
    check(true, 'Focusing "+2" shows the hidden labels in the tooltip', await cdp.evaluate(tooltipText));
    await shot(cdp, '02b-overflow-focus.png');
    await cdp.evaluate(`document.activeElement.blur()`);

    await clickTab('Assigned to me');
    check(await rowsAre(['hello-world#12', 'spoon-knife#5'], 'assigned'), 'Tab "Assigned to me"', 'hello-world#12, spoon-knife#5');
    await shot(cdp, '03-tab-assigned.png');
    await clickTab('Authored by me');
    check(await rowsAre(['hello-world#12', 'spoon-knife#3'], 'authored'), 'Tab "Authored by me"', 'hello-world#12, spoon-knife#3');
    await clickTab('Mentions me');
    check(await rowsAre(['hello-world#20'], 'mentions'), 'Tab "Mentions me"', 'hello-world#20');
    await clickTab('All');
    await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'back to all');

    await cdp.click(`document.querySelector('button[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.querySelector('#issue-filters-panel')`, { timeoutMs: 5_000, label: 'filters panel' });
    await pickSelect('State', 'Any state');
    check(await rowsAre(['hello-world#12', 'hello-world#20', 'hello-world#7', 'spoon-knife#3', 'spoon-knife#5'], 'any state'), 'State filter "Any state" adds the closed issue', 'hello-world#7 appears');
    await shot(cdp, '04-filter-state-any.png');
    await pickSelect('State', 'Closed');
    check(await rowsAre(['hello-world#7'], 'closed'), 'State filter "Closed"', 'hello-world#7 only');
    await pickSelect('State', 'Open');
    await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'open again');

    await cdp.click(`document.querySelector('button[aria-label^="Project:"]')`);
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="checkbox"]')).find((el) => el.textContent.trim() === 'spoon-knife')`);
    await pressEscape();
    check(await rowsAre(['spoon-knife#3', 'spoon-knife#5'], 'project'), 'Project filter limited to spoon-knife', 'spoon-knife#3, #5');
    check(await cdp.evaluate(`document.querySelector('button[aria-label^="Filters"]').getAttribute('aria-label').includes('1 active')`), 'Project filter counts as an active filter', 'Filters, 1 active');
    await shot(cdp, '05-filter-project.png');
    await cdp.click(`document.querySelector('button[aria-label^="Project:"]')`);
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="checkbox"]')).find((el) => el.textContent.trim() === 'spoon-knife')`);
    await pressEscape();
    await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'project cleared');

    await cdp.click(`document.querySelector('button[aria-label^="Label:"]')`);
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="checkbox"]')).find((el) => el.textContent.trim() === 'bug')`);
    await pressEscape();
    check(await rowsAre(['hello-world#12', 'spoon-knife#5'], 'label'), 'Label filter "bug"', 'hello-world#12, spoon-knife#5');
    await shot(cdp, '06-filter-label.png');
    await cdp.click(`document.querySelector('button[aria-label="Remove label filter bug"]')`);
    await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'label cleared');

    // Search applies on Enter
    await cdp.click(`document.querySelector('input[aria-label="Search issues"]')`);
    await cdp.send('Input.insertText', { text: 'spoon' });
    await cdp.pressEnter();
    check(await rowsAre(['spoon-knife#3'], 'search'), 'Search "spoon" applied on Enter', 'spoon-knife#3 only');
    await shot(cdp, '07-search.png');

    await cdp.evaluate(`void 0`);
    await cdp.click(`document.querySelector('input[aria-label="Search issues"]')`);
    await cdp.send('Input.insertText', { text: ' zzz-no-match' });
    await cdp.pressEnter();
    await cdp.waitFor(`document.body.textContent.includes('No issues match these filters.')`, { timeoutMs: 15_000, label: 'empty state' });
    await shot(cdp, '08-no-match.png');
    await cdp.clickByText('Clear filters');
    check(await rowsAre(['hello-world#12', 'hello-world#20', 'spoon-knife#3', 'spoon-knife#5'], 'cleared'), 'Clear filters restores the full list', 'four open issues');

    await cdp.click(`document.querySelector('[data-issue-row][data-issue-repo="octocat/hello-world"][data-issue-number="12"]')`);
    await cdp.waitFor(`document.body.textContent.includes('Body of issue 12')`, { timeoutMs: 15_000, label: 'detail body' });
    const detail = await cdp.evaluate(`(() => { const a = document.querySelector('[data-open-on-github]'); return { href: a && a.href, rel: a && a.rel, strong: !!Array.from(document.querySelectorAll('strong')).find((el) => el.textContent === 'markdown'), rawB: !!Array.from(document.querySelectorAll('b')).find((el) => el.textContent === 'raw html') }; })()`);
    check(detail.href === 'https://github.com/octocat/hello-world/issues/12' && detail.rel.includes('noopener') && detail.strong && !detail.rawB, 'Detail pane renders Markdown, drops raw HTML, and links Open on GitHub safely', JSON.stringify(detail));
    await shot(cdp, '09-detail.png');

    const calls = readFileSync(ghLog, 'utf8');
    const listCalls = calls.split('\n').filter((line) => line.includes('"issue", "list"'));
    check(
      listCalls.length > 0 && listCalls.every((l) => l.includes('"--repo"') && l.includes('"--json"')) &&
        calls.includes('"--assignee=@me"') && calls.includes('"--author=@me"') && calls.includes('"--mention=@me"') && calls.includes('label:\\"bug\\"') && calls.includes('"--search=spoon"'),
      'Recorded gh calls are argv arrays carrying --repo, --json and the tab, label and search flags',
      `${listCalls.length} issue list calls`
    );
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-504');
  }
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
