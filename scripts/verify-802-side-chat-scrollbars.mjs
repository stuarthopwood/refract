#!/usr/bin/env node
// Live CDP check for issue #802 (bug: two vertical scrollbars at the right edge of the Side chat
// panel when the answer is taller than the pane). Modelled directly on
// `verify-439-history-truncate.mjs`/`verify-862-conversation-history.mjs`'s own guarded-tmpdir,
// fresh-exe-copy, themed-screenshot pattern; drives the real UI (rail click, typed question,
// Enter), never `window.refract.*` directly, so the measurement below sees the exact DOM a real
// developer would.
//
// Live-run result (build slot granted by Main, 2026-10-18): GREEN at commit `20cce39` (fixed
// code, `SideChatPanel.tsx` root `min-h-0 flex-1`) -- `report.json` records `failures: []`,
// exactly 1 scroll container (confirmed to be the Side chat answer region via
// `data-side-chat-scroll-container`, not a bare count), 0 elements with horizontal overflow, the
// header title and composer both confirmed pinned (same rect before and after scrolling the
// answer region to its bottom), across Dark/Obsidian/Dark (high contrast).
//
// RED PROBE RESULT (important, read before trusting the fix claim): on a throwaway branch,
// reverting ONLY `SideChatPanel.tsx`'s root `className` back to the pre-fix `flex h-full
// flex-col`, then rebuilding and re-running this SAME script (with its scroll probe corrected
// to measure the right pane's own `react-resizable-panels` `Panel` wrapper's subtree AND every
// ancestor up to `document.body` -- an earlier probe draft scoped to `#right-pane-active-panel`
// alone, which is a DESCENDANT of that wrapper, could never have seen it) -- the result was
// STILL exactly 1 scroll container, confirmed to be the Side chat answer region, 0 horizontal
// overflow, header/composer pinned, screenshot visually identical (one scrollbar thumb) to the
// fixed build. **Reverting the className alone does NOT reproduce a second scroll container in
// this fixture/harness.** This falsifies the hypothesis that `SideChatPanel.tsx`'s own
// `h-full`-vs-`flex-1` choice is, by itself, the cause of the double-scrollbar bug Stuart
// reported. The `min-h-0 flex-1` change is kept as a genuine, harmless improvement (it matches
// the proven-working `Transcript.tsx` `MessageScroller`/`ModelPicker.tsx` pattern and removes a
// real fragility -- a percentage height depending on every ancestor resolving a definite,
// non-`auto` computed height, including `react-resizable-panels`' own un-overridable `Panel`
// wrapper, whose default inline style is the literal `height: "auto"`, confirmed by reading the
// installed package at `node_modules/react-resizable-panels/dist/react-resizable-panels.js`),
// but its causal link to issue #802's own reported symptom is UNCONFIRMED, not proven, by this
// probe. The real cause (a different content shape, a different window/pane size, a streaming
// answer rather than one delivered complete in a single frame, or something this fixture does
// not reproduce at all) is still open; a live DevTools session against the exact reported
// scenario, per the issue's own "Probe first" instruction, has still not been run.
//
// What this script does NOT prove (recorded in its own `notExercised`):
//   - That no OTHER content shape, window size, or interaction sequence could surface a second
//     scroll container somewhere in the right pane's own tree -- this script's own count, taken
//     over the Panel wrapper's subtree and ancestors, is the live proof for THIS build and THIS
//     fixture only, both before and after the className change, and found no difference either
//     way.
//   - The main transcript and the Agents panel staying at exactly one scroll container under the
//     same stress (the issue's own acceptance list includes them) -- out of scope for this
//     script, which is scoped to the Side chat panel only; neither panel changed in this PR.
//   - A wide table or an unbroken long code line that genuinely needs its own horizontal scroll
//     (the issue's own fix note: "the table and code scroll horizontally only" is allowed, not
//     forbidden) -- this fixture's own table and code block are deliberately narrow so the
//     blanket "no horizontal overflow anywhere in the pane" assertion below holds; a wide-table
//     case is a different, narrower claim this run does not make either way.

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
const THEMES = [
  { id: 'dark', name: 'Dark', shot: '01-side-chat-dark.png' },
  { id: 'obsidian', name: 'Obsidian', shot: '02-side-chat-obsidian.png' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', shot: '03-side-chat-dark-high-contrast.png' }
];
const SHOT_NAMES = [...THEMES.map((t) => t.shot), 'report.json', 'app.log', 'fake-omp-invocations.log'];

const QUESTION = 'Give me a long answer with a list, a table, and code.';
const LAST_LINE_MARKER = 'ISSUE802-LAST-LINE-MARKER';
const RIGHT_PANE_SELECTOR = '#right-pane-active-panel';

/** Every element in TWO sets: (a) the right pane's own `react-resizable-panels` `Panel` wrapper
 * (found by walking UP from `RIGHT_PANE_SELECTOR` via `.closest('[data-panel]')` -- the library's
 * own un-overridable wrapper div, an ANCESTOR of `RIGHT_PANE_SELECTOR`, never a descendant, so a
 * probe scoped to `RIGHT_PANE_SELECTOR` alone can never see it) and everything inside it
 * (`panel.querySelectorAll('*')`, which includes the library's own inner `overflow:auto` div,
 * `RIGHT_PANE_SELECTOR` itself, and the Side chat panel's own scroll container); (b) every
 * ancestor of that `Panel` wrapper up to and including `document.body`. Filters both sets down
 * to elements whose computed `overflow-y` is `auto`/`scroll` AND whose `scrollHeight` genuinely
 * exceeds `clientHeight` right now -- a real, visible vertical scroll container, not merely one
 * styled `overflow-y-auto` with nothing to scroll. Each match's own `data-*` attributes are
 * included so a failure can show whether the one scroller found is actually the Side chat
 * panel's own answer region (`data-side-chat-scroll-container`, `SideChatPanel.tsx`) or some
 * other element entirely. */
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
  const candidates = [...subtree, ...ancestors];
  const describe = (el) => ({
    tag: el.tagName,
    className: el.className || null,
    id: el.id || null,
    dataAttrs: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  });
  const scrollers = candidates.filter((el) => {
    const style = getComputedStyle(el);
    return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
  });
  // .sr-only (screen-reader-only) elements are DELIBERATELY clipped to a 1x1px box by the
  // standard accessibility technique (position:absolute, width/height:1px, overflow:hidden) --
  // their own scrollWidth naturally exceeds that 1px clientWidth for any real text content,
  // which is the intended behaviour, not a layout bug; excluded here (and any element nested
  // inside one) so this assertion measures real, visible horizontal overflow only.
  const horizontalOverflow = candidates.filter((el) => el.scrollWidth > el.clientWidth && !el.closest('.sr-only'));
  return {
    scrollers: scrollers.map(describe),
    horizontalOverflow: horizontalOverflow.map(describe)
  };
})()`;

async function measureScrollContainers(cdp) {
  const result = await cdp.evaluate(SCROLL_PROBE_EXPR);
  if (!result) throw new Error(`verify-802: ${RIGHT_PANE_SELECTOR} not found when measuring scroll containers`);
  return result;
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
    'Whether `react-resizable-panels`\' own injected Panel wrapper, or any other element, is the exact second scroller a live DevTools session against the REAL reported scenario would find: this script\'s own scroll-container count, taken over the Panel wrapper\'s subtree AND its ancestors up to document.body, found exactly 1 scroller both WITH and WITHOUT the SideChatPanel.tsx className fix in this fixture/harness (a RED probe reverting the fix alone did not reproduce a second scroller) -- the real cause of the originally reported bug remains unconfirmed by this script.',
    'Whether the `min-h-0 flex-1` className change on SideChatPanel.tsx\'s root genuinely fixes issue #802\'s own reported symptom: NOT confirmed. The change is a harmless, defensive improvement (matches the proven-working MessageScroller/ModelPicker pattern), but reverting it alone did not reproduce a second scroll container in this fixture, so its causal link to the real bug is open, not proven; a live DevTools probe against the exact reported window/pane size, per the issue\'s own "Probe first" instruction, has still not been run.',
    'The main transcript and the Agents panel staying at exactly one scroll container under the same stress (the issue\'s own acceptance list names both) -- out of scope for this script, which is scoped to the Side chat panel only; neither panel changed in this PR.',
    'A wide table or an unbroken long code line that genuinely needs its own horizontal scroll (the issue\'s own fix note explicitly allows the table/code to scroll sideways): this fixture\'s own table and code block are deliberately narrow, so the blanket "no horizontal overflow anywhere in the pane" assertion below is a different, narrower claim than a wide-table case would need.',
    'A streaming answer (deltas arriving over several `btw_delta` push frames while the panel is open) is not exercised: the fixture\'s own `btw` response already carries the full, complete answer in one frame (side-chat-store.ts applies it verbatim regardless of status) -- a streaming answer that grows the scroll container\'s own height frame-by-frame while still mid-turn is a different code path (the same render tree, but reached incrementally) this run does not cover.',
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
    findings.push('Long side-chat answer (40-item list, a table, a 30-line code block) rendered in the panel.');

    // ---- Core acceptance: exactly one vertical scroll container, and it IS the Side chat
    // answer region (data-side-chat-scroll-container), zero horizontal overflow ----
    async function assertOneScrollerNoHorizontalOverflow(themeName) {
      const measurement = await measureScrollContainers(cdp);
      if (measurement.scrollers.length !== 1) {
        failures.push(
          `[${themeName}] Expected exactly 1 vertical scroll container across the right pane's Panel wrapper (subtree + ancestors to document.body), found ${measurement.scrollers.length}: ${JSON.stringify(measurement.scrollers)}`
        );
      } else if (!('data-side-chat-scroll-container' in measurement.scrollers[0].dataAttrs)) {
        failures.push(
          `[${themeName}] The one scroll container found is NOT the Side chat answer region (missing data-side-chat-scroll-container): ${JSON.stringify(measurement.scrollers[0])}`
        );
      } else {
        findings.push(`[${themeName}] Exactly 1 vertical scroll container, confirmed to be the Side chat answer region (data-side-chat-scroll-container): ${JSON.stringify(measurement.scrollers[0])}.`);
      }
      if (measurement.horizontalOverflow.length !== 0) {
        failures.push(`[${themeName}] ${measurement.horizontalOverflow.length} element(s) across the right pane's Panel wrapper (subtree + ancestors) have horizontal overflow: ${JSON.stringify(measurement.horizontalOverflow)}`);
      } else {
        findings.push(`[${themeName}] No element across the right pane's Panel wrapper (subtree + ancestors) has horizontal overflow.`);
      }
      return measurement;
    }

    const firstMeasurement = await assertOneScrollerNoHorizontalOverflow('Dark (initial)');

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
    if (firstMeasurement.scrollers.length === 1) {
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
      notExercised.push(`Scroll-to-bottom/last-line-visible check skipped: the scroller count above was not exactly 1 (${firstMeasurement.scrollers.length}), so there is no single container to scroll.`);
    }

    // ---- Themed screenshots (Dark, Obsidian, Dark high contrast), re-confirming the one-
    // scroller/no-horizontal-overflow guarantee under every theme, not just the default one ----
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await assertOneScrollerNoHorizontalOverflow(theme.name);
      await cdp.screenshot(path.join(SHOTS_DIR, theme.shot));
      findings.push(`Screenshot captured: Side chat panel with the long answer, scrolled to bottom, under the ${theme.name} theme (${theme.shot}).`);
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
