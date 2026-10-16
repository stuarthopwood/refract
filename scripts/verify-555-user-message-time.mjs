#!/usr/bin/env node
// Live CDP check for issue #555 (chat: show the time above the user message, mark turn
// boundaries clearly), required before the draft PR -- same precedent #558/#570/#917/#565 set
// for a scoped visual change: two real sends through the recorded-frame fake `omp`
// (scripts/verify-tauri-fake-omp.mjs) across TWO SEPARATE app launches against the SAME
// `REFRACT_DATA_DIR` -- a genuine reopened-Conversation reattach, not a same-process
// simulation -- driven over real CDP input, never a state poke.
//
// Fixtures (see fixtures/omp-frames/README.md's own provenance rows):
//   - `user-message-time.jsonl` (launch 1): two human turns, both `msg-u1`/`msg-u2` omitting
//     `timestamp` so the live send gets a REAL, current `at` (`apply_message_snapshot`'s
//     `now_ms()` fallback) instead of every other fixture's deliberately-zeroed placeholder.
//   - `user-message-time-reopen.jsonl` (launch 2): scripts the real `switch_session`/`get_state`/
//     `set_ask_dialog`/`get_messages_page` reattach sequence, with a canned history response
//     exercising `items_from_history`'s `.unwrap_or(0)` path directly: four messages whose
//     `timestamp` fields this script computes AT RUN TIME (via the new `$histTodayAt`/
//     `$histYesterdayAt`/`$histThisYearAt`/`$histPastYearAt` sentinels) so each lands in the
//     day-aware bucket `UserMessageRow.tsx`'s `formatMessageTime` is meant to show, plus one
//     message with no timestamp at all.
// Both reference the new `$conversationFile` sentinel (`verify-tauri-fake-omp.mjs`), seeded from
// `REFRACT_FAKE_OMP_CONVERSATION_FILE` -- a REAL file this script pre-creates on disk, since
// `assert_conversation_file_exists` (launch_support.rs) checks the persisted Session's
// `current_conversation` path actually exists before sending `switch_session` on reattach.
//
// Important scope note: the HISTORY content in launch 2 is a canned fake-omp tape, not data
// launch 1 actually persisted -- launch 1's own two live-sent messages are never replayed back.
// This proves `items_from_history`'s real code path renders a stored timestamp (or its absence)
// correctly on a genuine reattach; it does not prove a specific timestamp survives Refract's own
// persistence across the two launches (OMP, not Refract, owns that file).
//
// Assertions, in order:
//   Launch 1 (two human turns, one process):
//     1. Turn 1's `<time dateTime=...>` parses close to the real send time (a real, current
//        `at`, not stale/default) and its visible text matches an hour:minute clock format.
//     2. It sits outside the bubble's own box (`[data-slot="message-content"]`) and visually
//        above it.
//     3. The row after turn 1's user message carries `mt-6` -- `TURN_GAP_CLASS`, Transcript
//        rhythm's own unchanged house rule, applied to the row below the human turn.
//     4. Turn 2's own user-message wrapper ALSO carries `mt-6` -- the same unchanged rule applied
//        above the second human turn -- while turn 1's own wrapper (the very first row in the
//        transcript) carries NO margin class, the base case every OTHER non-first row (turn 2
//        included) is compared against.
//     5. Turn 2's `<time>` also renders with its own fresh, real `at`.
//   Launch 2 (reopened Conversation, same REFRACT_DATA_DIR, a genuine second app launch):
//     6. Four historical messages (today, yesterday, earlier this year, a past year) each render
//        a `<time>` whose visible label and `dateTime` match this script's OWN computed expected
//        value for that exact bucket (a JS re-implementation of `formatMessageTime`, kept in
//        sync by comment).
//     7. The historical message with NO `timestamp` key renders NO `<time>` row at all (`at === 0`,
//        "hide rather than invent").
//
// Note on fidelity: launch 2 reaches the Session via `[data-session-open]` (the existing row
// already in the session list after the registry round-trips through REFRACT_DATA_DIR), not via
// "New conversation"/the Conversation switcher UI -- `conversations.list` scans REAL files in the
// Session's own worktree directory (ipc/conversations.rs), which the fake `omp` never creates, so
// the switcher's own history dialog would show "No earlier Conversations" regardless of what the
// wire protocol reports. The wire-level reattach this script drives (`switch_session`/`get_state`/
// `get_messages_page`, `items_from_history`) is the SAME code a Conversation-switcher click would
// also exercise once get_messages_page replies -- documented here rather than silently assumed.

