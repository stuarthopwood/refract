#!/usr/bin/env node
// Live CDP check for issue #1867 (stacked pull requests, SC-001..SC-006). A fake `gh` (verify-tauri-1867-fake-gh-logic.cjs,
// run through the 1121 launcher shim) serves a 3-layer stack plus a plain pull request and records every argv, which is the
// proof of what Merge ran. Launch 1: gh-stack outdated -> Install -> badge/layers/merge routing/toggle/exit 9.
// Launch 2: gh-stack missing -> install callout in the Merge dialog.

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, launchViaJobObject, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1867_DIR || path.join(tmpdir(), 'r1867');
const SHOTS_DIR = path.join(WORK_DIR, 'shots');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const GH_DIR = path.join(WORK_DIR, 'fake-gh');
const GH_LOG = path.join(GH_DIR, 'gh-calls.log');

const checks = [];
const shots = [];
function check(label, ok, detail) {
  checks.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean) : []);
const callCount = (re) => ghCalls().filter((l) => re.test(l)).length;
const setControl = (name, value) => writeFileSync(path.join(GH_DIR, name), value);

function buildFakeGh() {
  mkdirSync(GH_DIR, { recursive: true });
  writeFileSync(GH_LOG, '');
  copyFileSync(path.join(__dirname, 'verify-tauri-1867-fake-gh-logic.cjs'), path.join(GH_DIR, 'fake-gh-logic.cjs'));
  const out = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-1121-fake-gh-launcher.rs'), '-o', path.join(GH_DIR, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`fake gh build failed: ${out.stderr}`);
}

async function launch(launcherExe, built, label) {
  const dataDir = path.join(WORK_DIR, `data-${label}`);
  const importDir = path.join(WORK_DIR, `import-${label}`);
  const profileDir = path.join(WORK_DIR, `webview2-${label}`);
  for (const d of [dataDir, importDir, profileDir]) mkdirSync(d, { recursive: true });
  const repoDir = makeFakeGithubRepo(path.join(WORK_DIR, `repo-${label}`));
  const port = await getFreePort();
  const env = {
    ...process.env,
    PATH: `${GH_DIR}${path.delimiter}${process.env.PATH}`,
    GH_CONFIG_DIR: path.join(WORK_DIR, `ghcfg-${label}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: profileDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importDir
  };
  for (const k of Object.keys(env)) if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'].includes(k.toUpperCase())) delete env[k];
  const pidFile = path.join(path.dirname(built.dest), `target-${label}.pid`);
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, built.dest, [], { cwd: path.dirname(built.dest), env });
  const stream = createWriteStream(path.join(SHOTS_DIR, `app-${label}.log`));
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, targetPid)) throw new Error('CDP target is not owned by the process this run launched');
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project' && !el.disabled)`, { timeoutMs: 60_000, label: 'app ready' });
  await addRepository(cdp, repoDir);
  return { child, cdp };
}

// The merge dialog is an alertdialog; q() widens the plain dialog selector so every check sees it.
const DLG = '[role="dialog"],[role="alertdialog"]';
const q = (sel) => `document.querySelector(${JSON.stringify(sel === '[role="dialog"]' ? DLG : sel)})`;
const dlgClick = (cdp, label) => cdp.click(`Array.from(document.querySelector(${JSON.stringify(DLG)}).querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`);
const dlgClickLabel = (cdp, label) => cdp.click(`document.querySelector(${JSON.stringify(DLG)}).querySelector('[aria-label=${JSON.stringify(label)}]')`);
const text = (cdp, sel) => cdp.evaluate(`${q(sel)}?.textContent.trim().replace(/\\s+/g, ' ') ?? null`);
const count = (cdp, sel) => cdp.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const shot = async (cdp, name) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(300);
  const file = path.join(SHOTS_DIR, name);
  await cdp.screenshot(file);
  shots.push(file);
};

