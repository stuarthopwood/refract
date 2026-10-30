#!/usr/bin/env node
// Live CDP check for #802 (two vertical scrollbars at the right edge of the Side chat panel when the answer
// is taller than the pane). Drives the real UI, never `window.refract.*`; the probe scans every element for a
// rendered vertical scrollbar (`offsetWidth - clientWidth > 0 && scrollHeight > clientHeight`).
// Hypothesis: wide table/code wrappers set only `overflow-x`, so `overflow-y: auto` is computed too.
// Not covered (see `notExercised`): main transcript, Agents panel, streaming answers.

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

// The issue's acceptance names these two themes and two pane widths, reached via the Min/Max
// buttons because CDP cannot drag reliably.
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

/** Scans two candidate sets for a rendered vertical scrollbar (gutter consuming layout space,
 * not merely a computed `overflow-y`): the right pane's `[data-panel]` wrapper, its subtree and
 * its ancestors; and every element in the document. Matches include data attributes, overflow,
 * rect and scroll metrics to name the colliding element. `horizontalOverflow` is diagnostic only,
 * since the wide table and code block are allowed to scroll horizontally. */
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

/** Clicks the "Min"/"Max" preset button, then waits for the `[data-panel]` wrapper to settle
 * within 2px of the target width; a real click exercises the same path as a developer would. */
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

    // Shim-confirmed guard: a silently wrong fake-omp shim could otherwise pass on UI state alone.
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

    // Open through the real icon rail; the panel is not a modal, so nothing needs closing first.
    await cdp.clickByLabel('Side chat panel');
    await cdp.waitFor(`!!document.querySelector('[aria-label="Side chat question"]')`, { timeoutMs: 15_000, label: 'Side chat composer mounted' });
    findings.push('Side chat panel opened via the permanent icon rail (aria-label "Side chat panel").');

    // `ask` no-ops while history is unloaded; the textarea's `aria-describedby` hint is set only
    // while `!loaded`, so its absence is the signal the question can be sent.
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

    // Core acceptance: exactly one vertical scroll container, the answer region. Horizontal
    // overflow is reported as a diagnostic only.
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

    // Header and composer stay pinned: in the viewport and unmoved between scroll-top and bottom.
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

    // Scroll to the bottom; the last line must be visible.
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

    // 2-theme x 2-width matrix: re-confirm one scroller and screenshot each combination.
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
