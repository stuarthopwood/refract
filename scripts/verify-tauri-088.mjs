#!/usr/bin/env node
// Live CDP check for spec 088 UI polish (PR and Issue headers, popper selects, invalid ring, right-pane band, Manage sessions
// filter) against a built Tauri debug exe with a fake `gh` and fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_088_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-088.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { buildFakeGh, makeFakeGithubRepo, FAKE_OWNER, FAKE_REPO } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_088_SHOTS_DIR || path.join(tmpdir(), 'refract-088-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SKIPPED = [];
const SHOTS = [];
let passed = 0;
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
const skip = (name, reason) => {
  SKIPPED.push({ name, reason });
  log(`SKIP: ${name}: ${reason}`);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}
const shot = async (cdp, name) => {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  SHOTS.push(name);
};

const ISSUE = { number: 7, title: 'Fixture issue for the header', state: 'OPEN', url: `https://github.com/${FAKE_OWNER}/${FAKE_REPO}/issues/7`, labels: [], assignees: [], author: { login: 'octocat' }, comments: [], body: 'Issue body.', createdAt: '2026-10-21T12:00:00Z', updatedAt: '2026-10-21T12:00:00Z' };

// Adds `gh issue list/view` and `gh label list` to the shared fake gh, which hard-fails on unknown commands.
function addIssueFixtures(fakeGhDir) {
  const file = path.join(fakeGhDir, 'fake-gh-logic.cjs');
  const marker = "} else {\n  fail('fake gh: unhandled command";
  const source = readFileSync(file, 'utf8');
  if (!source.includes(marker)) throw new Error('fake-gh-logic.cjs layout changed; cannot add issue fixtures');
  const branch = `} else if (args[0] === 'issue' && args[1] === 'list') {\n  emit([${JSON.stringify(ISSUE)}]);\n} else if (args[0] === 'issue' && args[1] === 'view') {\n  emit(${JSON.stringify(ISSUE)});\n} else if (args[0] === 'label') {\n  emit([]);\n`;
  writeFileSync(file, source.replace(marker, branch + marker));
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

const headerOf = `document.querySelector('h2.line-clamp-2')?.closest('.shrink-0')`;

async function checkPullRequests(cdp) {
  await cdp.clickByText('Pull requests');
  await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 30_000, label: 'PR rows' });
  async function open(number) {
    await cdp.evaluate(`document.querySelector('[data-pr-row][data-pr-number="${number}"]')?.scrollIntoView({ block: 'center' })`);
    await cdp.click(`document.querySelector('[data-pr-row][data-pr-number="${number}"]')`);
    await cdp.waitFor(`document.querySelector('h2.line-clamp-2 > span')?.textContent.trim() === '#${number}'`, { timeoutMs: 15_000, label: `PR #${number} detail` });
  }
  const shape = () => cdp.evaluate(`(() => {
    const header = ${headerOf};
    const find = (t) => Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === t);
    const merge = find('Merge');
    const session = find('New session');
    const title = header.querySelector('h2').parentElement;
    const actions = header.querySelector('a[data-open-on-github]').parentElement;
    return {
      openGh: header.querySelector('a[data-open-on-github]')?.getAttribute('aria-label'),
      copyLink: !!header.querySelector('button[aria-label="Copy link"]'),
      mergeClass: merge ? merge.className : null,
      sessionTitle: session ? session.getAttribute('title') : null,
      draftReason: header.querySelector('[data-draft-reason]')?.textContent.trim() ?? null,
      mergeReason: header.querySelector('[data-merge-reason]')?.textContent.trim() ?? null,
      titleGrows: getComputedStyle(title).flexGrow,
      actionsWrap: getComputedStyle(actions).flexWrap,
      actionsShrink: getComputedStyle(actions).flexShrink
    };
  })()`);
  await open(1);
  const openPr = await shape();
  log(`open PR header: ${JSON.stringify(openPr)}`);
  await shot(cdp, '01-pr-open-header.png');
  assert(openPr.openGh === 'Open on GitHub (opens in browser)', 'PR header Open on GitHub is the shared icon anchor');
  assert(openPr.copyLink, 'PR header has a Copy link button');
  assert(openPr.mergeClass && !/bg-primary/.test(openPr.mergeClass) && /border/.test(openPr.mergeClass), 'Merge is an outline button, not a filled one');
  assert(openPr.titleGrows === '1' && openPr.actionsWrap === 'nowrap' && openPr.actionsShrink === '0', 'PR title row grows and actions stay on one non-shrinking row');
  assert(openPr.draftReason === null, 'An open PR shows no draft reason');
  await open(5);
  const draft = await shape();
  log(`draft PR header: ${JSON.stringify(draft)}`);
  await shot(cdp, '02-pr-draft-header.png');
  assert(draft.draftReason === 'Draft pull requests cannot start a Session.', 'Draft PR shows the visible draft reason line');
  assert(draft.sessionTitle === null, 'New session has no title tooltip on a draft');
  assert(draft.mergeReason === null, 'Only one reason line shows at a time on a draft');
  await open(8);
  const conflict = await shape();
  await shot(cdp, '03-pr-conflict-header.png');
  assert(conflict.mergeReason !== null && conflict.draftReason === null, 'A conflicting open PR still shows only the merge reason');
}

