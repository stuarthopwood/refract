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
const section = (id) => `document.querySelector('section[aria-labelledby="section-${id}"]')`;
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
    const branchesFile = path.join(ghDir, 'branches.txt');

    const rustc = (src, out) => {
      const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, src), '-o', path.join(ghDir === out ? ghDir : shimDir, out)], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`${src} build failed: ${r.stderr}`);
    };
    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-869-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    rustc('verify-tauri-omp-shim.rs', 'omp.exe');
    process.env.PATH = `${ghDir}${path.delimiter}${shimDir}${path.delimiter}${process.env.PATH}`;
    Object.assign(process.env, {
      FAKE_GH_LOG: ghLog,
      FAKE_GH_FAIL_FILE: failFile,
      FAKE_GH_BRANCHES: branchesFile,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'ask'
    });

    const helloDir = makeScratchRepo(path.join(repoParent, 'hello-world'), 'repo869a');
    const spoonDir = makeScratchRepo(path.join(repoParent, 'spoon-knife'), 'repo869b');
    const localDir = makeScratchRepo(path.join(repoParent, 'local-only'), 'repo869c');
    for (const [dir, remote] of [[helloDir, 'hello-world'], [spoonDir, 'spoon-knife']]) {
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${remote}.git`], { windowsHide: true });
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
    await cdp.waitFor(`!!${section('my-pull-requests')} && !!${section('tidy-up')} && !!${section('quick-actions')} && !!${section('needs-you')} && !!${section('recent-sessions')} && !!${section('my-issues')}`, { timeoutMs: 15_000, label: 'all six sections' });
    check(await cdp.evaluate(`document.activeElement?.tagName === 'H1'`), 'Home heading takes focus on mount');
    await cdp.waitFor(`${cards('my-pull-requests')}.length >= 2`, { timeoutMs: 20_000, label: 'My pull requests loaded' });
    const prs = await cdp.evaluate(cards('my-pull-requests'));
    check(prs.length === 4 || prs.length === 2, 'My pull requests lists scoped results from both repositories', JSON.stringify(prs));
    await cdp.waitFor(`${cards('my-issues')}.length >= 2`, { timeoutMs: 20_000, label: 'My issues loaded' });
    check(true, 'My issues lists results', JSON.stringify(await cdp.evaluate(cards('my-issues'))));
    check(await cdp.evaluate(`document.querySelector('[role="region"][aria-label="Home"]').textContent.includes('Updated')`), 'The "Updated" fetched-time note shows');
    await shot(cdp, '01-home-no-sessions.png');

    // 2. Sessions: one needs you (the ask scenario), two recent (one clean, one dirty for Tidy up).
    await createSession(cdp, 'hello-world');
    await cdp.typeIntoByLabel('Message', 'Please ask me the batch of questions now.');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.body.textContent.includes('Asked user') || !!document.querySelector('[aria-label="Transcript"]')`, { timeoutMs: 30_000, label: 'ask turn started' });
    await sleep(3000);
    await createSession(cdp, 'hello-world');
    await createSession(cdp, 'hello-world');

    const wt = spawnSync('git', ['-C', helloDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout;
    const trees = wt.split(/\r?\n\r?\n/).map((block) => ({
      path: /^worktree (.*)$/m.exec(block)?.[1],
      branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1]
    })).filter((t) => t.path && t.branch && path.resolve(t.path).toLowerCase() !== path.resolve(helloDir).toLowerCase());
    log(`worktrees: ${JSON.stringify(trees)}`);
    if (trees.length < 3) throw new Error(`expected 3 Session worktrees, found ${trees.length}`);
    writeFileSync(path.join(trees[2].path, 'unsaved.txt'), 'dirty');
    writeFileSync(branchesFile, [`octocat/hello-world|${trees[1].branch}|MERGED|41`, `octocat/hello-world|${trees[2].branch}|CLOSED|42`].join('\n'));

    // 3. Open Home from the nav item; the badge counts needs-you Sessions.
    await cdp.click(HOME_NAV);
    await cdp.waitFor(`document.querySelector('[role="region"][aria-label="Home"] h1')?.textContent.trim() === 'Home'`, { timeoutMs: 10_000, label: 'Home via nav' });
    await cdp.waitFor(`${cards('recent-sessions')}.length >= 3`, { timeoutMs: 20_000, label: 'Recent Sessions' });
    check(true, 'Recent Sessions lists the Sessions', JSON.stringify(await cdp.evaluate(cards('recent-sessions'))));
    const badge = await cdp.evaluate(`(${HOME_NAV}).getAttribute('aria-label')`);
    check(/Home, \d+ need you/.test(badge), 'Home nav item carries the needs-you badge in its accessible name', badge);
    check((await cdp.evaluate(cards('needs-you'))).length >= 1, 'Needs you lists the waiting Session', JSON.stringify(await cdp.evaluate(cards('needs-you'))));
    await shot(cdp, '02-home-sections.png');

    // 4. Refresh re-fetches; Tidy up now shows the two closed-PR Sessions.
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`${section('tidy-up')}?.querySelectorAll('li').length === 2`, { timeoutMs: 30_000, label: 'Tidy up rows' });
    await cdp.waitFor(`!!Array.from(${section('tidy-up')}.querySelectorAll('button')).find((el) => /^Archive all clean \\(1\\)$/.test(el.textContent.trim()))`, { timeoutMs: 20_000, label: 'Archive all clean (1)' });
    check(true, 'Tidy up lists both Sessions (one clean, one with unsaved work) and offers Archive all clean (1)');
    await shot(cdp, '03-tidy-up.png');

    // 5. Refresh with a failing gh shows the error line and keeps the data.
    writeFileSync(failFile, 'fail');
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`!!${section('my-issues')}?.querySelector('svg') && !!${section('my-issues')}.textContent.length`, { timeoutMs: 20_000, label: 'issues error line' });
    check(await cdp.evaluate(`${section('my-issues')}.querySelectorAll('p svg').length > 0`), 'Refresh with a failing gh shows the one-line error in My issues');
    check(await cdp.evaluate(`document.querySelector('[role="status"]')?.textContent.includes('errors')`), 'The live region announces "Refreshed with errors"');
    await shot(cdp, '04-refresh-error-line.png');
    unlinkSync(failFile);
    await cdp.clickByLabel('Refresh Home');
    await cdp.waitFor(`${section('my-issues')}.querySelectorAll('p svg').length === 0`, { timeoutMs: 20_000, label: 'error line cleared' });
    pass('A successful Refresh clears the error line');

    // 6. Tidy up: Archive one row (no confirm), then Archive all clean archives only clean Sessions.
    await cdp.evaluate(`(${section('tidy-up')}.querySelector('button[aria-label^="Archive Session"]')).focus()`);
    await cdp.pressEnter();
    await cdp.waitFor(`${section('tidy-up')}.querySelectorAll('li').length === 1 && !document.querySelector('[role="alertdialog"]')`, { timeoutMs: 20_000, label: 'one row archived' });
    check(true, 'Archive removes the row with no confirm dialog');
    check(existsSync(trees[1].path) || existsSync(trees[2].path), 'Archive keeps the Worktree on disk');
    await shot(cdp, '05-tidy-up-after-archive.png');
    const remaining = await cdp.evaluate(`${section('tidy-up')}.textContent`);
    const archivedClean = !remaining.includes('clean') || remaining.includes('has unsaved work');
    check(archivedClean, 'Archive all clean never touches the Session with unsaved work', remaining.slice(0, 120));
    const dirtyStays = await cdp.evaluate(`!Array.from(${section('tidy-up')}.querySelectorAll('button')).some((el) => /^Archive all clean/.test(el.textContent.trim()))`);
    check(dirtyStays, 'Archive all clean is not offered when no clean Session remains', String(dirtyStays));

    // 7. Keyboard focus: Tab moves focus along a visible ring.
    await cdp.evaluate(`document.querySelector('[role="region"][aria-label="Home"] h1').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    check(await cdp.evaluate(`document.activeElement !== document.body && document.activeElement?.tagName !== 'H1'`), 'Tab moves focus from the heading to the first control');
    await shot(cdp, '06-keyboard-focus.png');

    // 8. What gh was actually asked.
    const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
    const scoped = calls.filter((l) => /"(search|issue|pr)", "(prs|list)"/.test(l));
    check(
      scoped.length > 0 && scoped.every((l) => l.includes('"--repo"') && l.includes('octocat/')) && !calls.some((l) => l.includes('local-only')),
      'Every recorded search or list gh call is scoped with --repo to a GitHub-remote Project',
      `${calls.length} calls, ${scoped.length} scoped`
    );
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