import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = process.env.REFRACT_555_SHOTS_DIR || path.join(tmpdir(), 'refract-555-user-message-time-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Deliberately never appear in the scripted replies themselves, matching `verify-tauri.mjs`'s own
// independence rule for its own reply token.
const PROMPT_MESSAGE_1 = 'Checking issue 555 turn one timestamp rendering now.';
const PROMPT_MESSAGE_2 = 'Checking issue 555 turn two timestamp and margin now.';
const REPLY_TOKEN_1 = 'xyzzy9'; // fixture's fixed turn-1 assistant reply token
const REPLY_TOKEN_2 = 'turn-two-streamed-ok'; // fixture's fixed turn-2 assistant reply token
const HIST_TODAY_TEXT = 'Historical message from today.';
const HIST_YESTERDAY_TEXT = 'Historical message from yesterday.';
const HIST_THIS_YEAR_TEXT = 'Historical message from earlier this year.';
const HIST_PAST_YEAR_TEXT = 'Historical message from a past year.';
const HIST_NO_TIME_TEXT = 'Historical message with no timestamp at all.';

/** JS re-implementation of `UserMessageRow.tsx`'s `formatMessageTime` -- MUST be kept in sync by
 * hand with that function (there is no shared module between the Vite renderer and this plain
 * Node script). Used to compute the EXACT expected visible label for each historical message, so
 * the reopen assertions below check real equality, not a loose pattern. */
function expectedLabelFor(date, now) {
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / 86_400_000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) {
    const word = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day');
    return `${word[0].toUpperCase()}${word.slice(1)} ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

/** Picks one real instant per day-aware bucket (today, yesterday, earlier this year, a past
 * year), relative to whichever real calendar day this script actually runs on, then SELF-VALIDATES
 * every candidate against the exact same bucketing rule `expectedLabelFor` uses before handing
 * any of them back -- a run never silently asserts the wrong bucket; it throws instead. Every
 * candidate (other than "yesterday", which must use calendar subtraction to land exactly one day
 * back across a month/year boundary) is a RELATIVE offset from "now" rather than a fixed calendar
 * date, so the same code stays correct on any day of the year the script is actually run on.
 * Known narrow gap (documented, not silently wrong): within the first ~20 days of January, or in
 * the first minute after local midnight, there is no valid "earlier this year, not recent"/
 * "today" instant at all -- the self-validation below throws a clear error in that case instead
 * of asserting the wrong bucket; rerun a few minutes/days later. */
function computeHistoryTimestamps() {
  const now = new Date();
  const dayDiffFrom = (d) => {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfThatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((startOfToday - startOfThatDay) / 86_400_000);
  };
  const today = new Date(now.getTime() - 60_000);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  const thisYear = new Date(now.getTime() - 20 * 86_400_000);
  const pastYear = new Date(now.getTime() - 400 * 86_400_000);

  if (dayDiffFrom(today) !== 0) throw new Error(`computeHistoryTimestamps: "today" candidate did not land in today's bucket (dayDiff=${dayDiffFrom(today)}) -- rerun a minute later`);
  if (dayDiffFrom(yesterday) !== 1) throw new Error(`computeHistoryTimestamps: "yesterday" candidate did not land in yesterday's bucket (dayDiff=${dayDiffFrom(yesterday)})`);
  if (!(dayDiffFrom(thisYear) > 1 && thisYear.getFullYear() === now.getFullYear())) {
    throw new Error(`computeHistoryTimestamps: "thisYear" candidate did not land in the same-year-not-recent bucket (dayDiff=${dayDiffFrom(thisYear)}, year=${thisYear.getFullYear()}) -- known gap in the first ~20 days of January, rerun later`);
  }
  if (pastYear.getFullYear() === now.getFullYear()) throw new Error('computeHistoryTimestamps: "pastYear" candidate is not actually in a past year');

  return { now, today, yesterday, thisYear, pastYear };
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// Local copy of the fake-omp-aware launcher (pathPrepend/extraEnv), matching every other
// verify-5xx script that drives the recorded-frame fake omp: the shared `launchBuiltExe` in
// `verify-tauri-scratch-helpers.mjs` supports only a real-omp launch (no PATH shim/extra env).
async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${port}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Reads the `<time>` element rendered anywhere inside the bubble's own
 * `[data-slot="message-scroller-item"]` wrapper (gate round 1, Tests/Code Low: searching only
 * `bubble.previousElementSibling` made the "outside the bubble's box" check true by
 * construction -- a `<time>` that moved INSIDE the bubble would then just read as "no `<time>`
 * found", never as "inside the box". Searching the whole wrapper instead means `insideBubbleBox`
 * and the hidden-when-`at===0` check both genuinely test where the element is, wherever it
 * renders), or `null` if `item.at === 0` hid it (`UserMessageTime` returns `null`). Also reports
 * the wrapper's own class list, so the caller can check the turn-gap margin on the SAME probe. */
function timeAndMarginProbeExpr(messageText) {
  return `
    (() => {
      const transcript = document.querySelector('[aria-label="Transcript"]');
      if (!transcript) return { error: 'no Transcript region' };
      const bubble = Array.from(transcript.querySelectorAll('[data-slot="message"][data-align="end"]'))
        .find((el) => el.textContent.includes(${JSON.stringify(messageText)}));
      if (!bubble) return { error: 'no matching user bubble for ' + ${JSON.stringify(messageText)} };
      const wrapper = bubble.closest('[data-slot="message-scroller-item"]');
      const timeEl = wrapper ? wrapper.querySelector('time') : null;
      const bubbleRect = bubble.getBoundingClientRect();
      if (!timeEl) {
        return { hasTime: false, wrapperClassName: wrapper ? wrapper.className : null };
      }
      const timeRect = timeEl.getBoundingClientRect();
      return {
        hasTime: true,
        dateTime: timeEl.getAttribute('dateTime'),
        visibleText: timeEl.textContent.trim(),
        insideBubbleBox: !!timeEl.closest('[data-slot="message-content"]'),
        timeBottom: timeRect.bottom,
        bubbleTop: bubbleRect.top,
        wrapperClassName: wrapper ? wrapper.className : null,
      };
    })()
  `;
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const findings = [];
  const failures = [];
  const notExercised = [];
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, conversationFileDir;
  let child1, child2;
  let cdp1, cdp2;
  let exeHash = null;
  let gitHeadSha = null;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-555-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-555-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-555-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-555-repo-')), 'verify-555');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-555-exe-'));
    conversationFileDir = mkdtempSync(path.join(tmpdir(), 'refract-555-conv-'));
    const conversationFile = path.join(conversationFileDir, 'conversation.json');
    // A REAL file on disk (content irrelevant: `assert_conversation_file_exists` only checks
    // `tokio::fs::metadata` succeeds), so launch 2's `switch_session` reattach passes.
    writeFileSync(conversationFile, '{}');
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-555: git HEAD ${gitHeadSha}`);
    console.log(`verify-555: data dir ${dataDir}`);
    console.log(`verify-555: repo dir ${repoDir}`);
    console.log(`verify-555: conversation file ${conversationFile}`);
    console.log(`verify-555: shots dir ${SHOTS_DIR}`);

    mkdirSync(shimDir, { recursive: true });
    const shimSrc = path.join(__dirname, 'verify-tauri-omp-shim.rs');
    const shimOut = path.join(shimDir, 'omp.exe');
    const shimResult = spawnSync_('rustc', ['--edition', '2021', '-O', shimSrc, '-o', shimOut]);
    if (shimResult.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${shimResult.status}):\n${shimResult.stderr}`);
    const launcherExe = buildLauncher(shimDir);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-555' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-555: exe copied to ${exePath} (sha256 ${exeHash.slice(0, 12)}...)`);

    // ---------------------------------------------------------------------
    // Launch 1: two human turns through user-message-time.jsonl
    // ---------------------------------------------------------------------
    const port1 = await getFreePort();
    const launched1 = await launchBuiltExe(launcherExe, exePath, {
      port: port1,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app-launch1.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time',
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-launch1.log'),
      },
    });
    child1 = launched1.child;
    const wsUrl1 = await waitForCdpTarget(port1, { timeoutMs: 60_000 });
    cdp1 = await CdpSession.connect(wsUrl1);
    if (!isTargetOwningPort(port1, launched1.targetPid)) {
      throw new Error(`verify-555: CDP target on port ${port1} is not owned by the process this run launched (pid ${launched1.targetPid})`);
    }

    await cdp1.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp1.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness checklist green' }
    );
    await cdp1.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp1.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp1.click(`document.querySelector('[role="dialog"] input')`);
    await cdp1.send('Input.insertText', { text: repoDir });
    await cdp1.clickByText('Add repository', { inDialog: true });
    await cdp1.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Repository added, session-list row rendered' }
    );

    await cdp1.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp1.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp1.clickByText('Create session', { inDialog: true });
    await cdp1.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp1.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled',
    });
    await cdp1.screenshot(path.join(SHOTS_DIR, '01-session-opened.png'));

    // --- Turn 1 ---
    await cdp1.typeIntoByLabel('Message', PROMPT_MESSAGE_1);
    await cdp1.clickByLabel('Send message');
    await cdp1.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(PROMPT_MESSAGE_1)}); })()`,
      { timeoutMs: 30_000, label: 'Turn 1 message rendered' }
    );
    const sendStartedAt1 = Date.now();
    const probe1 = await cdp1.evaluate(timeAndMarginProbeExpr(PROMPT_MESSAGE_1));
    console.log('verify-555: turn 1 probe', JSON.stringify(probe1));
    checkMessageProbe(probe1, { label: 'turn 1', sentAt: sendStartedAt1, expectWrapperMargin: null, findings, failures });

    const afterTurn1Probe = await cdp1.evaluate(`
      (() => {
        const transcript = document.querySelector('[aria-label="Transcript"]');
        const bubble = Array.from(transcript.querySelectorAll('[data-slot="message"][data-align="end"]'))
          .find((el) => el.textContent.includes(${JSON.stringify(PROMPT_MESSAGE_1)}));
        const wrapper = bubble ? bubble.closest('[data-slot="message-scroller-item"]') : null;
        const next = wrapper ? wrapper.nextElementSibling : null;
        return { error: !next ? 'no row found after turn 1\\'s user message' : null, className: next ? next.className : null };
      })()
    `);
    console.log('verify-555: row-after-turn-1 probe', JSON.stringify(afterTurn1Probe));
    if (afterTurn1Probe.error) {
      failures.push(`turn 1: ${afterTurn1Probe.error}`);
    } else if (!/\bmt-6\b/.test(afterTurn1Probe.className || '')) {
      failures.push(`turn 1: the row right after the user message does not carry mt-6 (got "${afterTurn1Probe.className}") -- space BELOW the human turn is missing`);
    } else {
      findings.push(`turn 1: the row right after the user message carries mt-6 -- space BELOW the human turn confirmed.`);
    }

    await cdp1.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, {
      timeoutMs: 30_000,
      label: 'Turn 1 approval card rendered',
    });
    await cdp1.clickByText('Approve');
    await cdp1.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(REPLY_TOKEN_1)}); })()`,
      { timeoutMs: 60_000, label: 'Turn 1 settled (reply token present)' }
    );
    await cdp1.screenshot(path.join(SHOTS_DIR, '02-turn1-settled.png'));

    // --- Turn 2 (a second human turn: proves the space ABOVE a new turn too) ---
    await cdp1.typeIntoByLabel('Message', PROMPT_MESSAGE_2);
    await cdp1.clickByLabel('Send message');
    await cdp1.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(PROMPT_MESSAGE_2)}); })()`,
      { timeoutMs: 30_000, label: 'Turn 2 message rendered' }
    );
    const sendStartedAt2 = Date.now();
    const probe2 = await cdp1.evaluate(timeAndMarginProbeExpr(PROMPT_MESSAGE_2));
    console.log('verify-555: turn 2 probe', JSON.stringify(probe2));
    checkMessageProbe(probe2, { label: 'turn 2', sentAt: sendStartedAt2, expectWrapperMargin: 'mt-6', findings, failures });

    // Turn 1's own user-message wrapper gets NO margin class: it is the very first row in the
    // whole transcript, the one case `TURN_GAP_CLASS` is never applied to (Transcript.tsx's
    // `isFirstRow` guard) -- distinguishing this from every OTHER row (including turn 2's own
    // user message below), which all get `mt-6` under Transcript rhythm's unchanged house rule.
    if (probe1.wrapperClassName != null) {
      if (/\bmt-6\b/.test(probe1.wrapperClassName)) {
        failures.push(`turn 1's own user-message wrapper unexpectedly carries mt-6 (it is the FIRST row in the transcript, which should carry no margin class at all): "${probe1.wrapperClassName}"`);
      } else {
        findings.push(`turn 1's own user-message wrapper carries no margin class, the one documented exception (the first row) to Transcript rhythm's mt-6 rule.`);
      }
    }

    await cdp1.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(REPLY_TOKEN_2)}); })()`,
      { timeoutMs: 60_000, label: 'Turn 2 settled (reply token present)' }
    );
    await cdp1.screenshot(path.join(SHOTS_DIR, '03-turn2-settled.png'));

    cdp1.close();
    cdp1 = undefined;
    await stopLauncher(child1);
    child1 = undefined;

    // ---------------------------------------------------------------------
    // Launch 2: reopen the SAME Session against the SAME REFRACT_DATA_DIR
    // ---------------------------------------------------------------------
    const { now: histNow, today: histToday, yesterday: histYesterday, thisYear: histThisYear, pastYear: histPastYear } = computeHistoryTimestamps();
    console.log('verify-555: history timestamps', {
      now: histNow.toISOString(),
      today: histToday.toISOString(),
      yesterday: histYesterday.toISOString(),
      thisYear: histThisYear.toISOString(),
      pastYear: histPastYear.toISOString(),
    });

    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exePath, {
      port: port2,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app-launch2.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time-reopen',
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
        REFRACT_FAKE_OMP_HIST_TODAY_AT: String(histToday.getTime()),
        REFRACT_FAKE_OMP_HIST_YESTERDAY_AT: String(histYesterday.getTime()),
        REFRACT_FAKE_OMP_HIST_THIS_YEAR_AT: String(histThisYear.getTime()),
        REFRACT_FAKE_OMP_HIST_PAST_YEAR_AT: String(histPastYear.getTime()),
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-launch2.log'),
      },
    });
    child2 = launched2.child;
    const wsUrl2 = await waitForCdpTarget(port2, { timeoutMs: 60_000 });
    cdp2 = await CdpSession.connect(wsUrl2);
    if (!isTargetOwningPort(port2, launched2.targetPid)) {
      throw new Error(`verify-555: CDP target on port ${port2} is not owned by the process this run launched (pid ${launched2.targetPid})`);
    }

    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered' });
    await cdp2.screenshot(path.join(SHOTS_DIR, '04-relaunch-session-list.png'));
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    await cdp2.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Relaunch: Session reattached, composer enabled',
    });
    await cdp2.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && [${JSON.stringify(HIST_TODAY_TEXT)}, ${JSON.stringify(HIST_YESTERDAY_TEXT)}, ${JSON.stringify(HIST_THIS_YEAR_TEXT)}, ${JSON.stringify(HIST_PAST_YEAR_TEXT)}, ${JSON.stringify(HIST_NO_TIME_TEXT)}].every((s) => t.textContent.includes(s)); })()`,
      { timeoutMs: 30_000, label: 'Relaunch: all five historical messages rendered' }
    );
    await cdp2.screenshot(path.join(SHOTS_DIR, '05-relaunch-history.png'));

    const histBuckets = [
      { text: HIST_TODAY_TEXT, label: 'reopen (today)', date: histToday },
      { text: HIST_YESTERDAY_TEXT, label: 'reopen (yesterday)', date: histYesterday },
      { text: HIST_THIS_YEAR_TEXT, label: 'reopen (this year)', date: histThisYear },
      { text: HIST_PAST_YEAR_TEXT, label: 'reopen (past year)', date: histPastYear },
    ];
    for (const bucket of histBuckets) {
      const probe = await cdp2.evaluate(timeAndMarginProbeExpr(bucket.text));
      console.log(`verify-555: ${bucket.label} probe`, JSON.stringify(probe));
      if (probe.error) {
        failures.push(`${bucket.label}: probe failed: ${probe.error}`);
        continue;
      }
      if (!probe.hasTime) {
        failures.push(`${bucket.label}: rendered NO <time> row at all, expected the day-aware label`);
        continue;
      }
      const expectedIso = bucket.date.toISOString();
      const actualIso = probe.dateTime ? new Date(probe.dateTime).toISOString() : null;
      const expectedLabel = expectedLabelFor(bucket.date, histNow);
      if (actualIso !== expectedIso) {
        failures.push(`${bucket.label}: dateTime ("${probe.dateTime}" -> ${actualIso}) does not match the fixture's own stored timestamp (expected ${expectedIso})`);
      } else if (probe.visibleText !== expectedLabel) {
        failures.push(`${bucket.label}: visible text "${probe.visibleText}" does not match the expected day-aware label "${expectedLabel}"`);
      } else {
        findings.push(`${bucket.label}: dateTime matches exactly (${expectedIso}) and the visible label "${probe.visibleText}" matches the expected day-aware format.`);
      }
    }

    const histNoTimeProbe = await cdp2.evaluate(timeAndMarginProbeExpr(HIST_NO_TIME_TEXT));
    console.log('verify-555: reopen (no timestamp) probe', JSON.stringify(histNoTimeProbe));
    if (histNoTimeProbe.error) {
      failures.push(`reopen history (no timestamp) probe failed: ${histNoTimeProbe.error}`);
    } else if (histNoTimeProbe.hasTime) {
      failures.push(`the historical message with NO stored timestamp unexpectedly rendered a <time> row (dateTime="${histNoTimeProbe.dateTime}") -- should be hidden (at === 0, "hide rather than invent")`);
    } else {
      findings.push('the historical message with no stored timestamp at all renders NO <time> row, confirming the at === 0 "hide rather than invent" guard on a genuine reattach.');
    }

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-555: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-555: findings ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-555: NOT exercised (documented, not silently dropped) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-555: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    console.error('verify-555: FAIL');
    console.error(err);
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    process.exitCode = 1;
  } finally {
    cdp1?.close();
    cdp2?.close();
    if (child1) await stopLauncher(child1);
    if (child2) await stopLauncher(child2);
    await safeRmSync(shimDir, 'verify-555');
    await safeRmSync(dataDir, 'verify-555');
    await safeRmSync(importSourceDir, 'verify-555');
    await safeRmSync(conversationFileDir, 'verify-555');
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir), 'verify-555');
    await safeRmSync(repoDir, 'verify-555');
    await safeRmSync(exeDir, 'verify-555');
  }
}

