#!/usr/bin/env node
// Live CDP check for issue #869 (the Home view, spec 059). Drives the real Tauri debug build,
// isolated per the `refract-tauri-live-check-isolation` skill (own REFRACT_DATA_DIR, WebView2
// profile and import dir; never %APPDATA%/refract-tauri). A fake `gh` (verify-tauri-869-fake-gh.rs)
// and the fake `omp` shim (scenario `ask`) are put first on PATH, so nothing here can reach GitHub
// or a model. Aborts if the managed gh exists (#1343). Three Projects: two with GitHub remotes and
// one with none. Checks: Home on a launch with no panes, the nav item and badge, every section,
// Refresh plus the error line, Tidy up (Archive, Archive all clean), keyboard focus, and the
// recorded gh calls (always scoped with --repo).

import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, assertExeMatchesProcess, createReportLogger } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, makeScratchRepo, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_869_SHOTS_DIR || path.join(tmpdir(), 'refract-869-shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const TRIGGER = `(document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project'))`;
const section = (title) => `(Array.from(document.querySelectorAll('[role="region"][aria-label="Home"] h2')).find((h) => h.textContent.trim().toLowerCase().startsWith(${JSON.stringify(title.toLowerCase())}))?.closest('section') ?? null)`;
const HOME_NAV = `Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).find((el) => el.getAttribute('aria-label')?.startsWith('Home') || el.textContent.trim().startsWith('Home'))`;
const cards = (id) => `Array.from(${section(id)}?.querySelectorAll('button[aria-label^="Open "]') ?? []).map((el) => el.getAttribute('aria-label'))`;

async function addProject(cdp, dir) {
  await cdp.click(TRIGGER);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Local folder'))`, { timeoutMs: 10_000, label: 'Add project menu open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Local folder'))`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: dir });
  await cdp.clickByText('Add project', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'Add project dialog closed' });
}

async function createSession(cdp, projectName) {
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(`New session from a branch in ${projectName}`)}))`, { timeoutMs: 30_000, label: `session row for ${projectName}` });
  await cdp.clickByLabel(`New session from a branch in ${projectName}`, { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog ready' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session open, composer enabled' });
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const pass = (name, detail) => log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  const fail = (name, detail) => { failures.push(name); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); log(`SCREENSHOT ${file}`); };
  log(`verify-tauri-869: git HEAD under test: ${gitHead(REPO_ROOT)}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-869-data-');
    const importDir = scratch('refract-869-import-');
    const shimDir = scratch('refract-869-launcher-');
    const exeDir = scratch('refract-869-exe-');
    const ghDir = scratch('refract-869-gh-');
    const repoParent = scratch('refract-869-repo-');
    const ghLog = path.join(ghDir, 'gh-calls.log');
    const failFile = path.join(ghDir, 'fail-issues');
    const failPrsFile = path.join(ghDir, 'fail-prs');
    const branchesFile = path.join(ghDir, 'branches.txt');

    const rustc = (src, outDir, out) => {
      const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, src), '-o', path.join(outDir, out)], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`${src} build failed: ${r.stderr}`);
    };
    rustc('verify-tauri-869-fake-gh.rs', ghDir, 'gh.exe');
    rustc('verify-tauri-omp-shim.rs', shimDir, 'omp.exe');
    process.env.PATH = `${ghDir}${path.delimiter}${shimDir}${path.delimiter}${process.env.PATH}`;
    Object.assign(process.env, {
      FAKE_GH_LOG: ghLog,
      FAKE_GH_FAIL_FILE: failFile,
      FAKE_GH_FAIL_PRS_FILE: failPrsFile,
      FAKE_GH_BRANCHES: branchesFile,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath
    });

    const helloDir = makeScratchRepo(path.join(repoParent, 'hello-world'), 'repo869a');
    const spoonDir = makeScratchRepo(path.join(repoParent, 'spoon-knife'), 'repo869b');
    const localDir = makeScratchRepo(path.join(repoParent, 'local-only'), 'repo869c');
    for (const [dir, remote] of [[helloDir, 'hello-world'], [spoonDir, 'spoon-knife']]) {
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${remote}.git`], { windowsHide: true });
      // A remote-tracking ref at HEAD, so a Session branch with no commits of its own reads as pushed (clean).
      spawnSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-869' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-869: launched pid ${launched.targetPid}, exe sha256 ${hash}; fake gh log ${ghLog}`);

    await cdp.waitFor(`!!${TRIGGER} && !${TRIGGER}.disabled`, { timeoutMs: 45_000, label: 'app ready' });
    for (const dir of [helloDir, spoonDir, localDir]) await addProject(cdp, dir);
    pass('Added three scratch Projects (two with GitHub remotes, one without)');

    // 1. Launch with no panes: Home shows, the nav item is current, and the heading holds focus.
    await cdp.waitFor(`document.querySelector('[role="region"][aria-label="Home"] h1')?.textContent.trim() === 'Home'`, { timeoutMs: 20_000, label: 'Home on launch' });
    check(await cdp.evaluate(`!!(${HOME_NAV}) && (${HOME_NAV}).getAttribute('aria-current') === 'page'`), 'With no panes Home shows and its nav item is aria-current="page"');
    await cdp.waitFor(`!!${section('My pull requests')} && !!${section('Tidy up')} && !!${section('Quick actions')} && !!${section('Needs you')} && !!${section('Recent Sessions')} && !!${section('My issues')}`, { timeoutMs: 15_000, label: 'all six sections' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).find((el) => el.textContent.trim().startsWith('Issues'))`);
    await cdp.waitFor(`!document.querySelector('[role="region"][aria-label="Home"]')`, { timeoutMs: 10_000, label: 'left Home' });
    await cdp.click(HOME_NAV);
    await cdp.waitFor(`document.activeElement?.tagName === 'H1' && document.querySelector('[role="region"][aria-label="Home"]')?.contains(document.activeElement)`, { timeoutMs: 10_000, label: 'Home heading takes focus when Home opens' });
    pass('Home heading takes focus when Home opens from the nav');
    await cdp.waitFor(`${cards('My pull requests')}.length >= 2`, { timeoutMs: 20_000, label: 'My pull requests loaded' });
    await cdp.waitFor(`${cards('My issues')}.length >= 1`, { timeoutMs: 20_000, label: 'My issues loaded' });
    // Each section has tabs; click through them all and gather the cards each tab shows.
    const acrossTabs = async (title) => {
      const found = [];
      const tabCount = await cdp.evaluate(`${section(title)}?.querySelectorAll('[role="tab"]').length ?? 0`);
      for (let i = 0; i < Math.max(tabCount, 1); i += 1) {
        if (tabCount > 0) {
          await cdp.click(`${section(title)}.querySelectorAll('[role="tab"]')[${i}]`);
          await sleep(600);
        }
        found.push({ cards: await cdp.evaluate(cards(title)), text: await cdp.evaluate(`${section(title)}.textContent`) });
      }
      return found;
    };
    const prTabs = await acrossTabs('My pull requests');
    const prCards = prTabs.flatMap((t) => t.cards);
    const prText = prTabs.map((t) => t.text).join(' | ');
    const prTitles = ['Add passing feature', 'Fix failing build', 'Spoon polish', 'Handle tightening'];
    check(prCards.length === 4 && prTitles.every((x) => prText.includes(x)), 'My pull requests lists exactly four scoped results from both repositories across its tabs', JSON.stringify(prCards));
    check(prText.includes('hello-world') && prText.includes('spoon-knife'), 'The pull request cards name both repositories');
    const issueTabs = await acrossTabs('My issues');
    const issueText = issueTabs.map((t) => t.text).join(' | ');
    const issueTitles = ['Crash when saving a draft', 'Docs mention the old flag', 'Fork handle is loose'];
    check(issueTitles.every((x) => issueText.includes(x)), 'My issues lists the assigned and created issues from both repositories across its tabs', JSON.stringify(issueTabs.map((t) => t.cards)));
    await cdp.click(`${section('My pull requests')}.querySelector('[role="tab"]')`);
    await cdp.click(`${section('My issues')}.querySelector('[role="tab"]')`);
    check(await cdp.evaluate(`document.querySelector('[role="region"][aria-label="Home"]').textContent.includes('Updated')`), 'The "Updated" fetched-time note shows');
    await shot(cdp, '01-home-no-sessions.png');

    // 2. Sessions: one needs you (a pending approval), two recent (one clean, one dirty for Tidy up).
    await createSession(cdp, 'hello-world');
    await cdp.typeIntoByLabel('Message', 'Please respond now.');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Approval card rendered' });
    // Creating further Sessions refreshes the list, which settles a stale status left by a send-time list refresh racing the needs-you event.
    await createSession(cdp, 'hello-world');
    await createSession(cdp, 'hello-world');
    await cdp.waitFor(`/\\d+ need you/.test((${HOME_NAV})?.getAttribute('aria-label') ?? '')`, { timeoutMs: 30_000, label: 'Home nav badge shows a needs-you Session' });

    const wt = spawnSync('git', ['-C', helloDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout;
    const waitingName = await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('button, [role="button"], li')).find((e) => (e.innerText ?? '').includes('Waiting for approval')); return (el?.innerText ?? '').split('\\n')[0].trim(); })()`);
    log(`needs-you Session: ${waitingName}`);
    const trees = wt.split(/\r?\n\r?\n/).map((block) => ({
      path: /^worktree (.*)$/m.exec(block)?.[1],
      branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1]
    })).filter((t) => t.path && t.branch && t.branch !== waitingName && path.resolve(t.path).toLowerCase() !== path.resolve(helloDir).toLowerCase());
    log(`worktrees: ${JSON.stringify(trees)}`);
    if (!waitingName || trees.length < 2) throw new Error(`expected 2 settled Session worktrees plus the waiting one, found ${trees.length} (waiting: ${waitingName})`);
    writeFileSync(path.join(trees[1].path, 'unsaved.txt'), 'dirty');
    writeFileSync(branchesFile, [`octocat/hello-world|${trees[0].branch}|MERGED|41`, `octocat/hello-world|${trees[1].branch}|CLOSED|42`].join('\n'));
    const fakePrList = spawnSync(path.join(ghDir, 'gh.exe'), ['pr', 'list', '--repo', 'octocat/hello-world'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FAKE_GH_LOG: '' } }).stdout ?? '';
    check(fakePrList.includes('"headRepositoryOwner":{"login":"octocat"}'), 'The fake pr list emits headRepositoryOwner {login: octocat}');

    // 3. Open Home from the nav item; the badge counts needs-you Sessions.
    await cdp.click(HOME_NAV);
    await cdp.waitFor(`document.querySelector('[role="region"][aria-label="Home"] h1')?.textContent.trim() === 'Home'`, { timeoutMs: 10_000, label: 'Home via nav' });
    await cdp.waitFor(`${cards('Recent Sessions')}.length >= 2`, { timeoutMs: 20_000, label: 'Recent Sessions' });
    const recent = await cdp.evaluate(cards('Recent Sessions'));
    check(recent.length >= 2 && recent.length <= 8, 'Recent Sessions lists the two settled Sessions (the needs-you one sits in Needs you)', JSON.stringify(recent));
    const badge = await cdp.evaluate(`(${HOME_NAV}).getAttribute('aria-label')`);
    check(/Home, [1-9]\d* need you/.test(badge), 'Home nav item carries a needs-you badge of at least 1 in its accessible name', badge);
    check((await cdp.evaluate(cards('Needs you'))).length >= 1, 'Needs you lists the waiting Session', JSON.stringify(await cdp.evaluate(cards('Needs you'))));
    await shot(cdp, '02-home-sections.png');

    // 4. Refresh re-fetches; Tidy up now shows the two closed-PR Sessions.
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`${section('Tidy up')}?.querySelectorAll('li').length === 2`, { timeoutMs: 30_000, label: 'Tidy up rows' });
    await cdp.waitFor(`!!Array.from(${section('Tidy up')}.querySelectorAll('button')).find((el) => /^Archive all clean \\(1\\)$/.test(el.textContent.trim()))`, { timeoutMs: 20_000, label: 'Archive all clean (1)' });
    const tidyRows = `Array.from(${section('Tidy up')}?.querySelectorAll('button[aria-label^="Archive Session"]') ?? []).map((b) => (b.closest('li') ?? b.parentElement).textContent)`;
    const rowsBefore = await cdp.evaluate(tidyRows);
    check(
      rowsBefore.length === 2 && rowsBefore.some((r) => r.includes('#41') && r.includes('Clean') && !r.includes('Uncommitted')) && rowsBefore.some((r) => r.includes('#42') && r.includes('Uncommitted changes')),
      'Tidy up lists the clean Session (#41) and the Session with unsaved work (#42) and offers Archive all clean (1)',
      JSON.stringify(rowsBefore)
    );
    await shot(cdp, '03-tidy-up.png');

    // 5. Refresh with a failing gh shows the error line and keeps the data.
    writeFileSync(failFile, 'fail');
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`${section('My issues')}?.innerText.includes('not listed') ?? false`, { timeoutMs: 20_000, label: 'issues error line' });
    check(await cdp.evaluate(`${section('My issues')}.innerText.includes('2 Projects were not listed')`), 'Refresh with a failing gh shows the one-line "2 Projects were not listed" error in My issues');
    await cdp.waitFor(`document.querySelector('[role="region"][aria-label="Home"] [role="status"]')?.textContent.includes('errors') ?? false`, { timeoutMs: 10_000, label: 'Refreshed with errors announcement' });
    pass('The live region announces "Refreshed with errors"');
    await shot(cdp, '04-refresh-error-line.png');
    unlinkSync(failFile);
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`!${section('My issues')}.innerText.includes('not listed')`, { timeoutMs: 20_000, label: 'error line cleared' });
    pass('A successful Refresh clears the error line');

    // 5b. A failing search prs shows the error line in My pull requests and keeps the cards.
    writeFileSync(failPrsFile, 'fail');
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`!!${section('My pull requests')}?.querySelector('p svg')`, { timeoutMs: 20_000, label: 'pull requests error line' });
    check(await cdp.evaluate(`${cards('My pull requests')}.length >= 1`), 'A failing search prs shows the error line in My pull requests and keeps its cards');
    unlinkSync(failPrsFile);
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`${section('My pull requests')}.querySelectorAll('p svg').length === 0`, { timeoutMs: 20_000, label: 'pull requests error line cleared' });

    // 6. Tidy up: Archive all clean takes only the clean Session; then Archive the dirty one (no confirm).
    const archiveAll = `Array.from(${section('Tidy up')}.querySelectorAll('button')).find((el) => /^Archive all clean \\(1\\)$/.test(el.textContent.trim()))`;
    await cdp.evaluate(`(${archiveAll}).scrollIntoView({ block: 'center' })`);
    await cdp.click(archiveAll);
    await sleep(1000);
    await cdp.waitFor(`${tidyRows}.length === 1`, { timeoutMs: 20_000, label: 'only one Tidy up row left' });
    const rowsAfterAll = await cdp.evaluate(tidyRows);
    check(rowsAfterAll.length === 1 && rowsAfterAll[0].includes('#42') && rowsAfterAll[0].includes('Uncommitted changes'), 'Archive all clean leaves exactly the Session with unsaved work', JSON.stringify(rowsAfterAll));
    check(existsSync(trees[0].path) && existsSync(trees[1].path), 'Archiving keeps both Worktree directories on disk (including the archived clean one)');
    check(await cdp.evaluate(`!Array.from(${section('Tidy up')}.querySelectorAll('button')).some((el) => /^Archive all clean/.test(el.textContent.trim()))`), 'Archive all clean is no longer offered once no clean Session remains');
    await shot(cdp, '05-tidy-up-after-archive-all.png');
    await cdp.evaluate(`(${section('Tidy up')}.querySelector('button[aria-label^="Archive Session"]')).focus()`);
    await cdp.pressEnter();
    await cdp.waitFor(`${tidyRows}.length === 0 && !document.querySelector('[role="alertdialog"]')`, { timeoutMs: 20_000, label: 'dirty row archived' });
    check(existsSync(trees[1].path), 'Archiving the dirty Session removes its row with no confirm dialog and keeps its Worktree');

    // 7. Keyboard: Tab from the heading lands on a button inside Home; Enter on a Recent card opens a Session.
    await cdp.evaluate(`document.querySelector('[role="region"][aria-label="Home"] h1').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    check(await cdp.evaluate(`document.activeElement?.tagName !== 'H1' && !!document.activeElement.closest('[role="region"][aria-label="Home"]')`), 'Tab moves focus from the heading to the next control inside Home');
    await shot(cdp, '06-keyboard-focus.png');
    await cdp.evaluate(`(${section('Needs you')}.querySelector('button[aria-label^="Open "]')).focus()`);
    await cdp.pressEnter();
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled && !document.querySelector('[role="region"][aria-label="Home"]'); })()`, { timeoutMs: 20_000, label: 'Session opened from a Recent card' });
    pass('Enter on a Needs you card opens the Session');

    // 8. What gh was actually asked.
    const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
    const scoped = calls.filter((l) => /"(search|issue|pr)", "(prs|list)"/.test(l));
    const prListRepos = new Set(calls.filter((l) => l.includes('"pr", "list"')).map((l) => /"--repo", "([^"]+)"/.exec(l)?.[1]));
    check(
      scoped.length > 0 && scoped.every((l) => l.includes('"--repo"') && l.includes('octocat/')) && !calls.some((l) => l.includes('local-only')),
      'Every recorded search or list gh call is scoped with --repo to a GitHub-remote Project',
      `${calls.length} calls, ${scoped.length} scoped`
    );
    check(prListRepos.size === 2 && prListRepos.has('octocat/hello-world') && prListRepos.has('octocat/spoon-knife'), 'The local-only Project is never queried: pr list ran for exactly the two GitHub-remote repositories', JSON.stringify([...prListRepos]));
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-869');
  }
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
