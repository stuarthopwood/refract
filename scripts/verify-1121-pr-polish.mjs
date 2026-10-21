#!/usr/bin/env node
// Live CDP check for issues #1120 (State select rendered at the default 32px, matching the
// adjacent SearchField), #1121 (check-status colour: passed/failed/pending/none), #1131 (the
// muted reason line under the detail header hidden for a state-only disable -- draft, closed,
// merged -- kept for a conflict, a blocked merge, or GitHub still computing mergeability) and
// #1132 (a ghost icon-only "Open on GitHub" link beside Refresh).
//
// A deterministic FAKE `gh` (never real GitHub -- `scripts/verify-1121-pr-polish-fake-gh.mjs`)
// exercises every check state and every pull request state these four issues care about in one
// run, never relying on whichever real pull requests happen to exist on `stuarthopwood/refract`
// today (`verify-tauri-568.mjs`/`verify-tauri-499-930.mjs`'s own real-clone approach, which
// cannot guarantee a draft/conflict/blocked/still-checking row exists). `owner_repo_for`
// (`src-tauri/src/github/gh.rs`) resolves purely from the scratch repository's local `origin`
// remote (`git remote get-url origin`, no network); every other `gh` call this feature makes
// (`pr list`, `pr view`, the Overview-timeline GraphQL query, the allowed-merge-methods probe,
// the changed-files REST call) is answered by a real, freshly-compiled `gh.exe` shim on the
// launched app's own `PATH` (a `.cmd`/`.bat` script is invisible to Windows' `CreateProcessW`,
// which only auto-appends `.exe` to a bare program name -- see
// `verify-1121-fake-gh-launcher.rs`'s own header comment).
//
// Rebuilds the exe fresh via `buildAndCopyExeFresh` (never trusts a possibly sibling-lane-
// clobbered shared-target binary); asserts a story-only bundle marker AFTER that build, then a
// live story-only DOM marker (`a[data-open-on-github]` in the running app) before judging any
// row (refract-ui-lane-gate-checklist: "assert a story-only DOM marker before judging any
// check"). The launched app gets no GitHub credentials: GH_TOKEN/GITHUB_TOKEN/
// GH_ENTERPRISE_TOKEN/GH_HOST are stripped and GH_CONFIG_DIR points at an empty scratch dir.
// `plugin:opener|open_url` is intercepted at `window.fetch` (the IPC custom-protocol request;
// Tauri makes `__TAURI_INTERNALS__.invoke` non-writable) before the one real activation this run
// makes on the new link, and a probe proves the hook is live first, so no real browser opens.
//
// Checks made, against the real rendered DOM:
//   - #1120: the State select's own rendered height equals the SearchField's, both exactly
//     32px, once the Filters disclosure is open.
//   - #1121: a passed/failed/pending/none row each colours its check icon AND word
//     (text-severity-success/error/warning/none, pending's icon still spins), both in the list
//     row and the detail header; State=All brings closed/merged rows into view too.
//   - #1131: draft, closed and merged each hide the visible reason line (the already-visible
//     StatePill is the reason) while the Review/Merge buttons' own tooltips still carry it and
//     stay disabled; a conflict, a blocked merge, and GitHub still-computing-mergeability each
//     keep the visible line, with the exact reason text `mapping.rs` computes.
//   - #1132: the new link's accessible name and role from the AX tree ("Open on GitHub (opens in
//     browser)", link), its tooltip (on both mouse hover and keyboard focus), its Tab position
//     right after Refresh, and that activating it requests
//     exactly the pull request's own `url` through the opener plugin -- intercepted, not a real
//     browser window.
//   - Dark, Dark (high contrast) and Obsidian screenshots, including a keyboard-focus shot of
//     the new button.

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  launchViaJobObject,
  stopLauncher,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import {
  gitHead,
  computeDirty,
  buildLauncher,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  citeScreenshots,
  assertExeUnchanged,
  getAccessibleNameAndRole
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { PR_FIXTURES, REASON, FAKE_OWNER, FAKE_REPO, buildFakeGh, makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1121_SHOTS_DIR || path.join(tmpdir(), 'refract-1121-pr-polish-shots');
const FAKE_URL = (number) => `https://github.com/${FAKE_OWNER}/${FAKE_REPO}/pull/${number}`;
const OPEN_ON_GITHUB_NAME = 'Open on GitHub (opens in browser)';
const OPEN_ON_GITHUB_TOOLTIP = 'Open on GitHub';
const OPEN_ON_GITHUB_LINK = `document.querySelector('a[data-open-on-github]')`;
// Radix's TooltipContent repeats its children in a visually hidden `role="tooltip"` span, so the
// raw textContent holds the text twice; strip that copy before comparing.
const VISIBLE_TOOLTIP_TEXTS = `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map((t) => { const c = t.cloneNode(true); c.querySelectorAll('[role="tooltip"]').forEach((n) => n.remove()); return c.textContent.trim(); })`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-1121-pr-polish: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

/** `launchBuiltExe` (verify-tauri-scratch-helpers.mjs) has no way to add a `PATH` entry, so this
 * is a local copy of its body with one addition: `fakeGhDir` is prepended to `PATH`, ahead of
 * any real `gh` installed on this machine, so `resolve_gh`'s `which::which_global("gh")` resolves
 * to this run's fixture-backed shim. */
async function launchWithFakeGh(launcherExe, exePath, { port, dataDir, importSourceDir, logFile, fakeGhDir, ghConfigDir }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    PATH: `${fakeGhDir}${path.delimiter}${process.env.PATH}`,
    GH_CONFIG_DIR: ghConfigDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir
  };
  // The scratch app must never see a real GitHub credential or host, even though `gh` is faked.
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) delete env[key];
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function assertBundleContainsStory1121Marker() {
  const bundleRoot = path.join(REPO_ROOT, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-1121-pr-polish: no built renderer bundle at ${bundleRoot} after buildAndCopyExeFresh -- the exe build did not produce the renderer bundle this check expects.`);
  }
  const grep = spawnSync('node', ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    function* walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); }
        else if (entry.name.endsWith('.js')) yield full;
      }
    }
    let found = false;
    for (const file of walk(${JSON.stringify(bundleRoot)})) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('data-open-on-github') && text.includes('data-merge-reason') && text.includes(${JSON.stringify(OPEN_ON_GITHUB_NAME)})) { found = true; break; }
    }
    console.log(found ? 'FOUND' : 'MISSING');
  `], { encoding: 'utf8' });
  assert(grep.stdout.includes('FOUND'), `#1131/#1132-only marker ("data-open-on-github" + "data-merge-reason" + "${OPEN_ON_GITHUB_NAME}") not found in the built renderer bundle -- the exe under test may not actually contain this lane's code`);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const report = { gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), checks: [], failures: [], notExercised: [], screenshots: [] };
  log(`verify-1121-pr-polish: git HEAD under test: ${report.gitHead}, dirty=${report.dirty}`);

  function checkPass(name, detail) {
    report.checks.push({ name, status: 'PASS', detail });
    log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function checkFail(name, detail) {
    report.checks.push({ name, status: 'FAIL', detail });
    report.failures.push(name);
    log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function notExercised(name, reason) {
    report.notExercised.push({ name, reason });
    log(`NOT EXERCISED: ${name} -- ${reason}`);
  }

  let dataDir, importSourceDir, shimDir, exeDir, fakeGhDir, repoDir, ghConfigDir;
  let child;
  let cdp;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-import-src-'));
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-exe-'));
    fakeGhDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-fake-gh-'));
    repoDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-repo-'));
    ghConfigDir = mkdtempSync(path.join(tmpdir(), 'refract-1121-gh-config-'));

    buildFakeGh(fakeGhDir);
    makeFakeGithubRepo(repoDir);
    log(`verify-1121-pr-polish: fake gh.exe at ${fakeGhDir}, scratch repo at ${repoDir}`);

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1121-pr-polish' });

    assertBundleContainsStory1121Marker();
    checkPass('#1131/#1132 bundle marker present in the freshly built renderer bundle');

    const port = await getFreePort();
    const launched = await launchWithFakeGh(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      logFile: path.join(SHOTS_DIR, 'app-run.log'),
      fakeGhDir,
      ghConfigDir
    });
    child = launched.child;
    const targetPid = launched.targetPid;
    cdp = await connectCdp(port, targetPid);
    assertExeMatchesProcess(targetPid, exePath, exeHash);
    log(`verify-1121-pr-polish: launched, pid ${targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready for Add repository' });

    await addRepository(cdp, repoDir);
    checkPass('Added fake scratch repository as a Project');

    await cdp.clickByText('Pull requests');
    await cdp.waitFor(`document.querySelector('h2') && document.querySelector('h2').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view mounted' });
    checkPass('Navigated to Pull requests view');

    const settled = await cdp.waitFor(`(() => {
      const err = document.querySelector('[role="alert"]');
      const rows = document.querySelectorAll('[data-pr-row]');
      return rows.length > 0 ? 'rows' : (err ? 'error' : null);
    })()`, { timeoutMs: 30_000, label: 'pull request list settles' });
    if (settled !== 'rows') {
      const errorText = settled === 'error' ? await cdp.evaluate(`document.querySelector('[role="alert"]').textContent`) : '(list never settled within 30s)';
      throw new Error(`pull request list never settled to real fixture rows: ${errorText}`);
    }
    checkPass('Fake pull request list settles to real fixture rows');

    async function openDetail(number) {
      // Gate-fix (self-caught): 10 fixture rows do not all fit in the list panel's visible
      // scrollable area at the default window size -- a raw coordinate click on a row below the
      // fold landed on whatever (if anything) was actually rendered at that screen position,
      // silently leaving the PREVIOUSLY selected row's detail showing, never the one this call
      // asked for. Scrolled into view first so the click always lands on the real row.
      await cdp.evaluate(`(() => { const el = document.querySelector('[data-pr-row][data-pr-number="${number}"]'); if (el) el.scrollIntoView({ block: 'center' }); return !!el; })()`);
      await cdp.click(`document.querySelector('[data-pr-row][data-pr-number="${number}"]')`);
      // Exact match on the heading's own number span (`{title} <span>#{number}</span>`), so
      // asking for #1 can never be satisfied by #10's heading.
      await cdp.waitFor(`(() => { const span = document.querySelector('h2.line-clamp-2 > span'); return !!span && span.textContent.trim() === '#${number}'; })()`, { timeoutMs: 15_000, label: `detail view for #${number} loaded` });
    }
    async function detailShape() {
      return cdp.evaluate(`(() => {
        const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0');
        if (!header) return null;
        const reasonLine = header.querySelector('[data-merge-reason]');
        const review = Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Review');
        const merge = Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Merge');
        return {
          reasonLineText: reasonLine ? reasonLine.textContent.trim() : null,
          reviewDisabled: review ? review.disabled : null,
          reviewTitle: review ? review.title : null,
          mergeDisabled: merge ? merge.disabled : null,
          mergeTitle: merge ? merge.title : null
        };
      })()`);
    }

    // ---- Live story marker: the running app's own DOM must carry this lane's new link before
    // any row or detail is judged. Throws (not a soft fail) so nothing below runs against a
    // binary without this lane's code. ----
    await openDetail(1);
    const liveMarker = await cdp.waitFor(`!!${OPEN_ON_GITHUB_LINK}`, { timeoutMs: 10_000, label: 'live story marker a[data-open-on-github] in the running app' }).catch(() => false);
    assert(liveMarker, 'live story marker a[data-open-on-github] absent from the running app\'s DOM -- the exe under test does not contain this lane\'s code');
    checkPass('Live story marker a[data-open-on-github] present in the running app');

    // ---- Default State=Open: the fixture's two non-open rows (#6 closed, #7 merged) must be
    // absent; every open row (including #5, a draft) must be present. ----
    const openNumbers = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-pr-row]')).map((el) => Number(el.getAttribute('data-pr-number'))).sort((a, b) => a - b)`);
    const expectedOpen = PR_FIXTURES.filter((p) => p.state === 'OPEN').map((p) => p.number).sort((a, b) => a - b);
    if (JSON.stringify(openNumbers) === JSON.stringify(expectedOpen)) {
      checkPass('Default State=Open list matches the fixture\'s open rows exactly', JSON.stringify(openNumbers));
    } else {
      checkFail('Default State=Open list matches the fixture\'s open rows exactly', `got ${JSON.stringify(openNumbers)}, expected ${JSON.stringify(expectedOpen)}`);
    }

    // ---- #1121: row check-status colour, both icon and word, list row ----
    async function rowCheckClass(number) {
      return cdp.evaluate(`(() => {
        const row = document.querySelector('[data-pr-row][data-pr-number="${number}"]');
        if (!row) return null;
        const spans = Array.from(row.querySelectorAll('span'));
        const span = spans.find((el) => ['Checks passed', 'Checks failed', 'Checks running', 'No checks'].includes(el.textContent.trim()));
        if (!span) return null;
        const icon = span.querySelector('svg');
        return { className: span.className, spinning: icon ? icon.getAttribute('class').includes('animate-spin') : null, label: span.textContent.trim() };
      })()`);
    }
    const rowChecks = [
      [1, 'text-severity-success', false, 'Checks passed'],
      [2, 'text-severity-error', false, 'Checks failed'],
      [3, 'text-severity-warning', true, 'Checks running'],
      [4, null, false, 'No checks']
    ];
    for (const [number, expectedClass, expectSpin, expectedLabel] of rowChecks) {
      const shape = await rowCheckClass(number);
      const name = `Row #${number} check status ("${expectedLabel}") colours icon+word correctly`;
      if (!shape) {
        checkFail(name, 'row or check span not found');
        continue;
      }
      const hasExpectedClass = expectedClass ? shape.className.includes(expectedClass) : !/text-severity-/.test(shape.className);
      const spinOk = shape.spinning === expectSpin;
      const labelOk = shape.label === expectedLabel;
      if (hasExpectedClass && spinOk && labelOk) checkPass(name, JSON.stringify(shape));
      else checkFail(name, JSON.stringify(shape));
    }

    // ---- #1120: Filters disclosure -> State select height equals the SearchField's ----
    await cdp.click(`document.querySelector('[aria-label^="Filters"]')`);
    await cdp.waitFor(`!!document.getElementById('pull-request-filters-panel')`, { timeoutMs: 10_000, label: 'Filters disclosure open' });
    const heights = await cdp.evaluate(`(() => {
      const trigger = document.querySelector('[aria-label="State"]');
      const search = document.querySelector('input[aria-label="Filter pull requests by title or label"]');
      const searchWrapper = search ? search.closest('.relative') : null;
      return {
        stateHeight: trigger ? getComputedStyle(trigger).height : null,
        searchHeight: searchWrapper ? getComputedStyle(searchWrapper).height : null
      };
    })()`);
    if (heights.stateHeight && heights.stateHeight === heights.searchHeight && heights.stateHeight === '32px') {
      checkPass('State select renders at the same 32px height as the SearchField', JSON.stringify(heights));
    } else {
      checkFail('State select renders at the same 32px height as the SearchField', JSON.stringify(heights));
    }

    // ---- #1120/#1121 extended: State=All brings Closed/Merged rows into view ----
    await cdp.click(`document.querySelector('[aria-label="State"]')`);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === 'All')`, { timeoutMs: 10_000, label: 'State select open' });
    await cdp.clickByText('All', { tag: '[role="option"]' }).catch(async () => {
      await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === 'All')`);
    });
    const allNumbers = await cdp.waitFor(`(() => {
      const nums = Array.from(document.querySelectorAll('[data-pr-row]')).map((el) => Number(el.getAttribute('data-pr-number'))).sort((a, b) => a - b);
      return nums.includes(6) && nums.includes(7) ? JSON.stringify(nums) : null;
    })()`, { timeoutMs: 15_000, label: 'State=All list includes #6 and #7' }).catch(() => null);
    if (allNumbers) checkPass('State=All brings Closed (#6) and Merged (#7) rows into view', allNumbers);
    else checkFail('State=All brings Closed (#6) and Merged (#7) rows into view', 'rows #6/#7 never appeared');

    // ---- #1131: detail-view reason line, per PR ----
    const stateOnlyCases = [
      [5, REASON.draft, 'draft'],
      [6, REASON.closed, 'closed'],
      [7, REASON.merged, 'merged']
    ];
    for (const [number, reason, label] of stateOnlyCases) {
      await openDetail(number);
      const shape = await detailShape();
      const name = `#${number} (${label}): reason line hidden, pill is the reason, tooltip keeps reason`;
      const ok = shape && shape.reasonLineText === null && shape.reviewDisabled === true && shape.reviewTitle === reason && shape.mergeDisabled === true && shape.mergeTitle === reason;
      if (ok) checkPass(name, JSON.stringify(shape));
      else checkFail(name, JSON.stringify(shape));
    }

    const blockedCases = [
      [8, REASON.conflict, 'conflict'],
      [9, REASON.blocked, 'blocked'],
      [10, REASON.stillChecking, 'still checking']
    ];
    for (const [number, reason, label] of blockedCases) {
      await openDetail(number);
      const shape = await detailShape();
      const name = `#${number} (${label}): reason line visible with the exact reason text, Review stays enabled`;
      const ok = shape && shape.reasonLineText === reason && shape.reviewDisabled === false && shape.mergeDisabled === true && shape.mergeTitle === reason;
      if (ok) checkPass(name, JSON.stringify(shape));
      else checkFail(name, JSON.stringify(shape));
    }

    // ---- #1121 (detail header) + #1132 (Open on GitHub) on a plain passing-open PR (#1) ----
    await openDetail(1);
    const detailCheckShape = await cdp.evaluate(`(() => {
      const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0');
      const span = header ? Array.from(header.querySelectorAll('span')).find((el) => el.textContent.trim() === 'Checks passed') : null;
      return span ? { className: span.className } : null;
    })()`);
    if (detailCheckShape && detailCheckShape.className.includes('text-severity-success')) {
      checkPass('Detail header check status colours "Checks passed" text-severity-success', JSON.stringify(detailCheckShape));
    } else {
      checkFail('Detail header check status colours "Checks passed" text-severity-success', JSON.stringify(detailCheckShape));
    }

    const linkShape = await cdp.evaluate(`(() => {
      const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0');
      const link = ${OPEN_ON_GITHUB_LINK};
      const refresh = header ? header.querySelector('button[aria-label="Refresh this pull request"]') : null;
      if (!link || !refresh) return null;
      const actionRow = refresh.parentElement;
      const children = actionRow ? Array.from(actionRow.querySelectorAll('button, a')) : [];
      const refreshIdx = children.indexOf(refresh);
      const linkIdx = children.indexOf(link.closest('button') ?? link);
      return {
        tagName: link.tagName,
        href: link.href,
        target: link.getAttribute('target'),
        rel: link.getAttribute('rel'),
        ariaLabel: link.getAttribute('aria-label'),
        immediatelyAfterRefresh: linkIdx === refreshIdx + 1
      };
    })()`);
    const linkAx = await getAccessibleNameAndRole(cdp, OPEN_ON_GITHUB_LINK);
    const expectedHref = FAKE_URL(1);
    const linkOk = linkShape && linkShape.tagName === 'A' && linkShape.href === expectedHref && linkShape.target === '_blank' && /noreferrer/.test(linkShape.rel ?? '') && /noopener/.test(linkShape.rel ?? '') && linkShape.immediatelyAfterRefresh
      && linkShape.ariaLabel === OPEN_ON_GITHUB_NAME && linkAx.role === 'link' && linkAx.name === OPEN_ON_GITHUB_NAME;
    const linkCheckName = `Open on GitHub link: real <a>, AX role link named "${OPEN_ON_GITHUB_NAME}", correct href/target/rel, right after Refresh in Tab order`;
    if (linkOk) checkPass(linkCheckName, JSON.stringify({ linkShape, linkAx }));
    else checkFail(linkCheckName, JSON.stringify({ linkShape, linkAx, expectedHref }));

    // Mouse hover: move the real pointer onto the link's centre; its tooltip must show.
    const linkRect = await cdp.evaluate(`(() => { const el = ${OPEN_ON_GITHUB_LINK}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    let hoverTooltip = null;
    if (linkRect) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: linkRect.x, y: linkRect.y });
      hoverTooltip = await cdp.waitFor(`${VISIBLE_TOOLTIP_TEXTS}.find((t) => t === ${JSON.stringify(OPEN_ON_GITHUB_TOOLTIP)}) ?? null`, { timeoutMs: 5_000, label: 'tooltip shows on mouse hover' }).catch(() => null);
    }
    if (hoverTooltip === OPEN_ON_GITHUB_TOOLTIP) {
      checkPass('Mouse hover on Open on GitHub shows its tooltip', hoverTooltip);
    } else {
      checkFail('Mouse hover on Open on GitHub shows its tooltip', JSON.stringify({ linkRect, hoverTooltip, visible: await cdp.evaluate(VISIBLE_TOOLTIP_TEXTS) }));
    }

    // Keyboard focus: Tab from the Refresh button lands on the link next; tooltip shows. Clicking
    // Refresh moves the pointer off the link, so the hover tooltip above closes first.
    await cdp.click(`document.querySelector('button[aria-label="Refresh this pull request"]')`);
    await cdp.waitFor(`!${VISIBLE_TOOLTIP_TEXTS}.includes(${JSON.stringify(OPEN_ON_GITHUB_TOOLTIP)})`, { timeoutMs: 5_000, label: 'hover tooltip closed before the keyboard check' }).catch(() => null);
    await pressTab(cdp);
    const focusedIsLink = await cdp.waitFor(`!!document.activeElement && document.activeElement.hasAttribute('data-open-on-github')`, { timeoutMs: 5_000, label: 'Tab from Refresh lands on Open on GitHub' }).catch(() => false);
    const tooltipText = focusedIsLink
      ? await cdp.waitFor(`${VISIBLE_TOOLTIP_TEXTS}.find((t) => t === ${JSON.stringify(OPEN_ON_GITHUB_TOOLTIP)}) ?? null`, { timeoutMs: 5_000, label: 'tooltip shows on keyboard focus' }).catch(() => null)
      : null;
    if (focusedIsLink && tooltipText === OPEN_ON_GITHUB_TOOLTIP) {
      checkPass('Keyboard Tab from Refresh reaches Open on GitHub, tooltip shows on focus', tooltipText);
    } else {
      checkFail('Keyboard Tab from Refresh reaches Open on GitHub, tooltip shows on focus', JSON.stringify({ focusedIsLink, tooltipText }));
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-open-on-github-focused.png'));

    // Activating it requests exactly this pull request's URL through the opener plugin --
    // intercepted at the Tauri IPC boundary, never a real browser window. Tauri's injected
    // init script defines __TAURI_INTERNALS__.invoke/ipc/postMessage as non-writable, so the hook
    // goes on window.fetch, which the custom-protocol IPC calls at dispatch time.
    const openerCheckName = 'Activating Open on GitHub requests the pull request\'s own URL through the opener plugin (intercepted)';
    const hook = await cdp.evaluate(`(async () => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.convertFileSrc !== 'function') return { ok: false, why: 'no __TAURI_INTERNALS__.convertFileSrc' };
      const openerUrl = internals.convertFileSrc('plugin:opener|open_url', 'ipc');
      const probeUrl = internals.convertFileSrc('verify1121|probe', 'ipc');
      window.__verify1121OpenerCalls = [];
      window.__verify1121ProbeCalls = 0;
      const original = window.fetch;
      const patched = function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url;
        if (url === openerUrl || url === probeUrl) {
          if (url === openerUrl) window.__verify1121OpenerCalls.push(JSON.parse(init.body));
          else window.__verify1121ProbeCalls += 1;
          return Promise.resolve(new Response('null', { headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } }));
        }
        return original.apply(this, arguments);
      };
      window.fetch = patched;
      if (window.fetch !== patched) return { ok: false, why: 'window.fetch is not writable' };
      // Never reaches Rust: the hook answers it. Proves the hook sits on the live invoke path.
      await Promise.race([internals.invoke('verify1121|probe', {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (window.__verify1121ProbeCalls !== 1) return { ok: false, why: 'probe invoke bypassed the fetch hook', probeCalls: window.__verify1121ProbeCalls };
      const link = ${OPEN_ON_GITHUB_LINK};
      if (link) link.focus();
      return { ok: true, openerUrl, focused: !!link && document.activeElement === link };
    })()`).catch((error) => ({ ok: false, why: String(error) }));
    if (!hook?.ok || !hook.focused) {
      checkFail(openerCheckName, `hook not live or link not focused, Enter not sent: ${JSON.stringify(hook)}`);
    } else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
      await sleep(300);
      const openerCalls = await cdp.evaluate(`window.__verify1121OpenerCalls ?? []`);
      if (Array.isArray(openerCalls) && openerCalls.length === 1 && openerCalls[0]?.url === expectedHref) {
        checkPass(openerCheckName, JSON.stringify({ openerCalls, openerUrl: hook.openerUrl }));
      } else {
        checkFail(openerCheckName, JSON.stringify({ openerCalls, expectedHref }));
      }
    }

    await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-pull-requests.png'));

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await openDetail(8);
    const hcShape = await detailShape();
    await cdp.screenshot(path.join(SHOTS_DIR, '03-theme-dark-high-contrast-conflict-reason.png'));
    if (hcShape && hcShape.reasonLineText === REASON.conflict) {
      checkPass('Dark (high contrast): PR #8 conflict reason line visible, screenshot captured', JSON.stringify(hcShape));
    } else {
      checkFail('Dark (high contrast): PR #8 conflict reason line visible, screenshot captured', JSON.stringify(hcShape));
    }

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await openDetail(5);
    const obsidianShape = await detailShape();
    await cdp.screenshot(path.join(SHOTS_DIR, '04-theme-obsidian-draft-no-reason-line.png'));
    if (obsidianShape && obsidianShape.reasonLineText === null) {
      checkPass('Obsidian: PR #5 draft reason line hidden, screenshot captured', JSON.stringify(obsidianShape));
    } else {
      checkFail('Obsidian: PR #5 draft reason line hidden, screenshot captured', JSON.stringify(obsidianShape));
    }

    notExercised('Real screen-reader pass of the Open on GitHub link', 'needs a human with NVDA/Narrator (issue #650); the AX-tree name and role above are the automated proxy');

    report.screenshots = citeScreenshots(SHOTS_DIR, [
      '01-dark-open-on-github-focused.png',
      '02-dark-pull-requests.png',
      '03-theme-dark-high-contrast-conflict-reason.png',
      '04-theme-obsidian-draft-no-reason-line.png'
    ]);

    assertExeUnchanged(exePath, exeHash, 'end of run', 'verify-1121-pr-polish');
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-1121-pr-polish: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      log(`verify-1121-pr-polish: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = 1;
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    if (dataDir) await safeRmSync(dataDir);
    if (importSourceDir) await safeRmSync(importSourceDir);
    if (shimDir) await safeRmSync(shimDir);
    if (exeDir) await safeRmSync(exeDir);
    if (fakeGhDir) await safeRmSync(fakeGhDir);
    if (repoDir) await safeRmSync(repoDir);
    if (ghConfigDir) await safeRmSync(ghConfigDir);
  }
}

main().catch((err) => {
  console.error('verify-1121-pr-polish: FAIL');
  console.error(err);
  process.exitCode = 1;
});