async function openSessionsSettings(cdp) {
  await cdp.click(q('[aria-label="Settings"]'));
  await cdp.waitFor(`!!${q('[aria-label="Back to chat"]')}`, { label: 'settings open' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Sessions')`);
  await cdp.waitFor(`!!${q('#stacked-pull-requests-toggle')}`, { label: 'sessions settings' });
}
async function openPullRequests(cdp, rows = true) {
  if (await cdp.evaluate(`!!${q('[aria-label="Back to chat"]')}`)) await cdp.click(q('[aria-label="Back to chat"]'));
  await cdp.clickByText('Pull requests');
  if (rows) await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length === 4`, { timeoutMs: 30_000, label: 'four rows' });
}
async function openDetail(cdp, number) {
  await cdp.click(q(`[data-pr-row][data-pr-number="${number}"]`));
  await cdp.waitFor(`document.querySelector('h2.line-clamp-2 > span')?.textContent.trim() === '#${number}'`, { label: `detail #${number}` });
}
async function openMerge(cdp) {
  await cdp.clickByText('Merge');
  await cdp.waitFor(`!!${q('[role="dialog"]')}`, { label: 'merge dialog' });
}
const closeDialog = async (cdp) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!${q('[role="dialog"]')}`, { label: 'dialog closed' });
};

async function phase(name, cdp, body) {
  try {
    await body();
  } catch (err) {
    check(`${name} ran to the end`, false, String(err?.message ?? err));
    try { await shot(cdp, `crash-${name}.png`); } catch { /* app gone */ }
  }
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const head = gitHead(REPO_ROOT);
  console.log(`verify-1867: git HEAD ${head}; work ${WORK_DIR}`);
  buildFakeGh();
  const launcherExe = buildLauncher(path.join(WORK_DIR, 'launcher'));
  mkdirSync(path.join(WORK_DIR, 'exe'), { recursive: true });
  const built = buildAndCopyExeFresh(path.join(WORK_DIR, 'exe'), BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1867' });

  // Launch 1: outdated -> Install, then the stack UI and merge routing.
  setControl('stack-version', 'old');
  let session = await launch(launcherExe, built, 'a');
  try {
    const { cdp } = session;
    await phase('install-outdated', cdp, async () => {
      await openSessionsSettings(cdp);
      await cdp.waitFor(`/needs updating/.test(${q('[data-gh-stack-notice]')}?.textContent ?? '')`, { label: 'outdated notice' });
      check('SC-002 Settings says gh-stack needs updating with an Install button', (await count(cdp, '[data-gh-stack-notice] button')) === 1, await text(cdp, '[data-gh-stack-notice]'));
      await shot(cdp, '01-settings-outdated.png');
      await cdp.clickByLabel('Install the latest gh-stack');
      await cdp.waitFor(`/installed and ready/.test(${q('[data-gh-stack-notice]')}?.textContent ?? '')`, { label: 'ready notice' });
      check('SC-002 Install clears the prompt and runs `gh extension upgrade gh-stack`', callCount(/^extension upgrade gh-stack/) === 1, await text(cdp, '[data-gh-stack-notice]'));
      await shot(cdp, '02-settings-ready.png');
    });
    await phase('badge-layers', cdp, async () => {
      await openPullRequests(cdp);
      await cdp.waitFor(`document.querySelectorAll('[data-pr-row] [data-stack-badge]').length === 3`, { timeoutMs: 20_000, label: 'three badges' });
      const badges = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-pr-row]')).map((r) => [r.getAttribute('data-pr-number'), r.querySelector('[data-stack-badge]')?.textContent.trim() ?? null])`);
      check('SC-001 rows of the 3-layer stack show "Stack N of 3"; the plain pull request shows none', JSON.stringify(badges.sort()) === JSON.stringify([['1', 'Stack 1 of 3'], ['2', 'Stack 2 of 3'], ['3', 'Stack 3 of 3'], ['4', null]]), badges);
      await shot(cdp, '03-list-badges.png');
      await openDetail(cdp, 2);
      await cdp.waitFor(`!!${q('[data-stack-layers]')}`, { label: 'layers list' });
      const layers = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-stack-layers] li')).map((li) => ({ text: li.textContent.trim().replace(/\\s+/g, ' '), current: li.getAttribute('aria-current') === 'true' || !!li.querySelector('[aria-current="true"]') }))`);
      check('SC-001 detail lists 3 layers with #2 marked current', layers.length === 3 && layers.map((l) => l.current).join() === 'false,true,false' && /#2/.test(layers[1].text), layers);
      await shot(cdp, '04-detail-layers.png');
    });
    await phase('merge-routing', cdp, async () => {
      await openMerge(cdp);
      await cdp.waitFor(`!!${q('[data-merge-layers]')}`, { label: 'merge layers line' });
      const line = await text(cdp, '[data-merge-layers]');
      check('SC-003 Merge dialog from layer 2 says it merges layers 1 to 2 together', /Merges layers 1 to 2 together/.test(line ?? ''), line);
      await shot(cdp, '05-merge-dialog-middle.png');
      await dlgClick(cdp, 'Merge');
      await cdp.waitFor(`!${q('[role="dialog"]')}`, { timeoutMs: 30_000, label: 'merge done' });
      check('SC-003 merge from a middle layer runs `gh stack merge 2 --yes --squash`, not `gh pr merge`', callCount(/^stack merge 2 --yes --squash$/) === 1 && callCount(/^pr merge 2\b/) === 0, ghCalls().filter((l) => /merge/.test(l)));
      await openPullRequests(cdp);
      await openDetail(cdp, 4);
      check('SC-003 plain pull request #4 shows no layers', (await count(cdp, '[data-stack-layers]')) === 0);
      await openMerge(cdp);
      check('SC-003 plain Merge dialog has no layers line', (await count(cdp, '[data-merge-layers]')) === 0);
      await dlgClick(cdp, 'Merge');
      await cdp.waitFor(`!${q('[role="dialog"]')}`, { timeoutMs: 30_000, label: 'plain merge done' });
      check('SC-003 plain pull request merges with `gh pr merge 4`', callCount(/^pr merge 4\b/) === 1 && callCount(/^stack merge 4\b/) === 0, ghCalls().filter((l) => /merge/.test(l)));
    });
    await phase('toggle-off', cdp, async () => {
      await openSessionsSettings(cdp);
      await cdp.click(q('#stacked-pull-requests-toggle'));
      await sleep(500);
      await openPullRequests(cdp);
      await sleep(1500);
      check('SC-006 with the toggle off no row shows a stack badge', (await count(cdp, '[data-stack-badge]')) === 0);
      await openDetail(cdp, 2);
      check('SC-006 with the toggle off the detail shows no layers', (await count(cdp, '[data-stack-layers]')) === 0);
      await openMerge(cdp);
      check('SC-006 with the toggle off the Merge dialog has no layers line', (await count(cdp, '[data-merge-layers]')) === 0);
      await shot(cdp, '06-toggle-off-merge.png');
      const before = callCount(/^stack merge/);
      await dlgClick(cdp, 'Merge');
      await cdp.waitFor(`!${q('[role="dialog"]')}`, { timeoutMs: 30_000, label: 'toggle-off merge done' });
      check('SC-006 with the toggle off #2 merges with `gh pr merge 2`', callCount(/^pr merge 2\b/) === 1 && callCount(/^stack merge/) === before, ghCalls().filter((l) => /merge/.test(l)));
      await openSessionsSettings(cdp);
      await cdp.click(q('#stacked-pull-requests-toggle'));
      await sleep(500);
    });
    await phase('exit-9', cdp, async () => {
      setControl('exit9', '');
      await openPullRequests(cdp);
      await openDetail(cdp, 3);
      await openMerge(cdp);
      await dlgClick(cdp, 'Merge');
      await cdp.waitFor(`/not enabled for this repository/.test(${q('[role="dialog"]')}?.textContent ?? '')`, { timeoutMs: 30_000, label: 'exit 9 message' });
      check('SC-005 exit 9 shows "not enabled for this repository"', true, await text(cdp, '[role="dialog"]'));
      await shot(cdp, '07-exit9-message.png');
      await dlgClick(cdp, 'Retry');
      await cdp.waitFor(`!${q('[role="dialog"]')}`, { timeoutMs: 30_000, label: 'fallback merge done' });
      check('SC-005 after exit 9 the repository falls back to `gh pr merge 3`', callCount(/^pr merge 3\b/) === 1 && callCount(/^stack merge 3 /) === 1, ghCalls().filter((l) => /merge/.test(l)));
    });
  } finally {
    session.cdp.close();
    await stopLauncher(session.child).catch(() => {});
  }

  // Launch 2: missing -> the Merge dialog offers Install.
  setControl('stack-version', 'missing');
  setControl('exit9', '');
  writeFileSync(path.join(GH_DIR, 'exit9'), '');
  session = await launch(launcherExe, built, 'b');
  try {
    const { cdp } = session;
    await phase('install-missing', cdp, async () => {
      await cdp.clickByText('Pull requests');
      await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length === 4`, { timeoutMs: 30_000, label: 'four rows' });
      await sleep(1500);
      check('SC-002 with gh-stack missing no row shows a stack badge', (await count(cdp, '[data-stack-badge]')) === 0);
      await openDetail(cdp, 2);
      await openMerge(cdp);
      await cdp.waitFor(`!!${q('[data-gh-stack-notice="missing"]')}`, { label: 'missing callout' });
      check('SC-002 Merge dialog says gh-stack is not installed', /gh-stack is not installed/.test((await text(cdp, '[data-gh-stack-notice]')) ?? ''), await text(cdp, '[data-gh-stack-notice]'));
      await shot(cdp, '08-merge-dialog-missing.png');
      await dlgClickLabel(cdp, 'Install gh-stack');
      await cdp.waitFor(`!${q('[data-gh-stack-notice]')} && !!${q('[data-merge-layers]')}`, { timeoutMs: 40_000, label: 'callout cleared, layers shown' });
      check('SC-002 Install clears the callout and the dialog now offers the stack merge', callCount(/^extension install github\/gh-stack/) === 1, await text(cdp, '[data-merge-layers]'));
      await shot(cdp, '09-merge-dialog-installed.png');
    });
  } finally {
    session.cdp.close();
    await stopLauncher(session.child).catch(() => {});
  }

  const failures = checks.filter((c) => !c.ok);
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ head, checks, failures: failures.length, shots, ghCalls: ghCalls() }, null, 2));
  console.log('screenshots:\n' + shots.map((s) => ` ${s}`).join('\n'));
  if (failures.length) {
    console.error(`verify-1867: ${failures.length} FAILURE(S)`);
    process.exitCode = 1;
  } else console.log(`verify-1867: ALL ${checks.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-1867: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
