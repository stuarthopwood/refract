#!/usr/bin/env node
// Live CDP check for issue #802 (bug: two vertical scrollbars at the right edge of the Side chat
// panel when the answer is taller than the pane). Modelled directly on
// `verify-439-history-truncate.mjs`/`verify-862-conversation-history.mjs`'s own guarded-tmpdir,
// fresh-exe-copy, themed-screenshot pattern; drives the real UI (rail click, typed question,
// Enter, the pane's own Min/Max width-preset buttons), never `window.refract.*` directly, so the
// measurement below sees the exact DOM a real developer would.
//
// GATE ROUND 1 RESULT (build slot granted 2026-10-18): GREEN at commit `20cce39`/`592e431`
// (fixed code, `SideChatPanel.tsx` root `min-h-0 flex-1`) passed clean. A RED probe (root
// `className` reverted to the pre-fix `h-full` on a throwaway branch, rebuilt) STILL showed
// exactly 1 scroll container with the SAME identity -- reverting the className alone did NOT
// reproduce a second scroll container. This falsified the claim that `SideChatPanel.tsx`'s
// `h-full`-vs-`flex-1` choice is, by itself, the cause of the reported bug (full writeup on
// issue #802 and PR #1014).
//
// GATE ROUND 2 (Main, 2026-10-18): the round 1 fixture never actually matched the issue's own
// reported content shape or the issue's own acceptance criteria, so the RED probe's failure to
// reproduce proves the FIXTURE was insufficient, not that the bug is unconfirmable. Rebuilt here
// to match the issue literally:
//   - The fixture's own answer now carries a genuinely WIDE markdown table (4 columns of long
//     unbroken tokens, ~265 characters per row -- far wider than `RIGHT_PANE_MAX_WIDTH_PX`, the
//     pane's own 520px maximum, regardless of font metrics) and a long code block (45 lines,
//     several deliberately unbroken ~130-character lines), alongside the existing 40-item
//     bulleted list and prose -- exactly the issue's own "a wide table and a long code block"
//     acceptance wording.
//   - The scroll probe below is extended to scan EVERY element on the page (not only the right
//     pane's own ancestor chain) for a genuinely RENDERED vertical scrollbar:
//     `(offsetWidth - clientWidth) > 0 && scrollHeight > clientHeight`. This is a stricter, more
//     direct test than "computed overflow-y is auto/scroll" (which can be true with nothing
//     actually rendered): it only matches an element whose own scrollbar gutter is genuinely
//     consuming layout space. Main's own hypothesis, read from `Markdown.tsx`: the table wrapper
//     (~833, `overflow-x-auto rounded-md border`) and the code-block wrapper (~181,
//     `scrollableClassName`, also `overflow-x-auto`) both set ONLY `overflow-x` -- per the CSS
//     Overflow spec, when `overflow-x` is non-`visible` and `overflow-y` is left unset,
//     `overflow-y`'s own COMPUTED value resolves to `auto` too (never `visible`). If subpixel
//     rounding or the horizontal scrollbar's own height ever pushes either wrapper's
//     `scrollHeight` past its `clientHeight`, the browser would draw a genuine SECOND vertical
//     scrollbar right there, inside the Side chat panel's own already-scrolling answer region --
//     at the SAME right edge Stuart described, not "a pair across the divider". This is a
//     hypothesis, not yet a verdict: the RED/GREEN runs below are what will actually confirm or
//     falsify it.
//   - The script now drives the pane to both `RIGHT_PANE_MIN_WIDTH_PX` (240px, the "Min" preset
//     button) and `RIGHT_PANE_MAX_WIDTH_PX` (520px, "Max") via `WidthPresetControl.tsx`'s own
//     `[aria-label="Pane width"]` button group, and checks under both Dark and Dark (high
//     contrast) -- the exact 2-width/2-theme matrix the issue's own Acceptance section names
//     ("screenshots Dark and High contrast, 240 px and 520 px pane widths").
//
// WRITTEN, NOT RUN (this round): the build slot was handed back to #911 before this rebuild
// could be verified live. `node --check` is the only command run against this revision; the
// RED-then-GREEN run plan (RED first, root className reverted to `h-full` on a local-only probe
// branch, expecting the probe to NAME a second scroller this time; then the real fix; then
// GREEN) is queued for whenever Main grants the slot back.
//
// What this script does NOT prove (recorded in its own `notExercised`):
//   - The main transcript and the Agents panel staying at exactly one scroll container under the
//     same stress (the issue's own acceptance list includes them) -- out of scope for this
//     script, which is scoped to the Side chat panel only; neither panel changed in this PR.
//   - A streaming answer (deltas arriving over several `btw_delta` push frames while the panel is
//     open) -- the fixture's own `btw` response already carries the full, complete answer in one
//     frame; a streaming answer that grows the scroll container's own height frame-by-frame
//     while still mid-turn is a different code path this run does not cover.
//   - Whether a wide table or long code block elsewhere in the app (the main transcript, a tool
//     call's Arguments/Output) can trigger the same CSS-spec overflow-y coupling -- this fixture
//     and script are scoped to the Side chat panel only.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR =
  process.env.REFRACT_802_SHOTS_DIR || path.join(tmpdir(), `refract-802-side-chat-scrollbars-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);

// The issue's own Acceptance section names exactly these two themes and two pane widths
// (RIGHT_PANE_MIN_WIDTH_PX/RIGHT_PANE_MAX_WIDTH_PX, right-pane-store.ts), reachable via
// WidthPresetControl.tsx's own "Min"/"Max" buttons -- never a drag gesture, which CDP cannot
// perform reliably.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];
const WIDTHS = [
  { px: 240, label: 'Min' },
  { px: 520, label: 'Max' }
];
const MATRIX = [];
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    MATRIX.push({ theme, width, shot: `side-chat-${theme.id}-${width.px}px.png` });
  }
}
const SHOT_NAMES = [...MATRIX.map((m) => m.shot), 'report.json', 'app.log', 'fake-omp-invocations.log'];

const QUESTION = 'Give me a long answer with a bulleted list, a wide table, and a long code block.';
const LAST_LINE_MARKER = 'ISSUE802-LAST-LINE-MARKER';
const RIGHT_PANE_SELECTOR = '#right-pane-active-panel';

/** Scans TWO candidate sets for a genuinely RENDERED vertical scrollbar
 * (`(offsetWidth - clientWidth) > 0 && scrollHeight > clientHeight` -- the scrollbar gutter is
 * actually consuming layout space, not merely a computed `overflow-y` value with nothing to
 * show): (a) `scopedCandidates`, the right pane's own `react-resizable-panels` `Panel` wrapper
 * (found by walking UP from `RIGHT_PANE_SELECTOR` via `.closest('[data-panel]')` -- an ANCESTOR
 * of that selector, never a descendant) plus its entire subtree (which includes the library's
 * own inner `overflow:auto` div, `RIGHT_PANE_SELECTOR` itself, and every Markdown-rendered
 * element inside the Side chat answer, including the wide table and code-block wrappers) and
 * every ancestor of that Panel wrapper up to `document.body`; (b) `pageCandidates`, literally
 * every element in the document, per Main's own instruction to list EVERY element on the page,
 * not only the panel's own ancestry (gate round 2). Each match's own `data-*` attributes,
 * computed `overflow-x`/`overflow-y`, bounding rect, and scroll/client/offset metrics are
 * included so a failure names exactly which element(s) collided. `horizontalOverflow` is
 * diagnostic only (never gates pass/fail): the issue's own acceptance explicitly ALLOWS the wide
 * table and long code block to scroll horizontally. */
const SCROLL_PROBE_EXPR = `(() => {
  const anchor = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)});
  if (!anchor) return null;
  const panel = anchor.closest('[data-panel]') ?? anchor;
  const subtree = [panel, ...panel.querySelectorAll('*')];
  const ancestors = [];
  for (let el = panel.parentElement; el; el = el.parentElement) {
    ancestors.push(el);
    if (el === document.body) break;
  }
  const scopedCandidates = [...subtree, ...ancestors];
  const pageCandidates = Array.from(document.querySelectorAll('*'));
  const describe = (el) => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      className: el.className || null,
      id: el.id || null,
      dataAttrs: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      offsetWidth: el.offsetWidth,
      clientWidth: el.clientWidth
    };
  };
  const hasRenderedVerticalScrollbar = (el) => (el.offsetWidth - el.clientWidth) > 0 && el.scrollHeight > el.clientHeight;
  const scopedScrollers = scopedCandidates.filter(hasRenderedVerticalScrollbar).map(describe);
  const pageWideScrollers = pageCandidates.filter(hasRenderedVerticalScrollbar).map(describe);
  // .sr-only (screen-reader-only) elements are DELIBERATELY clipped to a 1x1px box by the
  // standard accessibility technique; excluded here (and any element nested inside one) so this
  // diagnostic measures real, visible horizontal overflow only.
  const horizontalOverflow = scopedCandidates.filter((el) => el.scrollWidth > el.clientWidth && !el.closest('.sr-only')).map(describe);
  return { scopedScrollers, pageWideScrollers, horizontalOverflow };
})()`;

async function measureScrollContainers(cdp) {
  const result = await cdp.evaluate(SCROLL_PROBE_EXPR);
  if (!result) throw new Error(`verify-802: ${RIGHT_PANE_SELECTOR} not found when measuring scroll containers`);
  return result;
}

/** Clicks the exact-text "Min"/"Max" button inside `WidthPresetControl.tsx`'s own
 * `[aria-label="Pane width"]` button group, then waits for the right pane's own `[data-panel]`
 * ancestor (the `react-resizable-panels` Panel wrapper, the pane's real rendered box) to settle
 * within 2px of the target width -- the resize is driven by a real click, never a programmatic
 * store mutation, so it exercises the exact same code path a developer dragging the pane (or
 * clicking Min/Max) would. */
async function resizePane(cdp, widthPx, label) {
  const finder = `Array.from(document.querySelectorAll('[aria-label="Pane width"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
  await cdp.click(finder);
  await cdp.waitFor(
    `(() => { const anchor = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)}); const panel = anchor?.closest('[data-panel]'); return !!panel && Math.abs(panel.getBoundingClientRect().width - ${widthPx}) <= 2; })()`,
    { timeoutMs: 10_000, label: `Pane resized to ${widthPx}px (${label})` }
  );
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [
    'The main transcript and the Agents panel staying at exactly one scroll container under the same stress (the issue\'s own acceptance list names both) -- out of scope for this script, which is scoped to the Side chat panel only; neither panel changed in this PR.',
    'A streaming answer (deltas arriving over several `btw_delta` push frames while the panel is open) is not exercised: the fixture\'s own `btw` response already carries the full, complete answer in one frame (side-chat-store.ts applies it verbatim regardless of status) -- a streaming answer that grows the scroll container\'s own height frame-by-frame while still mid-turn is a different code path (the same render tree, but reached incrementally) this run does not cover.',
    'Whether a wide table or long code block elsewhere in the app (the main transcript, a tool call\'s Arguments/Output) can trigger the same CSS-spec overflow-x/overflow-y coupling this fixture targets in the Side chat panel -- out of scope, scoped to the Side chat panel only.',
    'The optional, separately-scoped polish items the issue itself calls out as "not the fix" (the themed `scrollbar-thin` treatment and `overscroll-contain` on the side-chat scroller): intentionally not built in this change (Decided, Skippy, delegated by Stuart 2026-10-18, issue #802: root-cause fix only, no scope creep).'
  ];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let BUILD_OUTPUT_DIR = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-802-side-chat-scrollbars-shots', SHOT_NAMES);
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-802-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-802-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-802-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-802-repo-')), 'verify-802-side-chat-scrollbars');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-802-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-802-launcher-'));
    const port = await getFreePort();

    console.log(`verify-802: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-802: shots dir ${SHOTS_DIR}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-802' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-802: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'side-chat-long-answer',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-802: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Shim-confirmed guard (same pattern as verify-439/862/941): without this, a silently-wrong
    // fake-omp shim could still let the whole run "pass" on UI state alone.
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-802: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`verify-802: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    findings.push('Session created in the scratch repo, agent attached (fake omp, side-chat-long-answer scenario).');

    // Opens the Side chat panel through the real permanent icon rail (IconRail.tsx), never
    // `window.refract.*` directly -- the panel is not a modal, so nothing needs to be closed
    // first (unlike the Conversation history dialog verify-439 drives).
    await cdp.clickByLabel('Side chat panel');
    await cdp.waitFor(`!!document.querySelector('[aria-label="Side chat question"]')`, { timeoutMs: 15_000, label: 'Side chat composer mounted' });
    findings.push('Side chat panel opened via the permanent icon rail (aria-label "Side chat panel").');

    // `loadHistory` (get_btw_history) must resolve before `ask` will do anything (`send()` in
    // SideChatPanel.tsx silently no-ops while `!loaded`); the composer textarea's own
    // `aria-describedby` is set to the "still loading" hint's id ONLY while `!loaded`
    // (SideChatPanel.tsx), so its absence is a real, code-grounded signal the question can now
    // be sent, not a fixed sleep.
    await cdp.waitFor(
      `!document.querySelector('[aria-label="Side chat question"]').hasAttribute('aria-describedby')`,
      { timeoutMs: 15_000, label: 'Side chat history loaded (composer no longer describes the loading hint)' }
    );
    findings.push('Side chat history loaded (get_btw_history resolved); composer ready to send.');

    await cdp.typeIntoByLabel('Side chat question', QUESTION);
    await cdp.pressEnter();
    await cdp.waitFor(
      `document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)})?.textContent.includes(${JSON.stringify(LAST_LINE_MARKER)}) ?? false`,
      { timeoutMs: 20_000, label: 'Long side-chat answer rendered (last-line marker present in the DOM)' }
    );
    findings.push('Long side-chat answer (40-item list, a wide 4-column table, a 45-line code block) rendered in the panel.');

    // ---- Core acceptance: exactly one vertical scroll container, and it IS the Side chat
    // answer region (data-side-chat-scroll-container). Horizontal overflow (expected on the
    // wide table/code block) is reported as a diagnostic finding only, never a failure. ----
    async function assertOneScroller(label) {
      const measurement = await measureScrollContainers(cdp);
      if (measurement.scopedScrollers.length !== 1) {
        failures.push(
          `[${label}] Expected exactly 1 vertical scroll container across the right pane's Panel wrapper (subtree + ancestors to document.body), found ${measurement.scopedScrollers.length}: ${JSON.stringify(measurement.scopedScrollers)}`
        );
      } else if (!('data-side-chat-scroll-container' in measurement.scopedScrollers[0].dataAttrs)) {
        failures.push(
          `[${label}] The one scroll container found is NOT the Side chat answer region (missing data-side-chat-scroll-container): ${JSON.stringify(measurement.scopedScrollers[0])}`
        );
      } else {
        findings.push(`[${label}] Exactly 1 vertical scroll container, confirmed to be the Side chat answer region (data-side-chat-scroll-container): ${JSON.stringify(measurement.scopedScrollers[0])}.`);
      }
      findings.push(`[${label}] Page-wide scroll-container inventory (${measurement.pageWideScrollers.length} element(s) anywhere in the document with a rendered vertical scrollbar): ${JSON.stringify(measurement.pageWideScrollers)}`);
      if (measurement.horizontalOverflow.length !== 0) {
        findings.push(`[${label}] ${measurement.horizontalOverflow.length} element(s) with horizontal overflow inside the right pane (diagnostic only, not a failure -- the wide table/code block are expected here): ${JSON.stringify(measurement.horizontalOverflow)}`);
      }
      return measurement;
    }

    const firstMeasurement = await assertOneScroller('Dark (initial, default width)');

    // ---- Header title and composer stay pinned (not inside the scrollable region): captured
    // at scroll-top and again at scroll-bottom, each time asserting both are fully within the
    // window's own viewport AND that neither rect moved between the two captures. ----
    async function capturePinnedRects() {
      return cdp.evaluate(`(() => {
        const title = document.querySelector('#right-pane-panel-title');
        const composer = document.querySelector('[aria-label="Side chat question"]');
        if (!title || !composer) return { ok: false, reason: 'title (#right-pane-panel-title) or composer (Side chat question textarea) not found' };
        const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const inViewport = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth && r.bottom > r.top && r.right > r.left;
        const titleRect = rect(title);
        const composerRect = rect(composer);
        return { ok: inViewport(titleRect) && inViewport(composerRect), titleRect, composerRect };
      })()`);
    }
    const pinnedAtTop = await capturePinnedRects();
    if (!pinnedAtTop.ok) {
      failures.push(`Header title and/or composer are not fully within the viewport before scrolling: ${JSON.stringify(pinnedAtTop)}`);
    } else {
      findings.push('Header title (#right-pane-panel-title) and composer (Side chat question textarea) both within the viewport before scrolling.');
    }

    // ---- Scroll the one container to the bottom; the answer's own last line must be visible ----
    if (firstMeasurement.scopedScrollers.length === 1) {
      const scrolledToBottomAndVisible = await cdp.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)});
        const scroller = document.querySelector('[data-side-chat-scroll-container]');
        if (!scroller) return { ok: false, reason: 'data-side-chat-scroll-container not found' };
        scroller.scrollTop = scroller.scrollHeight;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let markerNode = null;
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.includes(${JSON.stringify(LAST_LINE_MARKER)})) {
            markerNode = walker.currentNode;
            break;
          }
        }
        if (!markerNode) return { ok: false, reason: 'marker text node not found' };
        const range = document.createRange();
        range.selectNodeContents(markerNode);
        const rect = range.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const visible = rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
        return { ok: visible, markerRectTop: rect.top, markerRectBottom: rect.bottom, scrollerRectTop: scrollerRect.top, scrollerRectBottom: scrollerRect.bottom, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
      })()`);
      if (!scrolledToBottomAndVisible.ok) {
        failures.push(`Scrolling the one container to the bottom did not reveal the answer's own last line: ${JSON.stringify(scrolledToBottomAndVisible)}`);
      } else {
        findings.push(`Scrolled the one container to the bottom; the answer's own last line (${LAST_LINE_MARKER}) is visible inside it.`);
      }

      const pinnedAtBottom = await capturePinnedRects();
      if (!pinnedAtBottom.ok) {
        failures.push(`Header title and/or composer are not fully within the viewport after scrolling to the bottom: ${JSON.stringify(pinnedAtBottom)}`);
      } else {
        findings.push('Header title and composer both still within the viewport after scrolling to the bottom.');
      }
      if (pinnedAtTop.ok && pinnedAtBottom.ok) {
        const unmoved = JSON.stringify(pinnedAtTop.titleRect) === JSON.stringify(pinnedAtBottom.titleRect) && JSON.stringify(pinnedAtTop.composerRect) === JSON.stringify(pinnedAtBottom.composerRect);
        if (!unmoved) {
          failures.push(`Header title and/or composer moved between scroll-top and scroll-bottom (not genuinely pinned outside the scroll region): before=${JSON.stringify(pinnedAtTop)} after=${JSON.stringify(pinnedAtBottom)}`);
        } else {
          findings.push('Header title and composer positions are identical before and after scrolling the answer region -- genuinely pinned outside the scrollable area, not merely coincidentally in view.');
        }
      }
    } else {
      notExercised.push(`Scroll-to-bottom/last-line-visible check skipped: the scroller count above was not exactly 1 (${firstMeasurement.scopedScrollers.length}), so there is no single container to scroll.`);
    }

    // ---- The issue's own 2-theme x 2-pane-width matrix (Dark/Dark high contrast, 240px/520px
    // via the Min/Max preset buttons), re-confirming the one-scroller guarantee at each
    // combination and screenshotting every one. ----
    for (const { theme, width, shot } of MATRIX) {
      await switchTheme(cdp, theme.id, theme.name);
      await resizePane(cdp, width.px, width.label);
      await assertOneScroller(`${theme.name} @ ${width.px}px`);
      await cdp.screenshot(path.join(SHOTS_DIR, shot));
      findings.push(`Screenshot captured: Side chat panel with the long answer under ${theme.name} at ${width.px}px pane width (${shot}).`);
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-802: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-802: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-802: NOT EXERCISED (genuine skips only) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-802: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-802: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-802: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-802: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-802: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-802: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
