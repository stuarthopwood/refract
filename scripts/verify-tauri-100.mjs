#!/usr/bin/env node
// Live CDP check for spec 100 (issue #1501, spec 088 follow-ups): PR and Issue header flex shape, visible Review/Merge reasons,
// CopyButton and Open on GitHub parity, popper select alignment, and the invalid field ring on Input, Textarea and the Select
// trigger. Runs a built Tauri debug exe with a fake `gh` and fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_100_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-100.mjs

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
const SHOTS_DIR = process.env.REFRACT_100_SHOTS_DIR || path.join(tmpdir(), 'refract-100-shots');
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

// Only these variables reach the scratch app, so a real credential in the parent environment cannot leak into it.
const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'HOMEDRIVE', 'HOMEPATH', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'CARGO_TARGET_DIR']);
function restrictEnvToAllowList() {
  for (const key of Object.keys(process.env)) if (!ENV_ALLOW.has(key.toUpperCase())) delete process.env[key];
}

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

// Focus-ring probe: returns the computed paint of an element once focused (keyboard-style via .focus()).
const ringProbe = (selector) => `(() => {
  const el = ${selector};
  el.focus();
  const cs = getComputedStyle(el);
  return { boxShadow: cs.boxShadow, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, border: cs.borderTopColor, focusVisible: el.matches(':focus-visible') };
})()`;

// A real keydown puts the page in keyboard modality so a scripted .focus() matches :focus-visible.
async function primeKeyboard(cdp) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 16, key: 'Shift', code: 'ShiftLeft' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 16, key: 'Shift', code: 'ShiftLeft' });
}

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
    const review = find('Review');
    const title = header.querySelector('h2').parentElement;
    const actions = header.querySelector('a[data-open-on-github]').parentElement;
    const text = (sel) => header.querySelector(sel)?.textContent.trim() ?? null;
    return {
      newSession: !!session,
      mergeClass: merge ? merge.className : null,
      mergeTitle: merge ? merge.getAttribute('title') : null,
      reviewTitle: review ? review.getAttribute('title') : null,
      draftReason: text('[data-draft-reason]'),
      reviewReason: text('[data-review-reason]'),
      mergeReason: text('[data-merge-reason]'),
      titleGrows: getComputedStyle(title).flexGrow,
      titleMinWidth: getComputedStyle(title).minWidth,
      actionsWrap: getComputedStyle(actions).flexWrap
    };
  })()`);
  await open(1);
  const openPr = await shape();
  log(`open PR header: ${JSON.stringify(openPr)}`);
  await shot(cdp, '01-pr-open-header.png');
  assert(openPr.mergeClass && /border-button-outline-border/.test(openPr.mergeClass) && !/bg-primary/.test(openPr.mergeClass), 'Merge carries border-button-outline-border and is not filled');
  assert(openPr.titleGrows === '1' && openPr.titleMinWidth === '200px' && openPr.actionsWrap === 'wrap', 'PR title grows with a 200px minimum and the action row wraps');

  const anchor = await cdp.evaluate(`(() => { const a = ${headerOf}.querySelector('a[data-open-on-github]'); return { type: a.getAttribute('type'), tag: a.tagName }; })()`);
  assert(anchor.tag === 'A' && anchor.type === null, 'Open on GitHub anchor does not carry type="button"');

  const targets = await cdp.evaluate(`(() => {
    const header = ${headerOf};
    const copy = header.querySelector('button[aria-label="Copy link"]').getBoundingClientRect();
    return { copyW: Math.round(copy.width), copyH: Math.round(copy.height) };
  })()`);
  assert(targets.copyW >= 24 && targets.copyH >= 24, `Copy link target is at least 24px (${targets.copyW}x${targets.copyH})`);
  await primeKeyboard(cdp);
  const copyFocus = await cdp.evaluate(ringProbe(`${headerOf}.querySelector('button[aria-label="Copy link"]')`));
  const refreshFocus = await cdp.evaluate(ringProbe(`${headerOf}.querySelector('button[aria-label="Refresh this pull request"]')`));
  log(`focus parity: copy ${JSON.stringify(copyFocus)} refresh ${JSON.stringify(refreshFocus)}`);
  await shot(cdp, '02-copy-focus.png');
  assert(copyFocus.outlineStyle === refreshFocus.outlineStyle && copyFocus.outlineWidth === refreshFocus.outlineWidth && copyFocus.boxShadow === refreshFocus.boxShadow && (copyFocus.boxShadow !== 'none' || copyFocus.outlineStyle !== 'none'), 'Copy link shows a focus ring that matches Refresh');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await cdp.evaluate(`(() => {
    const header = ${headerOf};
    const merge = Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Merge');
    const number = header.querySelector('h2 > span').getBoundingClientRect();
    return { mergeRight: Math.round(merge.getBoundingClientRect().right), numberRight: Math.round(number.right), headerRight: Math.round(header.getBoundingClientRect().right) };
  })()`);
  log(`narrow PR header: ${JSON.stringify(narrow)}`);
  await shot(cdp, '03-pr-narrow-header.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride', {});
  assert(narrow.mergeRight <= narrow.headerRight && narrow.numberRight <= narrow.headerRight, 'Merge and #number are not clipped in a 960px viewport');

  await open(5);
  const draft = await shape();
  log(`draft PR header: ${JSON.stringify(draft)}`);
  await shot(cdp, '04-pr-draft-header.png');
  assert(draft.newSession, 'The New session button exists in the draft header');
  assert(draft.draftReason === 'Draft pull requests cannot start a Session.', 'Draft PR shows the visible draft reason line');
  assert(draft.reviewReason !== null && draft.reviewReason.startsWith('Review: ') && draft.reviewTitle !== null && draft.reviewReason.endsWith(draft.reviewTitle), 'The draft PR review reason is a visible "Review:" line and the tooltip title is kept');

  await open(8);
  const conflict = await shape();
  log(`conflict PR header: ${JSON.stringify(conflict)}`);
  await shot(cdp, '05-pr-conflict-header.png');
  assert(conflict.mergeReason !== null && conflict.mergeReason.startsWith('Merge: ') && conflict.mergeTitle !== null && conflict.mergeReason.endsWith(conflict.mergeTitle), 'The merge reason is a visible "Merge:" line and the tooltip title is kept');

  await open(1);
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Review')`);
  await cdp.waitFor(`!!document.querySelector('textarea[aria-label="Review body"]')`, { timeoutMs: 10_000, label: 'Review dialog textarea' });
  await invalidRing(cdp, `document.querySelector('textarea[aria-label="Review body"]')`, 'Textarea', '06-invalid-textarea.png');
  await pressEscape(cdp);
  await sleep(300);
}

