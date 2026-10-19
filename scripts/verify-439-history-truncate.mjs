#!/usr/bin/env node
// Live CDP check for issue #439 (the Conversation history dialog: a title or preview wider than
// the dialog must truncate to one line with an ellipsis, full text still available via a `title`
// attribute, and the dialog must never gain a horizontal scrollbar at any width).
//
// Modelled directly on `verify-862-conversation-history.mjs`'s own fixture-driven pattern (same
// recorded-frame fake `omp` harness, `user-message-time.jsonl`'s scripted startup needs no chat
// prompt at all, and the SAME trick of pre-populating `conversations.list`'s own scanned
// directory with real, hand-built `.jsonl` Conversation files before the app launches) and on
// `verify-937-advisor-chip.mjs`'s own themed-screenshot loop (`switchTheme`, Dark/Obsidian/Dark
// high contrast).
//
// Two real Conversation files are seeded in the directory `conversations.list` scans:
//   - "normal": short title, short preview -- the control case (must NOT need to clip; its own
//     title/preview spans' `scrollWidth` must stay <= `clientWidth`).
//   - "long": a deliberately very long title (the one the issue's own design notes call out as
//     having "to cope with a long title and the Current badge beside it" -- this file is the
//     SESSION's own current Conversation, via the `user-message-time.jsonl` scenario's
//     `$conversationFile` sentinel) and a preview padded to EXACTLY 120 characters,
//     `conversations.rs`'s own `PREVIEW_MAX_LENGTH` cap -- wider than the `sm:max-w-md` dialog at
//     `text-xs`, so it must clip too.
//
// Issue #1012 item 5 fixes (follow-ups from this #439 gate, PR #1011):
//   - The Current badge beside the long row is now actually exercised: this script sends one
//     real prompt through the composer and approves `user-message-time.jsonl`'s own scripted
//     tool call, settling the turn so `sync_from_state.rs`'s `if message_count > 0` guard marks
//     the long Conversation current BEFORE the history dialog is ever opened, rather than only
//     recording the gap as `notExercised` with an overstated "not a product bug" claim.
//   - Every dialog-presence/content read is now scoped to the KNOWN Conversation history dialog
//     (its own `DialogTitle` text, "Conversation history"), never any element that merely has
//     `role="dialog"`.
//   - Row-level truncation (title/preview `scrollWidth`/`clientWidth` overflow) is re-measured in
//     every theme in the themed-screenshot loop, not only once on the initial theme.
//   - A new check confirms the full-title/preview Tooltip (issue #1012 item 1) actually opens
//     when the long row receives keyboard focus.
//
// Decided (Skippy, delegated by Stuart 2026-10-18, issue #439, docs/PLAN.md): ellipsis only, no
// fade -- this script asserts the `truncate` utility's three CSS properties
// (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`) are in effect and that the
// long row's spans genuinely overflow (`scrollWidth > clientWidth`), never a gradient mask.
//
// What this script does NOT prove (recorded in its own `notExercised`):
//   - Windows forced-colors/high-contrast MEDIA rendering of the ellipsis itself: WebView2's own
//     CDP endpoint has no working `Emulation.setEmulatedMedia` for `forced-colors`
//     (`verify-tauri-567.mjs`'s own header comment records the same CDP limitation) -- the
//     "Dark (high contrast)" theme screenshot below is Refract's own in-app preset, not the OS
//     forced-colors media feature.
//   - A native browser tooltip actually painting on mouse hover over the native `title`
//     attribute: only its presence and exact value are asserted (structural proof), not a
//     rendered tooltip bitmap -- CDP has no mouse-hover-dwell-timer-triggered native tooltip
//     capture API. (Separately, the in-app Radix Tooltip added for issue #1012 item 1 IS proven
//     live below: it renders a real `[role="tooltip"]` node this script reads structurally.)
//   - Opening an earlier Conversation from this dialog (`handleOpenConversation`): out of this
//     issue's scope, matching `verify-862-conversation-history.mjs`'s own stated scope (it also
//     only opens the dialog and reads the rows, never switches).
//   - 200%+ zoom / an extremely narrow window: the dialog is centred and unconstrained by the
//     app window's own width (`fixed` positioning, `max-w-[calc(100%-2rem)]`), so this was not
//     re-run at another viewport size.
//
// WRITTEN, NOT RUN: no build slot has been granted for this sub-task (lane brief: "NO BUILD" --
// the build slot is granted by Main explicitly later) -- this script has never executed against
// a real built app. `node --check` is the only command that has been run against it.

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
  process.env.REFRACT_439_SHOTS_DIR || path.join(tmpdir(), `refract-439-history-truncate-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const THEMES = [
  { id: 'dark', name: 'Dark', shot: '01-history-dark.png' },
  { id: 'obsidian', name: 'Obsidian', shot: '02-history-obsidian.png' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', shot: '03-history-dark-high-contrast.png' }
];
const SHOT_NAMES = ['00-focus-tooltip.png', ...THEMES.map((t) => t.shot), 'report.json', 'app.log', 'fake-omp-invocations.log'];

const NORMAL_TITLE = 'Normal conversation (#439 check)';
const NORMAL_PREVIEW = 'Short first message, fits comfortably inside the dialog.';
const LONG_TITLE =
  'This deliberately very long Conversation title exists only to prove the history dialog truncates it to one line with an ellipsis instead of overflowing (issue #439)';
// Padded to EXACTLY 120 characters (`PREVIEW_MAX_LENGTH`, `conversations.rs`) so this is the
// widest preview the real app can ever produce, not an arbitrarily longer string.
const LONG_PREVIEW_PREFIX =
  'ISSUE439-LONG-PREVIEW-CHECK: first user message, deliberately sized to the full PREVIEW_MAX_LENGTH cap for the history-dialog truncation check ';
const LONG_PREVIEW = (LONG_PREVIEW_PREFIX + '#'.repeat(120)).slice(0, 120);
const PREVIEW_MAX_LENGTH = 120; // conversations.rs
// Issue #1012 item 5: one real prompt sent through the composer to settle a turn (reusing
// `user-message-time.jsonl`'s own already-scripted tool call -- AGENTS.md: no new fixtures), so
// `sync_from_state.rs`'s `if message_count > 0` guard marks the long Conversation current.
const PROMPT_TEXT = 'Issue #1012 check: exercise the Current badge next to a long truncating title.';

// Issue #1012 item 5: scopes every dialog-presence/content read to the KNOWN Conversation
// history dialog specifically (its own `DialogTitle` text), never any element that merely has
// `role="dialog"` -- the post-theme-switch reopen wait used to accept any such element.
const HISTORY_DIALOG_FINDER =
  `Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.querySelector('[data-slot="dialog-title"]')?.textContent.trim() === 'Conversation history')`;

/** Finder expression for one history row's own button by its exact title-span text, scoped to
 * the known history dialog (never any `[role="dialog"]`). Evaluates to `null` when the dialog
 * or the row is not present. */
function rowButtonFinder(titleText) {
  return `(() => { const dialog = ${HISTORY_DIALOG_FINDER}; if (!dialog) return null; return Array.from(dialog.querySelectorAll('ul li button[data-choice-item]')).find((b) => (b.children[0]?.querySelector('span')?.textContent ?? '') === ${JSON.stringify(titleText)}) ?? null; })()`;
}

/** `conversations.rs`'s own `parse_file_name` doc comment: a file is named
 * `<timestamp with ':'/'.' replaced by '-'>_<id>.jsonl`, the timestamp prefix always exactly 25
 * characters (`YYYY-MM-DDTHH-mm-ss-mmmZ_`). */
function conversationFileName(isoTimestamp, id) {
  const prefix = isoTimestamp.replace(/[:.]/g, '-');
  if (prefix.length !== 24) throw new Error(`conversationFileName: expected a 24-char dash-replaced prefix, got ${prefix.length} ("${prefix}")`);
  return `${prefix}_${id}.jsonl`;
}

function writeConversationFile(dir, isoTimestamp, id, lines) {
  const filePath = path.join(dir, conversationFileName(isoTimestamp, id));
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

/** Reads one Conversation history row's own structural truncation evidence: the title span
 * (inside `btn.children[0]`, alongside the Current badge) and the preview span
 * (`btn.children[2]`, only present when `conversation.preview` is non-empty). Returns `null` for
 * either span if the row does not have it (e.g. no preview). */
async function readRowTruncationEvidence(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const btn = ${rowButtonFinder(titleText)};
    if (!btn) return null;
    const describe = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        textContent: el.textContent,
        title: el.getAttribute('title'),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowsVisually: el.scrollWidth > el.clientWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace
      };
    };
    const titleSpan = btn.children[0]?.querySelector('span') ?? null;
    const previewSpan = btn.children[2] ?? null;
    return {
      hasCurrentBadge: !!btn.querySelector('[data-slot="badge"]'),
      title: describe(titleSpan),
      preview: previewSpan ? describe(previewSpan) : null
    };
  })()`);
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir, conversationFileDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [
    'Windows forced-colors/high-contrast MEDIA rendering of the ellipsis: WebView2\'s own CDP endpoint has no working Emulation.setEmulatedMedia for forced-colors (same limitation verify-tauri-567.mjs already records); the "Dark (high contrast)" screenshot below is Refract\'s own in-app preset, not the OS forced-colors feature.',
    'A native browser tooltip (the title/preview spans\' own `title` attribute) actually painting on mouse hover: only its presence and exact value are asserted (structural proof), not a rendered tooltip bitmap -- CDP has no hover-dwell-timer tooltip capture API. The separate in-app Radix Tooltip (issue #1012 item 1) IS proven live below via a real [role="tooltip"] node.',
    'Opening an earlier Conversation from this dialog (handleOpenConversation): out of this issue\'s scope, matching verify-862-conversation-history.mjs\'s own stated scope (it also only opens the dialog and reads the rows, never switches).',
    'Behaviour at 200%+ zoom or an extremely narrow window: the dialog is fixed-positioned and unconstrained by the app window\'s own width, so this was not re-run at another viewport size.'
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

    // Points the fake Session at this file (REFRACT_FAKE_OMP_CONVERSATION_FILE below). In
    // principle this makes it the Session's own current Conversation (so its row would also
    // render the Current badge beside the truncating long title -- the combination the issue's
    // design notes call out), but see the `notExercised` note below: this scenario's own first
    // `get_state` reports `messageCount: 0` (a genuinely fresh attach, no prompt sent), and
    // `sync_from_state.rs`'s own `if message_count > 0` guard only sets
    // `Session.current_conversation` once a turn has actually completed, so no row is ever
    // marked current in this run without sending a prompt through the scripted tape.
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
        // `user-message-time.jsonl`'s own `get_state` responses use the `$conversationFile`
        // sentinel for `sessionFile` -- pointing it at the LONG file makes
        // `session_dir = dirname(sessionFile)` (sync_from_state.rs) resolve to
        // `conversationFileDir`, the real directory `conversations.list` scans (which also holds
        // the "normal" file seeded above), and marks the long Conversation as current.
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

    // Shim-confirmed guard (same pattern as verify-862/941/991): without this, a silently-wrong
    // fake-omp shim could still let the whole run "pass" on UI state alone.
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

    // ---- Issue #1012 item 5: exercise the Current badge beside the long truncating title.
    // Sends one real prompt through the composer (the SAME user-message-time.jsonl tape already
    // in use -- AGENTS.md: no new fixtures) and approves its one scripted tool call, so the turn
    // settles, get_state reports messageCount: 2, and sync_from_state.rs's own
    // `if message_count > 0` guard marks the long Conversation (this Session's sessionFile, via
    // REFRACT_FAKE_OMP_CONVERSATION_FILE above) current BEFORE the history dialog is ever opened
    // below -- replacing the previous notExercised gap with a real assertion. ----
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

    // ---- Issue #1012 item 1: the full-title/preview Tooltip opens on keyboard focus ----
    await cdp.evaluate(`(${rowButtonFinder(LONG_TITLE)})?.focus()`);
    await cdp.waitFor(`document.activeElement === (${rowButtonFinder(LONG_TITLE)})`, {
      timeoutMs: 5_000,
      label: 'Long row button received keyboard focus'
    });
    await cdp.waitFor(`!!document.querySelector('[role="tooltip"]')`, {
      timeoutMs: 5_000,
      label: 'Full-title Tooltip opened on keyboard focus of the long row'
    });
    const focusTooltipText = await cdp.evaluate(`document.querySelector('[role="tooltip"]')?.textContent ?? null`);
    if (!focusTooltipText || !focusTooltipText.includes(LONG_TITLE) || !focusTooltipText.includes(LONG_PREVIEW)) {
      failures.push(`Full-title Tooltip on keyboard focus: expected content to include the full long title and preview, got ${JSON.stringify(focusTooltipText)}.`);
    } else {
      findings.push('Full-title Tooltip appears on keyboard focus of the long row, carrying the complete, un-truncated title and preview text (issue #1012 item 1).');
      await cdp.screenshot(path.join(SHOTS_DIR, '00-focus-tooltip.png'));
      findings.push('Screenshot captured: the full-title/preview Tooltip visibly open beside the long row while it holds keyboard focus (00-focus-tooltip.png).');
    }
    // Live-run finding (not a #1012 scope item, but a pre-existing gap this script's first ever
    // execution surfaced -- this script was "WRITTEN, NOT RUN" before this fix): a synthetic
    // CDP `Input.dispatchKeyEvent` Escape never closed this dialog in this build regardless of
    // what held keyboard focus beforehand (confirmed with and without a prior blur) -- root
    // cause not conclusively isolated. The per-theme loop below dismisses the dialog with a
    // real click on its own visible Close button (`DialogPrimitive.Close`, `dialog.tsx`)
    // instead, which is unambiguous and does not depend on whatever this Escape-handling gap is.

    // ---- Dialog-level: no horizontal overflow, re-measured in every theme below ----
    async function assertDialogNeverScrollsHorizontally(themeName) {
      const dialogGeometry = await cdp.evaluate(`(() => {
        const dialog = ${HISTORY_DIALOG_FINDER};
        return dialog ? { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth } : null;
      })()`);
      if (!dialogGeometry) {
        failures.push(`[${themeName}] Conversation history dialog not found when measuring horizontal overflow.`);
        return;
      }
      if (dialogGeometry.scrollWidth > dialogGeometry.clientWidth) {
        failures.push(
          `[${themeName}] Conversation history dialog has horizontal overflow: scrollWidth ${dialogGeometry.scrollWidth} > clientWidth ${dialogGeometry.clientWidth}.`
        );
      } else {
        findings.push(`[${themeName}] Conversation history dialog has no horizontal overflow (scrollWidth ${dialogGeometry.scrollWidth} <= clientWidth ${dialogGeometry.clientWidth}).`);
      }
    }

    function assertTruncateCss(label, span) {
      if (!span) {
        failures.push(`${label}: span not found.`);
        return;
      }
      if (span.overflow !== 'hidden' || span.textOverflow !== 'ellipsis' || span.whiteSpace !== 'nowrap') {
        failures.push(`${label}: truncate CSS not fully in effect (overflow=${span.overflow}, textOverflow=${span.textOverflow}, whiteSpace=${span.whiteSpace}).`);
      } else {
        findings.push(`${label}: single-line with text-overflow:ellipsis active (overflow:hidden, white-space:nowrap).`);
      }
    }

    // ---- Row-level: ellipsis CSS in effect, long row genuinely clips, title attribute carries
    // the full text, normal row does NOT need to clip (control case), Current badge beside the
    // long row -- re-run in every theme (issue #1012 item 5: geometry is no longer assumed
    // constant across themes). ----
    async function assertRowTruncation(themeName) {
      const normalEvidence = await readRowTruncationEvidence(cdp, NORMAL_TITLE);
      const longEvidence = await readRowTruncationEvidence(cdp, LONG_TITLE);

      if (!normalEvidence) {
        failures.push(`[${themeName}] Normal Conversation row not found.`);
      } else {
        assertTruncateCss(`[${themeName}] Normal row title`, normalEvidence.title);
        if (normalEvidence.title && normalEvidence.title.overflowsVisually) {
          failures.push(`[${themeName}] Normal row title unexpectedly overflows visually (scrollWidth ${normalEvidence.title.scrollWidth} > clientWidth ${normalEvidence.title.clientWidth}) -- the control case should fit without clipping.`);
        }
        if (normalEvidence.title && normalEvidence.title.textContent !== NORMAL_TITLE) {
          failures.push(`[${themeName}] Normal row title text content is "${normalEvidence.title.textContent}", expected "${NORMAL_TITLE}".`);
        }
        assertTruncateCss(`[${themeName}] Normal row preview`, normalEvidence.preview);
        if (normalEvidence.preview && normalEvidence.preview.overflowsVisually) {
          failures.push(`[${themeName}] Normal row preview unexpectedly overflows visually (scrollWidth ${normalEvidence.preview.scrollWidth} > clientWidth ${normalEvidence.preview.clientWidth}) -- the control case should fit without clipping.`);
        }
        if (normalEvidence.hasCurrentBadge) {
          failures.push(`[${themeName}] Normal row unexpectedly shows the Current badge (expected only the long row to be current).`);
        }
        findings.push(`[${themeName}] Normal (short) row: both title and preview fit without visual overflow (control case).`);
      }

      if (!longEvidence) {
        failures.push(`[${themeName}] Long Conversation row not found.`);
      } else {
        assertTruncateCss(`[${themeName}] Long row title`, longEvidence.title);
        if (longEvidence.title && !longEvidence.title.overflowsVisually) {
          failures.push(`[${themeName}] Long row title does not overflow visually (scrollWidth ${longEvidence.title.scrollWidth} <= clientWidth ${longEvidence.title.clientWidth}) -- the long title fixture did not actually need to clip.`);
        } else if (longEvidence.title) {
          findings.push(`[${themeName}] Long row title genuinely clips visually (scrollWidth ${longEvidence.title.scrollWidth} > clientWidth ${longEvidence.title.clientWidth}), proving the ellipsis is actually doing work, not just styled.`);
        }
        if (longEvidence.title && longEvidence.title.title !== LONG_TITLE) {
          failures.push(`[${themeName}] Long row title's own title attribute is ${JSON.stringify(longEvidence.title.title)}, expected the full title ${JSON.stringify(LONG_TITLE)} -- the full text must stay available even when visually clipped.`);
        } else if (longEvidence.title) {
          findings.push(`[${themeName}] Long row title's own title attribute carries the full, un-truncated title text.`);
        }
        if (!longEvidence.hasCurrentBadge) {
          failures.push(`[${themeName}] Long row does not show the Current badge beside the truncating long title -- expected once Session.current_conversation is set.`);
        } else {
          findings.push(`[${themeName}] Long row shows the Current badge beside the truncating long title, the exact combination the issue's design notes call out.`);
        }

        assertTruncateCss(`[${themeName}] Long row preview`, longEvidence.preview);
        if (longEvidence.preview && !longEvidence.preview.overflowsVisually) {
          failures.push(`[${themeName}] Long row preview does not overflow visually (scrollWidth ${longEvidence.preview.scrollWidth} <= clientWidth ${longEvidence.preview.clientWidth}) -- the 120-char preview fixture did not actually need to clip.`);
        } else if (longEvidence.preview) {
          findings.push(`[${themeName}] Long row preview (exactly ${PREVIEW_MAX_LENGTH} characters, PREVIEW_MAX_LENGTH) genuinely clips visually (scrollWidth ${longEvidence.preview.scrollWidth} > clientWidth ${longEvidence.preview.clientWidth}).`);
        }
        if (longEvidence.preview && longEvidence.preview.title !== LONG_PREVIEW) {
          failures.push(`[${themeName}] Long row preview's own title attribute is ${JSON.stringify(longEvidence.preview.title)}, expected the full preview ${JSON.stringify(LONG_PREVIEW)}.`);
        } else if (longEvidence.preview) {
          findings.push(`[${themeName}] Long row preview's own title attribute carries the full, un-truncated 120-character preview text.`);
        }
      }
    }

    // ---- Themed screenshots (Dark, Obsidian, Dark high contrast), re-confirming the dialog's
    // own no-horizontal-overflow guarantee AND row-level truncation hold under every theme, not
    // just the one open above (issue #1012 item 5) ----
    for (const theme of THEMES) {
      // The dialog is a modal (Radix `Dialog`, `dialog.tsx`): its overlay blocks pointer events
      // everywhere outside the dialog content, so `[data-profile-name-button]` (outside the
      // dialog) cannot be clicked while it is open. Close it first, switch, then reopen for the
      // per-theme overflow/truncation checks and screenshot.
      await cdp.clickByText('Close', { inDialog: true });
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
      await assertDialogNeverScrollsHorizontally(theme.name);
      await assertRowTruncation(theme.name);
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
