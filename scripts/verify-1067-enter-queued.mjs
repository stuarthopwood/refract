#!/usr/bin/env node
// Live CDP check for issue #1067 (Enter sends the oldest queued follow-up on a blank composer,
// FR-094, spec 001 Phase 73). Modelled on `verify-997-notice-severity.mjs` (single launch,
// fake-omp tape, report.json pattern) and on the queued-chip domain `verify-985-queued-refresh.mjs`
// and `queuedChips.ts`/`MessageInput.tsx` already cover; the #540 queued-message story itself
// predates this repo's live-CDP convention (PR #591/#598 shipped with unit tests only), so there
// is no older #540 `.mjs` script to port forward -- `scripts/fixtures/omp-frames/README.md`'s own
// provenance row for the new `1067-enter-queued.jsonl` tape explains what it hand-writes and why.
//
// Covers, in order: (1) queue two follow-ups mid-turn, chips render oldest-first; (2) the
// composer hint and `aria-describedby` read "Enter sends the next queued message" while the rule
// applies, in two themes, plus one 360px-wide screenshot proving the hint fits without
// overflowing; (3) an attachment-only "blank" composer (text === '', a real pending file
// attachment, follow-up queued) does NOT promote the queued follow-up on Enter, and the hint
// stays the DEFAULT "Message the agent" wording (gate round 1, Code1/Test1 HIGH: live-exercised,
// not merely reasoned about); (4) Enter on the blank composer sends the OLDEST queued follow-up
// (same wire call "Send now" uses, `promote_queued_message`), a repeat Enter sends the next one;
// (5) once both are promoted (steering-only, no follow-up left), Enter on the blank composer is a
// genuine no-op (no new command reaches the fake omp at all) -- with the composer's own focus
// confirmed first, so a silently-unfocused textarea could never pass this step by accident; (6) a
// third follow-up is queued, then Enter WITH TYPED TEXT still sends that typed text as an
// ordinary follow-up (not a steer), even though a follow-up is sitting in the queue; (7) opening
// the slash menu on an unmatched command and pressing Enter sends no command at all -- this is
// the composer's ordinary unknown-command refusal, NOT a live test of FR-094's own slash-menu
// guard (see `notExercised` below for why that combination cannot be reached); (8) a fast double
// Enter against the same oldest chip steers it exactly once (the fixture's own 900ms `__delay__`
// before its ack keeps `inFlightChips` busy long enough for the second Enter to land inside that
// window, proven by an exact fake-omp debug-log line count, not merely by watching the UI), and
// the "Sending now…" announcement itself is asserted (not merely waited for); (9) Shift+Enter
// inserts a newline and sends nothing.
//
// Not exercised live (documented, not fabricated): a ghost-text suggestion showing at the same
// moment the composer is blank -- `isGhostTextEligible` requires text already on the line, so
// this combination cannot occur in the shipped build at all (the guard in
// `enterSendsQueuedFollowUp.ts` is defensive only); the slash menu open AND the composer
// otherwise blank at the same time -- `showSlashMenu` requires `text` to start with `/`, so text
// can never simultaneously be the empty string FR-094 requires; an IME composition in progress
// at the same moment the composer is blank -- CDP has no native IME composition-event API, and a
// composing draft is, by definition, non-empty text on the line, so this is structurally
// unreachable for the same reason the slash-menu and ghost-text guards are.
//
// Every screenshot is preceded by `settleForScreenshot` (move the pointer inside the viewport,
// blur, press Escape, fail if a tooltip or hover card is still open) -- same hygiene rule every
// other script in this repo follows.

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1067';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1067_SHOTS_DIR || path.join(tmpdir(), 'refract-1067-enter-queued-shots');
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Screenshot hygiene: move the pointer to a neutral point inside the viewport, blur, press
 * Escape, then fail loudly if a tooltip or hover card is still open -- same pattern every other
 * verify-*.mjs script in this repo follows (e.g. `verify-700-todo-pin-helpers.mjs`). */
async function settleForScreenshot(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 450 });
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(
    `!document.querySelector('[role="tooltip"]') && !document.querySelector('[data-slot="tooltip-content"]') && !document.querySelector('[data-slot="hover-card-content"]')`,
    { timeoutMs: 3_000, label: 'stray tooltip/hover card closed before screenshot' }
  );
}