async function checkIssues(cdp) {
  await cdp.clickByText('Issues');
  await cdp.waitFor(`!!document.querySelector('[data-issue-row]')`, { timeoutMs: 30_000, label: 'issue rows' });
  await cdp.click(`document.querySelector('[data-issue-row]')`);
  await cdp.waitFor(`!!document.querySelector('a[data-open-on-github]')`, { timeoutMs: 15_000, label: 'issue detail' });
  const s = await cdp.evaluate(`(() => {
    const header = ${headerOf};
    const title = header.querySelector('h2').parentElement;
    const actions = header.querySelector('a[data-open-on-github]').parentElement;
    return {
      copy: !!header.querySelector('button[aria-label="Copy link"]'),
      newSession: Array.from(header.querySelectorAll('button')).some((b) => b.textContent.trim() === 'New session'),
      titleGrows: getComputedStyle(title).flexGrow,
      titleMinWidth: getComputedStyle(title).minWidth,
      outerWrap: getComputedStyle(title.parentElement).flexWrap,
      actionsWrap: getComputedStyle(actions).flexWrap,
      noDrag: actions.classList.contains('no-drag-region')
    };
  })()`);
  log(`issue header: ${JSON.stringify(s)}`);
  await shot(cdp, '07-issue-header.png');
  assert(s.copy && s.newSession, 'Issue header has Copy link and New session');
  assert(s.titleGrows === '1' && s.titleMinWidth === '200px' && s.actionsWrap === 'wrap' && s.noDrag, 'Issue header matches the PR shape: growing 200px-min title, wrapping no-drag actions');
}