async function checkIssues(cdp) {
  await cdp.clickByText('Issues');
  await cdp.waitFor(`!!document.querySelector('[data-issue-row]')`, { timeoutMs: 30_000, label: 'issue rows' });
  await cdp.click(`document.querySelector('[data-issue-row]')`);
  await cdp.waitFor(`!!document.querySelector('a[data-open-on-github]')`, { timeoutMs: 15_000, label: 'issue detail' });
  const s = await cdp.evaluate(`(() => {
    const header = document.querySelector('h2.line-clamp-2').closest('.shrink-0');
    const a = header.querySelector('a[data-open-on-github]');
    return { label: a.getAttribute('aria-label'), copy: !!header.querySelector('button[aria-label="Copy link"]'), border: getComputedStyle(header).borderBottomWidth };
  })()`);
  log(`issue header: ${JSON.stringify(s)}`);
  await shot(cdp, '04-issue-header.png');
  assert(s.label === 'Open on GitHub (opens in browser)' && s.copy, 'Issue header uses the shared Open on GitHub and a Copy link button');
  assert(s.border === '0px', 'Issue header has no bottom border');
}

async function checkRightPane(cdp) {
  await cdp.click(`document.querySelector('[data-rail-toggle]')`);
  await cdp.waitFor(`document.querySelector('[data-rail-toggle]')?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'right pane open' });
  await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
  await cdp.waitFor(`!!document.querySelector('#right-pane-panel-title')`, { timeoutMs: 10_000, label: 'panel title' });
  const top = await cdp.evaluate(`Math.round(document.querySelector('#right-pane-panel-title').getBoundingClientRect().top)`);
  log(`right-pane panel title top: ${top}px`);
  await shot(cdp, '05-right-pane.png');
  assert(top < 32, 'Right pane header starts at the top, with no empty 40px band above it');
  await cdp.click(`document.querySelector('[data-rail-toggle]')`);
}

async function checkManageSessions(cdp) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.clickByText('Manage sessions', { tag: '[role="menuitem"]' }).catch(async () => {
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.includes('Manage sessions'))`);
  });
  await cdp.waitFor(`!!document.querySelector('[aria-label="Filter by project"]')`, { timeoutMs: 15_000, label: 'Manage sessions toolbar' });
  const trigger = `document.querySelector('[aria-label="Filter by project"]')`;
  const width = await cdp.evaluate(`Math.round(${trigger}.getBoundingClientRect().width)`);
  assert(width >= 150 && width <= 170, `Project filter trigger is the shared 160px picker width (${width}px)`);
  await cdp.click(trigger);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: 'select listbox' });
  await sleep(500);
  const geometry = await cdp.evaluate(`(() => { const t = ${trigger}.getBoundingClientRect(); const l = document.querySelector('[role="listbox"]').getBoundingClientRect(); return { triggerTop: t.top, triggerBottom: t.bottom, listTop: l.top, listBottom: l.bottom }; })()`);
  log(`select geometry: ${JSON.stringify(geometry)}`);
  await shot(cdp, '06-manage-sessions-select-open.png');
  assert(geometry.listTop >= geometry.triggerBottom - 1 || geometry.listBottom <= geometry.triggerTop + 1, 'The select list sits beside its trigger (popper), not over it');
  await pressEscape(cdp);
  await sleep(300);
  const ring = await cdp.evaluate(`(() => {
    const input = document.querySelector('input[type="search"], input[type="text"], input:not([type])');
    if (!input) return null;
    const before = getComputedStyle(input).boxShadow;
    input.setAttribute('aria-invalid', 'true');
    const after = getComputedStyle(input).boxShadow;
    return { before, after };
  })()`);
  log(`invalid ring: ${JSON.stringify(ring)}`);
  await shot(cdp, '07-invalid-field.png');
  assert(ring && ring.after !== ring.before && ring.after !== 'none', 'aria-invalid draws a ring on an Input');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  log(`verify-tauri-088: head ${head}, dirty=${dirty}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-088-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let child, cdp;
  let ok = false;
  try {
    const shimDir = tmp('shim');
    const dataDir = tmp('data');
    const importDir = tmp('import');
    const exeDir = tmp('exe');
    const agentDir = tmp('agent');
    const fakeGhDir = tmp('fakegh');
    const ghConfigDir = tmp('ghconfig');
    const repoDir = makeFakeGithubRepo(tmp('repo'));
    buildFakeGh(fakeGhDir);
    addIssueFixtures(fakeGhDir);
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_088_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    // The scratch app must never see a real GitHub credential, even though `gh` is faked.
    for (const key of Object.keys(process.env)) if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'].includes(key.toUpperCase())) delete process.env[key];
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: `${fakeGhDir};${shimDir}`,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        GH_CONFIG_DIR: ghConfigDir,
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        PI_CODING_AGENT_DIR: agentDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    const repoName = path.basename(repoDir);
    await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
    await createSessionViaQuickCreate(cdp, repoName);
    await cdp.waitFor(`!!document.querySelector('button[aria-label="Find in chat"]')`, { timeoutMs: 15_000, label: 'ChatHeader mounted' });
    await checkRightPane(cdp);
    await checkPullRequests(cdp);
    await checkIssues(cdp);
    await checkManageSessions(cdp);
    skip('text-request-cancel', 'No harness drives an omp text request into the RequestCard; the layout change is a one-element move covered by review.');
    await shot(cdp, '99-final.png');
    log(`verify-tauri-088: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, ok, checks: passed, screenshots: SHOTS, skipped: SKIPPED, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-088: FAIL');
  console.error(err);
  process.exitCode = 1;
});
