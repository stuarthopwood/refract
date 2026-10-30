#!/usr/bin/env node
// Live CDP check for #439: Conversation history rows truncate to one line with an ellipsis (no fade,
// per docs/PLAN.md), full text shows in a focus-visible Tooltip, and the dialog never gains a horizontal scrollbar.
// Not covered: OS forced-colors media (WebView2 CDP lacks Emulation.setEmulatedMedia for it, see
// verify-tauri-567.mjs) and opening an earlier Conversation.

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
import { addRepository, createSessionViaQuickCreate, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import {
  THEMES,
  SHOT_NAMES,
  NORMAL_TITLE,
  NORMAL_PREVIEW,
  LONG_TITLE,
  LONG_PREVIEW,
  PREVIEW_MAX_LENGTH,
  PROMPT_TEXT,
  HISTORY_DIALOG_FINDER,
  writeConversationFile,
  reachRowViaRealTab,
  readRowFocusStyle,
  tooltipFinder,
  waitForTooltipAnimationsSettled,
  readTooltipPositionEvidence,
  setWindowWidth,
  assertDialogNeverScrollsHorizontally,
  assertRowTruncation
} from './verify-439-history-truncate-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR =
  process.env.REFRACT_439_SHOTS_DIR || path.join(tmpdir(), `refract-439-history-truncate-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir, conversationFileDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [
    'Windows forced-colors/high-contrast MEDIA rendering of the ellipsis: WebView2\'s own CDP endpoint has no working Emulation.setEmulatedMedia for forced-colors (same limitation verify-tauri-567.mjs already records); the "Dark (high contrast)" screenshot below is Refract\'s own in-app preset, not the OS forced-colors feature.',
    'Opening an earlier Conversation from this dialog (handleOpenConversation): out of this issue\'s scope, matching verify-862-conversation-history.mjs\'s own stated scope (it also only opens the dialog and reads the rows, never switches).',
    '200%+ zoom: the Conversation history dialog is fixed-positioned and unconstrained by the app window\'s own width (max-w-[calc(100%-2rem)]), so this specific case was not re-run at another zoom level. (A ~960px-wide window IS re-run below -- gate round 2 -- since the Tooltip\'s own available room to its right genuinely shrinks as the window narrows, unlike the dialog itself.)'
  ];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let BUILD_OUTPUT_DIR = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-439-history-truncate-shots', SHOT_NAMES);
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-439-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-439-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-439-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-439-repo-')), 'verify-439-history-truncate');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-439-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-439-launcher-'));
    conversationFileDir = mkdtempSync(path.join(tmpdir(), 'refract-439-conv-'));
    const port = await getFreePort();

    console.log(`verify-439: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-439: shots dir ${SHOTS_DIR}`);
    console.log(`verify-439: conversation dir ${conversationFileDir}`);

    if (LONG_PREVIEW.length !== PREVIEW_MAX_LENGTH) {
      throw new Error(`verify-439: LONG_PREVIEW is ${LONG_PREVIEW.length} characters, expected exactly ${PREVIEW_MAX_LENGTH} (PREVIEW_MAX_LENGTH)`);
    }

    // --- Seed the two real Conversation files `conversations.list` will scan on disk. ---
    const normalFile = writeConversationFile(conversationFileDir, '2026-10-18T10:00:00.000Z', 'sess439a', [
      { type: 'title', title: NORMAL_TITLE },
      { type: 'session', version: 3, id: 'sess439-a', timestamp: '2026-10-18T10:00:00.000Z', cwd: repoDir },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-10-18T10:00:01.000Z',
        message: { role: 'user', content: NORMAL_PREVIEW }
      }
    ]);

    // Points the fake Session at this file. Its row only gets the Current badge once a turn completes
    // (sync_from_state.rs's `message_count > 0` guard), which happens below.
    const longFile = writeConversationFile(conversationFileDir, '2026-10-18T10:05:00.000Z', 'sess439b', [
      { type: 'title', title: LONG_TITLE },
      { type: 'session', version: 3, id: 'sess439-b', timestamp: '2026-10-18T10:05:00.000Z', cwd: repoDir },
      {
        type: 'message',
        id: 'm2',
        parentId: null,
        timestamp: '2026-10-18T10:05:01.000Z',
        message: { role: 'user', content: LONG_PREVIEW }
      }
    ]);
    findings.push(
      `Seeded two real Conversation files in ${conversationFileDir}: "${path.basename(normalFile)}" (short title/preview, the control case) and ` +
        `"${path.basename(longFile)}" (title ${LONG_TITLE.length} characters, preview exactly ${LONG_PREVIEW.length} characters -- the ` +
        `PREVIEW_MAX_LENGTH cap).`
    );

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-439' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-439: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time',
        // The `$conversationFile` sentinel makes `session_dir` (sync_from_state.rs) resolve to the
        // directory `conversations.list` scans, and marks the long Conversation current.
        REFRACT_FAKE_OMP_CONVERSATION_FILE: longFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-439: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Shim-confirmed guard: otherwise a silently-wrong fake-omp shim could still pass on UI state alone.
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-439: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`verify-439: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    findings.push('Session created in the scratch repo, agent attached (fake omp, user-message-time.jsonl scenario).');

    // Send one real prompt and approve the scripted tool call so the turn settles and the long
    // Conversation is marked current before the history dialog opens (Current badge beside the long title).
    await cdp.typeIntoByLabel('Message', PROMPT_TEXT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, {
      timeoutMs: 30_000,
      label: 'Tool-call approval card rendered'
    });
    await cdp.clickByText('Approve');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('xyzzy9'); })()`,
      { timeoutMs: 60_000, label: "Turn settled (user-message-time.jsonl's own reply token present)" }
    );
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value[0]?.currentConversation != null)`, {
      timeoutMs: 15_000,
      label: 'Session.current_conversation set after the turn settles'
    });
    findings.push("Prompt sent and the turn settled (fake omp, user-message-time.jsonl's own scripted tool call approved); Session.current_conversation is confirmed set before the history dialog opens.");

    await cdp.clickByLabel('Conversation history');
    await cdp.waitFor(`!!(${HISTORY_DIALOG_FINDER})`, { timeoutMs: 15_000, label: 'Conversation history dialog open' });
    await cdp.waitFor(
      `!(((${HISTORY_DIALOG_FINDER})?.textContent || '').includes('Loading'))`,
      { timeoutMs: 15_000, label: 'Conversation history list finished loading' }
    );

    const rowCount = await cdp.evaluate(`(${HISTORY_DIALOG_FINDER})?.querySelectorAll('ul li button[data-choice-item]').length ?? 0`);
    if (rowCount !== 2) {
      failures.push(`Conversation history dialog shows ${rowCount} row(s), expected 2 (the normal and long seeded Conversations).`);
    } else {
      findings.push('Conversation history dialog shows exactly 2 rows: the normal and the long Conversation.');
    }

    // Reach the long row via real Tab presses: a bare `.focus()` doesn't reliably set Chromium's
    // `:focus-visible`. Bounded (2 rows + Close) so a DOM-order change fails loudly instead of hanging.
    const MAX_TAB_PRESSES_TO_LONG_ROW = 10;
    const reachedLongRowViaTab = await reachRowViaRealTab(cdp, LONG_TITLE, MAX_TAB_PRESSES_TO_LONG_ROW);
    if (!reachedLongRowViaTab) {
      failures.push(`Could not reach the long row's button via real keyboard Tab presses within ${MAX_TAB_PRESSES_TO_LONG_ROW} presses.`);
    } else {
      findings.push("Reached the long row's button via real keyboard Tab presses (never a scripted .focus()).");
    }

    // The focus ring must actually render after a real Tab chain, not be assumed from the class list.
    const longRowFocusStyle = await readRowFocusStyle(cdp, LONG_TITLE);
    if (!longRowFocusStyle || !longRowFocusStyle.matchesFocusVisible) {
      failures.push(`Long row button does not match :focus-visible after real Tab presses (got ${JSON.stringify(longRowFocusStyle)}) -- item 2's focus ring has no real keyboard-focus proof.`);
    } else if (!longRowFocusStyle.boxShadow || longRowFocusStyle.boxShadow === 'none') {
      failures.push(`Long row button matches :focus-visible but its computed box-shadow is ${JSON.stringify(longRowFocusStyle.boxShadow)} -- the focus-visible ring (item 2) is not actually rendering.`);
    } else {
      findings.push(`Long row button matches :focus-visible with a real rendered focus ring (boxShadow: ${longRowFocusStyle.boxShadow}), reached via real Tab presses (issue #1012 item 2).`);
    }

    await cdp.waitFor(`!!(${tooltipFinder(LONG_TITLE)})`, {
      timeoutMs: 5_000,
      label: 'Full-title Tooltip opened on keyboard focus of the long row'
    });
    const focusTooltipText = await cdp.evaluate(`(${tooltipFinder(LONG_TITLE)})?.textContent ?? null`);
    if (!focusTooltipText || !focusTooltipText.includes(LONG_TITLE) || !focusTooltipText.includes(LONG_PREVIEW)) {
      failures.push(`Full-title Tooltip on keyboard focus: expected content to include the full long title and preview, got ${JSON.stringify(focusTooltipText)}.`);
    } else {
      findings.push('Full-title Tooltip appears on keyboard focus of the long row, carrying the complete, un-truncated title and preview text (issue #1012 item 1).');
    }

    // Wait for the Tooltip's animations to settle so a mid-transition rect can't pass or fail by accident.
    await waitForTooltipAnimationsSettled(cdp, LONG_TITLE);

    // Tooltip opens to the right (not over the heading or row above) with stacked lines, and its
    // left edge is exactly at or past the row's right edge: `sideOffset={22}` clears the dialog padding.
    const tooltipPositionEvidence = await readTooltipPositionEvidence(cdp, LONG_TITLE);
    if (!tooltipPositionEvidence) {
      failures.push('Could not read the Tooltip/row geometry for the position check (row or tooltip not found).');
    } else {
      if (tooltipPositionEvidence.tooltipLeft < tooltipPositionEvidence.rowRight) {
        failures.push(`Tooltip is not positioned to the right of the long row (tooltip left ${tooltipPositionEvidence.tooltipLeft} < row right ${tooltipPositionEvidence.rowRight}) -- expected side="right".`);
      } else {
        findings.push(`Tooltip opens to the right of the long row (tooltip left ${tooltipPositionEvidence.tooltipLeft} >= row right ${tooltipPositionEvidence.rowRight}, no slop), not covering the dialog heading or the row above (issue #1012 item 3).`);
      }
      let linesStacked = tooltipPositionEvidence.lineTops.length >= 2;
      for (let i = 1; i < tooltipPositionEvidence.lineTops.length; i++) {
        if (tooltipPositionEvidence.lineTops[i] <= tooltipPositionEvidence.lineBottoms[i - 1]) {
          linesStacked = false;
          break;
        }
      }
      if (!linesStacked) {
        failures.push(`Tooltip lines are not stacked vertically (lineTops=${JSON.stringify(tooltipPositionEvidence.lineTops)}, lineBottoms=${JSON.stringify(tooltipPositionEvidence.lineBottoms)}) -- expected each line's top to be below the previous line's bottom (issue #1012 item 2).`);
      } else {
        findings.push(`Tooltip's ${tooltipPositionEvidence.lineTops.length} lines (title, date, preview) are stacked vertically, each below the previous one's bottom, not laid out side by side (issue #1012 item 2).`);
      }
    }

    // Re-check at ~960px: the dialog is window-independent but the Tooltip's room to the right
    // shrinks, and it must stay inside the viewport rather than flip or spill off-screen.
    const NARROW_WINDOW_WIDTH_PX = 960;
    await setWindowWidth(cdp, NARROW_WINDOW_WIDTH_PX);
    await waitForTooltipAnimationsSettled(cdp, LONG_TITLE);
    const narrowTooltipPositionEvidence = await readTooltipPositionEvidence(cdp, LONG_TITLE);
    if (!narrowTooltipPositionEvidence) {
      failures.push(`Could not read the Tooltip/row geometry at a ${NARROW_WINDOW_WIDTH_PX}px window width (row or tooltip not found).`);
    } else {
      const windowInnerWidth = await cdp.evaluate('window.innerWidth');
      if (narrowTooltipPositionEvidence.tooltipLeft < narrowTooltipPositionEvidence.rowRight) {
        failures.push(`At a ${NARROW_WINDOW_WIDTH_PX}px window width, Tooltip is not positioned to the right of the long row (tooltip left ${narrowTooltipPositionEvidence.tooltipLeft} < row right ${narrowTooltipPositionEvidence.rowRight}).`);
      } else if (narrowTooltipPositionEvidence.tooltipRight > windowInnerWidth) {
        failures.push(`At a ${NARROW_WINDOW_WIDTH_PX}px window width, Tooltip spills past the viewport's own right edge (tooltip right ${narrowTooltipPositionEvidence.tooltipRight} > window.innerWidth ${windowInnerWidth}) -- collisionPadding/max-w did not keep it on-screen.`);
      } else {
        findings.push(`At a ${NARROW_WINDOW_WIDTH_PX}px window width (window.innerWidth ${windowInnerWidth}), Tooltip still opens to the right of the long row (tooltip left ${narrowTooltipPositionEvidence.tooltipLeft} >= row right ${narrowTooltipPositionEvidence.rowRight}) and stays fully on-screen (tooltip right ${narrowTooltipPositionEvidence.tooltipRight} <= window.innerWidth ${windowInnerWidth}), issue #1012 gate round 2.`);
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00b-narrow-window-tooltip.png'));
    findings.push(`Screenshot captured: the Tooltip visibly open to the right of the long row and fully on-screen at a ${NARROW_WINDOW_WIDTH_PX}px window width (00b-narrow-window-tooltip.png).`);
    await setWindowWidth(cdp, 1280);
    await waitForTooltipAnimationsSettled(cdp, LONG_TITLE);

    await cdp.screenshot(path.join(SHOTS_DIR, '00-focus-tooltip.png'));
    findings.push('Screenshot captured: the full-title/preview Tooltip visibly open to the right of the long row while it holds real keyboard focus, with a visible focus-visible ring (00-focus-tooltip.png).');

    // Two Escapes are expected, not a bug: Radix DismissableLayer only listens for Escape on the
    // topmost layer, so the open Tooltip eats the first and the Dialog gets the second (same as
    // DropdownMenu inside a Dialog).

    // First Escape closes only the Tooltip (topmost layer); the Dialog stays open.
    await pressEscape(cdp);
    await cdp.waitFor(`!(${tooltipFinder(LONG_TITLE)})`, {
      timeoutMs: 5_000,
      label: 'First Escape (tooltip open): Tooltip closes'
    });
    // `data-state` must be "open": a `[role="dialog"]` node can still exist mid-close-animation.
    const dialogStateAfterFirstEscape = await cdp.evaluate(`(${HISTORY_DIALOG_FINDER})?.getAttribute('data-state') ?? null`);
    if (dialogStateAfterFirstEscape !== 'open') {
      failures.push(`First Escape (tooltip open): expected the Conversation history dialog's data-state to still be "open" (only the Tooltip should have closed), got ${JSON.stringify(dialogStateAfterFirstEscape)}.`);
    } else {
      findings.push('First Escape while the long row\'s Tooltip is open closes ONLY the Tooltip; the Conversation history dialog\'s own data-state stays "open" (Radix\'s own nested-DismissableLayer stacking, item 1 gate follow-up -- see the code comment above for the exact library citations).');
    }
    // Re-confirm still open at the moment the closing press is sent.
    const dialogStateJustBeforeSecondEscape = await cdp.evaluate(`(${HISTORY_DIALOG_FINDER})?.getAttribute('data-state') ?? null`);
    if (dialogStateJustBeforeSecondEscape !== 'open') {
      failures.push(`Just before the second Escape: expected the Conversation history dialog's data-state to still be "open", got ${JSON.stringify(dialogStateJustBeforeSecondEscape)}.`);
    }
    // Second Escape: the Tooltip is gone, so the Dialog is topmost again and closes.
    await pressEscape(cdp);
    await cdp.waitFor(`!(${HISTORY_DIALOG_FINDER})`, {
      timeoutMs: 5_000,
      label: 'Second Escape (tooltip already closed): Conversation history dialog closes'
    });
    findings.push('A second Escape then closes the Conversation history dialog itself, once the Tooltip layer above it is gone -- the dialog is never keyboard-trapped, just reached one nested layer at a time, same as a DropdownMenu opened inside any Dialog in this codebase.');

    // The Close button is an equally valid dismissal path: reopen, then close this way before the theme loop.
    await cdp.clickByLabel('Conversation history');
    await cdp.waitFor(`!!(${HISTORY_DIALOG_FINDER})`, { timeoutMs: 15_000, label: 'Conversation history dialog reopened for the Close-button check' });
    const historyDialogCloseButtonFinder = `(() => { const dialog = ${HISTORY_DIALOG_FINDER}; if (!dialog) return null; return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Close') ?? null; })()`;
    // The Close button's rect can read zero-size or still moving during Radix's entrance transition,
    // and a degenerate {0,0} click is truthy yet misses. Wait for zero running animations or two
    // identical consecutive rects (kept on `window`, since each poll is stateless).
    await cdp.evaluate('window.__verify439CloseRect = null;');
    await cdp.waitFor(`(() => {
      const dialog = ${HISTORY_DIALOG_FINDER};
      if (dialog && dialog.getAnimations().length === 0) return true;
      const el = ${historyDialogCloseButtonFinder};
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const key = JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
      const stable = window.__verify439CloseRect === key;
      window.__verify439CloseRect = key;
      return stable;
    })()`, { timeoutMs: 5_000, label: 'Close button laid out with a stable, non-zero rect (entrance animation settled)' });
    await cdp.click(historyDialogCloseButtonFinder);
    await cdp.waitFor(`!(${HISTORY_DIALOG_FINDER})`, { timeoutMs: 5_000, label: 'Close button closes the Conversation history dialog' });
    findings.push("The dialog's own visible Close button also closes it, independent of Escape.");

    // Re-check overflow and truncation under every theme.
    for (const theme of THEMES) {
      // The modal overlay blocks clicks outside it, so close the dialog before switching theme.
      await pressEscape(cdp);
      await cdp.waitFor(`!(${HISTORY_DIALOG_FINDER})`, {
        timeoutMs: 10_000,
        label: `Conversation history dialog closed before switching to ${theme.name}`
      });
      await switchTheme(cdp, theme.id, theme.name);
      await cdp.clickByLabel('Conversation history');
      await cdp.waitFor(`!!(${HISTORY_DIALOG_FINDER})`, {
        timeoutMs: 15_000,
        label: `Conversation history dialog reopened under ${theme.name}`
      });
      await cdp.waitFor(`!(((${HISTORY_DIALOG_FINDER})?.textContent || '').includes('Loading'))`, {
        timeoutMs: 15_000,
        label: `Conversation history list finished loading under ${theme.name}`
      });
      await assertDialogNeverScrollsHorizontally(cdp, findings, failures, theme.name);
      await assertRowTruncation(cdp, findings, failures, theme.name);
      await cdp.screenshot(path.join(SHOTS_DIR, theme.shot));
      findings.push(`Screenshot captured: Conversation history dialog (both rows, long row's truncating title/preview) under the ${theme.name} theme (${theme.shot}).`);
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
    console.log('\n=== verify-439: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-439: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-439: NOT EXERCISED (genuine skips only) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-439: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-439: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-439: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-439: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-439: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
    await safeRmSync(conversationFileDir);
  }
}

main().catch((err) => {
  console.error('verify-439: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