/** Shared assertions for one live-sent turn's probe result: a real, fresh (within 2 minutes of
 * `sentAt`) timestamp; an hour:minute visible label; placement outside the bubble's own box and
 * visually above it; and (when `expectWrapperMargin` is given) the user-message wrapper's own
 * turn-gap margin class. */
function checkMessageProbe(probe, { label, sentAt, expectWrapperMargin, findings, failures }) {
  if (probe.error) {
    failures.push(`${label}: <time> probe failed: ${probe.error}`);
    return;
  }
  if (!probe.hasTime) {
    failures.push(`${label}: no <time> element rendered for a live-sent message (should always show one unless at === 0)`);
    return;
  }
  if (!probe.dateTime) {
    failures.push(`${label}: the <time> element has no dateTime attribute`);
  } else {
    const parsed = new Date(probe.dateTime).getTime();
    const ageMs = Date.now() - parsed;
    if (!Number.isFinite(parsed)) {
      failures.push(`${label}: dateTime="${probe.dateTime}" did not parse as a valid date`);
    } else if (sentAt - parsed > 5000 || parsed - Date.now() > 5000) {
      failures.push(`${label}: dateTime="${probe.dateTime}" is not close to the real send time (age ${ageMs}ms) -- not this message's own timestamp`);
    } else {
      findings.push(`${label}: dateTime="${probe.dateTime}" is this message's own real, fresh timestamp (age ${ageMs}ms since send).`);
    }
  }
  if (!/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(probe.visibleText || '')) {
    failures.push(`${label}: visible timestamp text "${probe.visibleText}" does not match an hour:minute clock format`);
  } else {
    findings.push(`${label}: visible timestamp text "${probe.visibleText}" matches an hour:minute clock format.`);
  }
  if (probe.insideBubbleBox) {
    failures.push(`${label}: the <time> element is INSIDE the bubble's own box -- violates the zero-box-rule placement`);
  } else {
    findings.push(`${label}: the <time> element is NOT inside the bubble's own box (renders as a sibling row above it).`);
  }
  if (typeof probe.timeBottom === 'number' && typeof probe.bubbleTop === 'number') {
    if (probe.timeBottom > probe.bubbleTop + 1) {
      failures.push(`${label}: the <time> row's own bottom (${probe.timeBottom}) is BELOW the bubble's top (${probe.bubbleTop}) -- not rendered above the bubble`);
    } else {
      findings.push(`${label}: the <time> row sits visually above the bubble (time bottom ${probe.timeBottom} <= bubble top ${probe.bubbleTop}).`);
    }
  }
  if (expectWrapperMargin) {
    if (!probe.wrapperClassName || !new RegExp(`\\b${expectWrapperMargin}\\b`).test(probe.wrapperClassName)) {
      failures.push(`${label}: expected the user-message wrapper to carry ${expectWrapperMargin}, got "${probe.wrapperClassName}"`);
    } else {
      findings.push(`${label}: the user-message wrapper carries ${expectWrapperMargin} -- Transcript rhythm's unchanged house margin, present above this human turn as it is above every non-first row.`);
    }
  }
}

main();