async function pressShiftEnter(cdp) {
  // `text`/`unmodifiedText` (same fields `CdpSession.pressEnter` sets) are what makes Chromium
  // treat this as a real keystroke that inserts a character -- a bare keyDown/keyUp pair with
  // no `text` reaches the textarea's own `onKeyDown` but inserts nothing, since the component
  // deliberately never calls `preventDefault` for Shift+Enter (it relies on the browser's own
  // native "Enter inserts a newline in a textarea" behaviour, same as a real keystroke would).
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Reads the composer's own queued-message chips in render order: display text, which queue it
 * belongs to (a follow-up chip always renders a "Send now" button; a steering chip renders the
 * quiet "Sending at the next step" label instead, never both). */
function readChips(cdp) {
  return cdp.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('ul[aria-label="Queued messages"] > li'));
    return items.map((li) => {
      const text = li.querySelector('span.truncate')?.textContent ?? null;
      const sendBtn = li.querySelector('[data-chip-action="send"]');
      const steeringLabel = li.querySelector('span.text-muted-foreground');
      return {
        text,
        queue: sendBtn ? 'followUp' : (steeringLabel ? 'steering' : 'unknown'),
        sendBusy: sendBtn ? sendBtn.getAttribute('aria-busy') === 'true' : null
      };
    });
  })()`);
}

/** The composer's own hint while blank: a genuinely VISIBLE span whose exact trimmed text
 * matches `expectedText` (not inside any `.sr-only` ancestor, which carries the same text for
 * screen readers via a separate element -- `closest` tells the two apart without depending on
 * the hint overlay's own class list, which could drift independently of this check), plus every
 * id the textarea's `aria-describedby` names and each one's own sr-only text -- the real
 * screen-reader-reachable path issue #533 established. */
function readHint(cdp, expectedText) {
  return cdp.evaluate(`(() => {
    const textarea = document.querySelector('[aria-label="Message"]');
    const describedBy = (textarea?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    const describedByText = describedBy.map((id) => (document.getElementById(id)?.textContent ?? null)).filter((t) => t !== null && t !== '');
    const visibleMatch = Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === ${JSON.stringify(expectedText)} && !el.closest('.sr-only'));
    const visibleLead = visibleMatch ? visibleMatch.textContent.trim() : null;
    return { describedBy, describedByText, visibleLead, value: textarea?.value ?? null };
  })()`);
}

function debugLogContent(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function countRecvLinesContaining(content, needle) {
  return content.split('\n').filter((line) => line.includes('RECV') && line.includes(needle)).length;
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1067-enter-queued-shots', [...THEMES.map((t) => `hint-${t.id}.png`), 'hint-360px.png', 'attachment-only.png', 'report.json']);

  const report = [];
  const notExercised = [
    'A ghost-text suggestion showing at the same instant the composer is blank: structurally unreachable (isGhostTextEligible requires text already on the line), guarded defensively only.',
    'The slash menu open at the same instant the composer is otherwise blank (FR-094\'s own slash-menu guard): structurally unreachable -- showSlashMenu requires text to start with \'/\', so text can never simultaneously be the empty string FR-094 requires. The step below that opens the slash menu and presses Enter exercises the composer\'s ordinary unknown-command refusal instead (a real, separate behaviour), not this guard.',
    'An IME composition in progress at the same instant the composer is blank: CDP has no native IME composition-event API to dispatch, and a composing draft is non-empty text on the line by definition, so this combination is structurally unreachable for the same reason the slash-menu and ghost-text guards are.'
  ];

  function assertEqual(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertTrue(actual, label, extra) {
    const ok = actual === true;
    report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1067-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1067-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1067-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1067-enter-queued');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1067-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1067-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1067-shim-'));
  const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: '1067-enter-queued'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    // Real UI flow (mirrors verify-997-notice-severity.mjs): readiness, Add repository, New
    // session, wait for the composer against the fake omp's scripted tape.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });

    // Starts the fixture's one never-settling turn, so the Session stays `working` for the rest
    // of this script (every later `prompt` genuinely queues; `promote_queued_message` genuinely
    // steers instead of erroring not-idle).
    await cdp.typeIntoByLabel('Message', 'Start the long task (issue #1067 live check)');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.querySelectorAll('[data-slot="message"]').length > 0`, { timeoutMs: 30_000, label: 'Turn started' });

    // (1) Queue two follow-ups mid-turn; chips render oldest-first.
    await cdp.typeIntoByLabel('Message', 'First queued message');
    await cdp.pressEnter();
    await cdp.waitFor(`document.querySelectorAll('ul[aria-label="Queued messages"] > li').length === 1`, { timeoutMs: 15_000, label: 'First follow-up queued' });
    await cdp.typeIntoByLabel('Message', 'Second queued message');
    await cdp.pressEnter();
    await cdp.waitFor(`document.querySelectorAll('ul[aria-label="Queued messages"] > li').length === 2`, { timeoutMs: 15_000, label: 'Second follow-up queued' });
    const afterQueueTwo = await readChips(cdp);
    assertEqual(
      afterQueueTwo.map((c) => [c.text, c.queue]),
      [['First queued message', 'followUp'], ['Second queued message', 'followUp']],
      'two follow-ups queued, oldest (First queued message) listed first'
    );

    // (2) Composer is now blank (both sends cleared the draft) with a follow-up queued: the
    // hint and aria-describedby read "Enter sends the next queued message", in two themes.
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]').value === ''`, { timeoutMs: 5_000, label: 'Composer cleared after queueing' });
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const hint = await readHint(cdp, 'Enter sends the next queued message');
      assertEqual(hint.visibleLead, 'Enter sends the next queued message', `${theme.name}: visible hint reads "Enter sends the next queued message"`);
      // Round-1 item 5 fix: the sr-only text now reads "Enter sends the next queued message.
      // Markdown is supported. Type slash for commands." (the ordinary hint kept appended after
      // it), so this checks a SUBSTRING match across the describedByText entries, not exact
      // array-element equality (`Array.includes` on a full string never matches a substring).
      assertTrue(hint.describedByText.some((t) => t.includes('Enter sends the next queued message')), `${theme.name}: aria-describedby includes the hint text`, hint);
      await settleForScreenshot(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, `hint-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');
    // `settleForScreenshot` blurs the active element and `switchTheme` leaves focus inside the
    // profile menu's own trigger -- a bare `pressEnter()` dispatches to whatever (if anything)
    // currently has focus, never to the textarea by selector, so every later bare Enter in this
    // script would otherwise land nowhere. Re-click the composer once here; every later step
    // that types first (`typeIntoByLabel`) already refocuses it via its own click.

    // 360px-wide screenshot (gate round 1 LOW item): the hint must fit without triggering
    // horizontal overflow at the narrowest width this app supports -- same
    // `Emulation.setDeviceMetricsOverride` technique every other narrow-width check in this repo
    // uses (CDP has no OS window-resize control; this is a genuine viewport override, not a
    // guess). Dark only: the two-theme contrast comparison already happened above.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    assertEqual(narrowOverflow, false, 'at 360px width: the queued-follow-up hint does not cause horizontal overflow');
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'hint-360px.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    await sleep(300);
    // Re-click the composer: `clearDeviceMetricsOverride` repaints the page, same focus-loss
    // risk `settleForScreenshot`'s own blur left above.
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);

    // (3) HIGH gate round 1 fix (Code1/Test1): an attachment-only "blank" composer -- text ===
    // '', a REAL pending file attachment, a follow-up still queued -- must NOT promote the
    // queued follow-up on Enter, and the hint must stay the DEFAULT "Message the agent" wording,
    // not the queued-follow-up one. Live-exercised via a synthetic clipboard paste carrying a
    // real `File` (same technique `verify-926-attach-any-file.mjs` uses), not merely reasoned
    // about from `computeEnterSendsQueuedFollowUp`'s own `attachments.files.length === 0` guard.
    const beforeAttachmentOnly = debugLogContent(debugLogPath);
    await cdp.evaluate(
      `(() => {
        const file = new File(['hello'], 'attachment-only-1067.txt', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.querySelector('[aria-label="Message"]').dispatchEvent(ev);
        return true;
      })()`
    );
    await cdp.waitFor(
      `document.querySelectorAll('[role="group"][aria-label="Pending attachments"] [data-slot="badge"]').length === 1`,
      { timeoutMs: 10_000, label: 'Pasted file attached (attachment-only blank composer)' }
    );
    assertEqual(
      await cdp.evaluate(`document.querySelector('[aria-label="Message"]').value`),
      '',
      'attachment-only blank composer: the composer TEXT is still the empty string (the attachment, not typed text, is what makes this draft non-blank)'
    );
    const attachmentOnlyHint = await readHint(cdp, 'Message the agent');
    assertEqual(attachmentOnlyHint.visibleLead, 'Message the agent', 'attachment-only blank composer: the hint stays the DEFAULT wording, not "Enter sends the next queued message"');
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'attachment-only.png'));
    await cdp.pressEnter();
    await sleep(500);
    assertEqual(
      debugLogContent(debugLogPath),
      beforeAttachmentOnly,
      'attachment-only blank composer: Enter sends no command at all (no promote_queued_message over a real pending attachment)'
    );
    assertEqual(
      (await readChips(cdp)).map((c) => [c.text, c.queue]),
      [['First queued message', 'followUp'], ['Second queued message', 'followUp']],
      'attachment-only blank composer: both follow-ups are still queued, untouched'
    );
    // Clean-up: remove the pasted attachment so the Enter-promotes-the-queue steps below see an
    // actually blank composer again, same selector `verify-926-attach-any-file.mjs` uses.
    await cdp.click(`document.querySelector('[role="group"][aria-label="Pending attachments"] button[aria-label^="Remove"]')`);
    await cdp.waitFor(
      `document.querySelectorAll('[role="group"][aria-label="Pending attachments"] [data-slot="badge"]').length === 0`,
      { timeoutMs: 5_000, label: 'Pasted attachment removed, attachment-only check cleaned up' }
    );
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);

    // (4) Enter on the blank composer sends the OLDEST queued follow-up via the same wire call
    // "Send now" uses; a repeat Enter sends the next one. (The "Sending now…" announcement
    // itself is asserted in step (8) below, where the fixture's own 900ms ack delay gives a
    // non-racy window to observe it -- this first promote's ack is immediate, so polling for
    // that transient text here could flip to the post-success announcement before a poll ever
    // caught it.)
    await cdp.pressEnter();
    await cdp.waitFor(
      `(() => { const li = document.querySelectorAll('ul[aria-label="Queued messages"] > li'); return li.length === 2 && li[0].querySelector('span.truncate')?.textContent === 'Second queued message'; })()`,
      { timeoutMs: 15_000, label: 'Oldest follow-up (First queued message) promoted to steering' }
    );
    assertEqual(
      (await readChips(cdp)).map((c) => [c.text, c.queue]),
      [['Second queued message', 'followUp'], ['First queued message', 'steering']],
      'after one Enter: Second queued message is the only follow-up, First queued message now steering'
    );
    await cdp.pressEnter();
    await cdp.waitFor(
      `(() => { const li = document.querySelectorAll('ul[aria-label="Queued messages"] > li'); return li.length === 2 && Array.from(li).every((el) => el.querySelector('[data-chip-action="send"]') === null); })()`,
      { timeoutMs: 15_000, label: 'Repeat Enter promoted the next follow-up (Second queued message); no follow-up chip remains' }
    );
    assertEqual(
      (await readChips(cdp)).map((c) => c.queue),
      ['steering', 'steering'],
      'after a repeat Enter: both chips are now steering, none a follow-up'
    );

    // (5) Steering-only: Enter on the blank composer is a genuine no-op -- nothing reaches the
    // fake omp at all (exact debug-log byte-for-byte equality, not merely "the UI looks idle").
    // The composer's own FOCUS is confirmed first (round-1 LOW item): a bare `pressEnter()`
    // dispatches to whatever currently has focus, so an unfocused textarea would make this step
    // pass for the wrong reason (Enter landing nowhere at all, not the rule's own no-op path).
    assertEqual(
      await cdp.evaluate(`document.activeElement === document.querySelector('[aria-label="Message"]')`),
      true,
      'before the steering-only no-op check: the composer textarea itself has focus'
    );
    const beforeNoop = debugLogContent(debugLogPath);
    await cdp.pressEnter();
    await sleep(600);
    const afterNoop = debugLogContent(debugLogPath);
    assertEqual(afterNoop, beforeNoop, 'steering-only queued: Enter on the blank composer sends no command at all (debug log unchanged)');

    // (6) Queue a third follow-up, then Enter WITH TYPED TEXT still sends that typed text as an
    // ordinary follow-up (not a steer), even though a follow-up is queued and available.
    await cdp.typeIntoByLabel('Message', 'Third queued message');
    await cdp.pressEnter();
    await cdp.waitFor(
      `(() => { const li = document.querySelectorAll('ul[aria-label="Queued messages"] > li'); return li.length === 3 && li[0].querySelector('span.truncate')?.textContent === 'Third queued message'; })()`,
      { timeoutMs: 15_000, label: 'Third follow-up queued' }
    );
    const beforeTypedText = debugLogContent(debugLogPath);
    await cdp.typeIntoByLabel('Message', 'Explicit typed text');
    await cdp.pressEnter();
    await cdp.waitFor(
      `(() => { const li = document.querySelectorAll('ul[aria-label="Queued messages"] > li'); return li.length === 4; })()`,
      { timeoutMs: 15_000, label: 'Enter with typed text queued that text too (4 chips total)' }
    );
    const afterTypedTextLog = debugLogContent(debugLogPath);
    assertTrue(
      countRecvLinesContaining(afterTypedTextLog, '"type":"prompt"') > countRecvLinesContaining(beforeTypedText, '"type":"prompt"'),
      'Enter with typed text sent a prompt command, not a promote_queued_message'
    );
    assertEqual(
      countRecvLinesContaining(afterTypedTextLog, '"type":"promote_queued_message"'),
      countRecvLinesContaining(beforeTypedText, '"type":"promote_queued_message"'),
      'Enter with typed text sent no new promote_queued_message command'
    );

    // (7) Opening the slash menu on an unmatched command and pressing Enter sends no command at
    // all. NOT a live test of FR-094's own slash-menu guard -- see `notExercised` above for why
    // that specific combination (slash menu open AND composer otherwise blank) is structurally
    // unreachable. This exercises the composer's ordinary, separate "unknown command" refusal
    // instead; kept because it is the honest, real behaviour this script can actually reach, not
    // a claim about the FR-094 guard.
    const beforeSlash = debugLogContent(debugLogPath);
    await cdp.typeIntoByLabel('Message', '/zzz1067notarealcommand');
    await cdp.waitFor(`!!document.querySelector('ul[role="listbox"]') || !!document.querySelector('[aria-hidden="true"].bg-popover')`, { timeoutMs: 5_000, label: 'Slash menu open (unmatched command)' });
    await cdp.pressEnter();
    await sleep(500);
    const afterSlash = debugLogContent(debugLogPath);
    assertEqual(afterSlash, beforeSlash, 'unknown slash command: Enter sends no command at all (refused locally, debug log unchanged; unrelated to FR-094\'s own guard)');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`!document.querySelector('ul[role="listbox"]') && !document.querySelector('[aria-hidden="true"].bg-popover')`, { timeoutMs: 5_000, label: 'Slash menu dismissed' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]').value === ''`, { timeoutMs: 5_000, label: 'Composer cleared after dismissing the slash draft' });

    // (8) A fast double Enter against the same oldest chip (Third queued message) steers it
    // exactly once. The fixture's own 900ms delay before its ack keeps the chip's own
    // `inFlightChips` busy long enough for the second Enter to land inside that window; proven
    // by an exact fake-omp debug-log RECV count, not merely by watching the UI settle.
    const beforeDouble = debugLogContent(debugLogPath);
    await cdp.pressEnter();
    await cdp.pressEnter();
    // Round-1 LOW item: the "Sending now…" announcement is RECORDED with assertTrue (so a
    // regression shows up as a reported FAIL, not a bare timeout), not merely waited for and
    // discarded -- polls for up to 2s, then asserts on whatever text was actually observed.
    let sendingNowText = '';
    const sendingNowDeadline = Date.now() + 2_000;
    while (Date.now() < sendingNowDeadline) {
      sendingNowText = await cdp.evaluate(`document.querySelector('[id$="-attachments-status"] span')?.textContent ?? ''`);
      if (sendingNowText === 'Sending now\u2026') break;
      await sleep(50);
    }
    assertTrue(sendingNowText === 'Sending now\u2026', 'Sending announces "Sending now…" while the promote is in flight', { observedText: sendingNowText });
    await cdp.waitFor(
      `(() => { const li = Array.from(document.querySelectorAll('ul[aria-label="Queued messages"] > li')); const target = li.find((el) => el.querySelector('span.truncate')?.textContent === 'Third queued message'); return li.length === 4 && target && target.querySelector('[data-chip-action="send"]') === null; })()`,
      { timeoutMs: 15_000, label: 'Fast double Enter settled: Third queued message is now steering' }
    );
    const afterDouble = debugLogContent(debugLogPath);
    assertEqual(
      countRecvLinesContaining(afterDouble, '"type":"promote_queued_message"') - countRecvLinesContaining(beforeDouble, '"type":"promote_queued_message"'),
      1,
      'fast double Enter sent exactly ONE promote_queued_message command (inFlightChips guard shared with the chip\'s own Send now button)'
    );

    // (9) Shift+Enter inserts a newline and sends nothing.
    const beforeShiftEnter = debugLogContent(debugLogPath);
    await cdp.typeIntoByLabel('Message', 'line one');
    await pressShiftEnter(cdp);
    await cdp.send('Input.insertText', { text: 'line two' });
    const shiftEnterValue = await cdp.evaluate(`document.querySelector('[aria-label="Message"]').value`);
    assertEqual(shiftEnterValue, 'line one\nline two', 'Shift+Enter inserted a newline into the composer');
    await sleep(400);
    assertEqual(debugLogContent(debugLogPath), beforeShiftEnter, 'Shift+Enter sent no command at all');

    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, [...THEMES.map((t) => `hint-${t.id}.png`), 'hint-360px.png', 'attachment-only.png']) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