// Sets aria-invalid on `selector`, focuses it and asserts the destructive border stays while focused; shoots the focused state.
async function invalidRing(cdp, selector, label, shotName) {
  const probe = () => cdp.evaluate(`(() => {
    const el = ${selector};
    const span = document.createElement('span');
    span.style.color = 'var(--destructive)';
    document.body.appendChild(span);
    const destructive = getComputedStyle(span).color;
    span.remove();
    const cs = getComputedStyle(el);
    return { boxShadow: cs.boxShadow, border: cs.borderTopColor, destructive, focusVisible: el.matches(':focus-visible') };
  })()`);
  await cdp.evaluate(`${selector}.blur()`);
  const before = await probe();
  await cdp.evaluate(`${selector}.setAttribute('aria-invalid', 'true')`);
  await sleep(400);
  const invalid = await probe();
  assert(invalid.boxShadow !== before.boxShadow && invalid.boxShadow !== 'none', `aria-invalid draws a ring on the ${label}`);
  await primeKeyboard(cdp);
  await cdp.evaluate(`${selector}.focus()`);
  await sleep(400);
  const focused = await probe();
  log(`${label} invalid ring: ${JSON.stringify({ before: before.boxShadow, invalid: invalid.boxShadow, focused: focused.border, destructive: focused.destructive, focusVisible: focused.focusVisible })}`);
  await shot(cdp, shotName);
  assert(focused.focusVisible && focused.border === focused.destructive, `A focused invalid ${label} keeps the destructive border`);
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
  const geometry = await cdp.evaluate(`(() => { const t = ${trigger}.getBoundingClientRect(); const l = document.querySelector('[role="listbox"]').getBoundingClientRect(); return { triggerLeft: t.left, triggerTop: t.top, triggerBottom: t.bottom, listLeft: l.left, listTop: l.top, listBottom: l.bottom }; })()`);
  log(`select geometry: ${JSON.stringify(geometry)}`);
  await shot(cdp, '08-manage-sessions-select-open.png');
  assert(geometry.listTop >= geometry.triggerBottom - 1 || geometry.listBottom <= geometry.triggerTop + 1, 'The select list sits beside its trigger (popper), not over it');
  assert(Math.abs(geometry.listLeft - geometry.triggerLeft) <= 2, 'The select list is start-aligned with its trigger');
  await pressEscape(cdp);
  await sleep(300);

  const INPUT = `document.querySelector('input[type="search"], input[type="text"], input:not([type])')`;
  await primeKeyboard(cdp);
  const inputFocus = await cdp.evaluate(ringProbe(INPUT));
  const triggerFocus = await cdp.evaluate(ringProbe(trigger));
  log(`field ring parity: input ${JSON.stringify(inputFocus)} trigger ${JSON.stringify(triggerFocus)}`);
  assert(inputFocus.boxShadow !== 'none' && inputFocus.boxShadow === triggerFocus.boxShadow, 'The Select trigger focus ring uses the same width as an Input (--field-ring-width)');
  await cdp.evaluate(`${INPUT}.blur()`);
  await invalidRing(cdp, INPUT, 'Input', '09-invalid-input.png');
  await invalidRing(cdp, trigger, 'Select trigger', '10-invalid-select-trigger.png');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  log(`verify-tauri-100: head ${head}, dirty=${dirty}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-100-${name}-`));
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
    const src = process.env.REFRACT_100_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    restrictEnvToAllowList();
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
    await checkPullRequests(cdp);
    await checkIssues(cdp);
    await checkManageSessions(cdp);
    skip('text-request-cancel', 'No harness drives an omp text request into the RequestCard.');
    await shot(cdp, '99-final.png');
    log(`verify-tauri-100: ALL PASS (${passed} checks) at head ${head}`);
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
  console.error('verify-tauri-100: FAIL');
  console.error(err);
  process.exitCode = 1;
});
