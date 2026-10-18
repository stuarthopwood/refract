#!/usr/bin/env node
// Live CDP check for issue #802 (bug: two vertical scrollbars at the right edge of the Side chat
// panel when the answer is taller than the pane). Modelled directly on
// `verify-439-history-truncate.mjs`/`verify-862-conversation-history.mjs`'s own guarded-tmpdir,
// fresh-exe-copy, themed-screenshot pattern; drives the real UI (rail click, typed question,
// Enter), never `window.refract.*` directly, so the measurement below sees the exact DOM a real
// developer would.
//
// MUST fail on `origin/main` for this exact reason, read from the code (not reproduced by
// actually running this script against `origin/main`; no build slot has been granted for that
// comparison run): `SideChatPanel.tsx`'s own root div was `flex h-full flex-col` -- a bare
// percentage height, which depends on EVERY ancestor in the chain resolving a definite (non-
// `auto`) computed height to actually bound this panel to the pane's own available space.
// `react-resizable-panels`' own `Panel` component (`node_modules/react-resizable-panels/dist/
// react-resizable-panels.js`, confirmed by reading the installed package, not merely its types)
// renders an outer wrapper div whose un-overridable default inline style is `height: "auto"`
// (not `100%` -- its own `.d.ts` comment even warns "the default inline styles cannot be
// overridden, except for overflow"), and wraps RightPaneShell's content in an INNER div with
// its own un-overridable `overflow: "auto"` default. Every OTHER self-scrolling root in this
// codebase that fills a flex column already avoids depending on that percentage chain at all --
// `Transcript.tsx`'s `MessageScroller className="h-full flex-1"` and `ModelPicker.tsx`'s list
// `min-h-0 flex-1 overflow-y-auto` both use `flex-1` (flex-basis:0%, flex-grow:1), which derives
// its size directly from the flex algorithm's own free-space distribution, never from a
// percentage that can resolve against an indefinite ancestor. `SideChatPanel.tsx` was the one
// outlier using a bare `h-full`, which let its own root grow taller than the pane whenever an
// answer exceeded it, in turn letting the `react-resizable-panels` wrapper's own `overflow: auto`
// box (an ancestor entirely invisible to a source-level grep of `RightPaneShell.tsx`/`App.tsx`/
// `resizable.tsx`, since it is injected by the library at runtime, not authored in this repo)
// become a second, genuine scroll container beside the panel's own intended one. The fix
// (`min-h-0 flex-1` in place of `h-full`, `SideChatPanel.tsx`) matches the issue's own prescribed
// "robust way to fill a flex column" and the proven-working `MessageScroller`/`ModelPicker`
// pattern exactly.
//
// What this script does NOT prove (recorded in its own `notExercised`):
//   - That `react-resizable-panels`' own injected wrapper is the exact ONLY candidate a live
//     DevTools probe would have named (the issue itself says "no candidate is preferred until
//     the probe runs") -- this script's own scroll-container count is the actual live proof for
//     THIS build; the header comment above is the code-reading explanation for why the count
//     was 2 before the fix, not a substitute for having run the probe against `origin/main`.
//   - The main transcript and the Agents panel staying at exactly one scroll container under the
//     same stress (the issue's own acceptance list includes them) -- out of scope for this
//     script, which is scoped to the Side chat panel only; neither panel changed in this PR.
//   - A wide table or an unbroken long code line that genuinely needs its own horizontal scroll
//     (the issue's own fix note: "the table and code scroll horizontally only" is allowed, not
//     forbidden) -- this fixture's own table and code block are deliberately narrow so the
//     blanket "no horizontal overflow anywhere in the pane" assertion below holds; a wide-table
//     case is a different, narrower claim this run does not make either way.
//
// WRITTEN, NOT RUN: no build slot has been granted for this sub-task (lane brief: "NO BUILD" --
// the build slot is granted by Main explicitly later). `node --check` is the only command that
// has been run against it.

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

/** Every element inside `RIGHT_PANE_SELECTOR` (the right pane's own active-panel root,
 * `RightPaneShell.tsx`), plus that root itself, whose computed `overflow-y` is `auto`/`scroll`
 * AND whose `scrollHeight` genuinely exceeds `clientHeight` right now -- a real, visible vertical
 * scroll container, not merely one styled `overflow-y-auto` with nothing to scroll. Returns a
 * small JSON-safe descriptor per match (tag, className, id) so a failure names exactly which
 * elements collided, not just a bare count. */
const SCROLL_PROBE_EXPR = `(() => {
  const root = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)});
  if (!root) return null;
  const candidates = [root, ...root.querySelectorAll('*')];
  const scrollers = candidates.filter((el) => {
    const style = getComputedStyle(el);
    return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
  });
  const horizontalOverflow = candidates.filter((el) => el.scrollWidth > el.clientWidth);
  return {
    scrollers: scrollers.map((el) => ({ tag: el.tagName, className: el.className || null, id: el.id || null, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })),
    horizontalOverflow: horizontalOverflow.map((el) => ({ tag: el.tagName, className: el.className || null, id: el.id || null, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
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
    'Whether `react-resizable-panels`\' own injected wrapper is the exact ONLY candidate a live DevTools probe would have named on origin/main: this script\'s own scroll-container count is the live proof for THIS build; the header comment\'s code-reading explanation is not a substitute for having run the probe against origin/main itself, which no build slot has been granted for.',
    'The main transcript and the Agents panel staying at exactly one scroll container under the same stress (the issue\'s own acceptance list names both) -- out of scope for this script, which is scoped to the Side chat panel only; neither panel changed in this PR.',
    'A wide table or an unbroken long code line that genuinely needs its own horizontal scroll (the issue\'s own fix note explicitly allows the table/code to scroll sideways): this fixture\'s own table and code block are deliberately narrow, so the blanket "no horizontal overflow anywhere in the pane" assertion below is a different, narrower claim than a wide-table case would need.',
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

    // ---- Core acceptance: exactly one vertical scroll container, zero horizontal overflow ----
    async function assertOneScrollerNoHorizontalOverflow(themeName) {
      const measurement = await measureScrollContainers(cdp);
      if (measurement.scrollers.length !== 1) {
        failures.push(
          `[${themeName}] Expected exactly 1 vertical scroll container inside ${RIGHT_PANE_SELECTOR}, found ${measurement.scrollers.length}: ${JSON.stringify(measurement.scrollers)}`
        );
      } else {
        findings.push(`[${themeName}] Exactly 1 vertical scroll container inside the right pane (${JSON.stringify(measurement.scrollers[0])}).`);
      }
      if (measurement.horizontalOverflow.length !== 0) {
        failures.push(`[${themeName}] ${measurement.horizontalOverflow.length} element(s) inside ${RIGHT_PANE_SELECTOR} have horizontal overflow: ${JSON.stringify(measurement.horizontalOverflow)}`);
      } else {
        findings.push(`[${themeName}] No element inside the right pane has horizontal overflow.`);
      }
      return measurement;
    }

    const firstMeasurement = await assertOneScrollerNoHorizontalOverflow('Dark (initial)');

    // ---- Scroll the one container to the bottom; the answer's own last line must be visible ----
    if (firstMeasurement.scrollers.length === 1) {
      const scrolledToBottomAndVisible = await cdp.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)});
        const candidates = [root, ...root.querySelectorAll('*')];
        const scroller = candidates.find((el) => {
          const style = getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        if (!scroller) return { ok: false, reason: 'scroller not found on second lookup' };
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
