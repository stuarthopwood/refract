#!/usr/bin/env node
// Quiet alert rows live check (#560) against the scratch Tauri debug build: the two alert rows, the
// Memory Triage dialog, and the Health Check dialog reached from the alert row. Names are read from
// the CDP Accessibility domain, never textContent. Reuses the frozen exe (REFRACT_560_FROZEN_EXE)
// unless HEAD moved or its hash differs, then rebuilds via `buildAndCopyExeFresh`.

import { mkdtempSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getFreePort,
  stopLauncher,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import {
  getActiveElementAccessibleName,
  pressTab,
  pressEscape,
  groupTriggerFinder,
  createSessionViaQuickCreate,
  openSettingsAndReturn
} from './verify-tauri-session-list-helpers.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  safeRmSync,
  citeScreenshots,
  clearKnownOutputFiles,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';
import {
  assert,
  buildOmpShim,
  resolveExe,
  launchBuiltExe,
  worktreesDirFor,
  connectCdp,
  addRepositoryDiag,
  pressRealEnter,
  axText,
  sampleWhileAlive,
  waitForSessionStatus,
  latestSessionIdAndName
} from './verify-tauri-560-helpers.mjs';
import {
  runFocusTheftRegressionTest,
  runTabWalkAndHealthCheckDialogTest,
  runSelfClearingRowFocusRegressionTest,
  runForcedStopFailureRegressionTests
} from './verify-tauri-560-gate2.mjs';

// Refuses to build without the shared CARGO_TARGET_DIR: a worktree-local target tree already filled the disk once (#946).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOT_DIR = process.env.REFRACT_560_SHOT_DIR || path.join(tmpdir(), 'refract-560-shots');

// Frozen-exe constants and `resolveExe` live in verify-tauri-560-helpers.mjs (600-line cap).

// Finders are JS expression strings evaluated in the renderer (text/role matching needs more than a CSS selector).
const PROFILE_NAME_BUTTON = `document.querySelector('[data-profile-name-button]')`;
const TRIAGE_BUTTON = `document.querySelector('[aria-label="Open memory triage"]')`;
const CHECK_BUTTON = `document.querySelector('[aria-label="Open Health check"]')`;
const DISMISS_MEMORY_BUTTON = `document.querySelector('[aria-label="Dismiss low memory alert"]')`;
const DISMISS_OMPVERSION_BUTTON = `document.querySelector('[aria-label="Dismiss unverified version alert"]')`;
// The row states no Session count: `warning.liveAgents` counts every non-stopped agent, not just
// the idle ones Triage lists, so a number would imply a match that isn't guaranteed.
const LOW_MEMORY_ROW_SPAN = `Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === 'Low memory')`;
const OMPVERSION_ROW_SPAN = `Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === 'omp 18.10.1: unverified version')`;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const ALERT_DIALOG = `document.querySelector('[role="alertdialog"]')`;
const DIALOG_TITLE = `document.querySelector('[data-slot="dialog-title"]')`;
const ALERT_DIALOG_TITLE = `document.querySelector('[data-slot="alert-dialog-title"]')`;
const HEALTH_LIST = `document.querySelector('[aria-label="Health checks"]')`;
const OMP_CHECK_ROW = `Array.from((${HEALTH_LIST})?.querySelectorAll('li') ?? []).find((li) => li.textContent.includes('OMP found'))`;
// App-level `useChatAreaAnnouncer` region (App.tsx's single global aria-live), distinct from dialog-local live regions.
const CHAT_AREA_ANNOUNCE_REGION = `document.querySelector('[aria-live="polite"]')`;


async function runChecks(cdp, evidenceDir, log, { repoDir, repoName }) {
  const notExercised = [];

  // Count `stopAgent` calls: the busy-guard check needs to show a second Enter doesn't reach the
  // IPC. The fake-omp debug log records only child argv per spawn, so it can't answer this.
  await cdp.evaluate(`(() => { window.__stopAgentCallCount = 0; const orig = window.refract.sessions.stopAgent.bind(window.refract.sessions); window.refract.sessions.stopAgent = (...args) => { window.__stopAgentCallCount++; return orig(...args); }; })()`);

  // ---- Setup ----
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepositoryDiag(cdp, repoDir, evidenceDir, log);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository group rendered' });
  log('STEP PASS: readiness green, scratch repository added.');

  await createSessionViaQuickCreate(cdp, repoName);
  const sessionA = await latestSessionIdAndName(cdp, repoName, []);
  await waitForSessionStatus(cdp, sessionA.id, 'idle');
  log(`STEP PASS: Session "${sessionA.name}" (${sessionA.id}) created and reached idle.`);

  // ---- Both alert rows ----
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' !== undefined', { timeoutMs: 30_000, label: 'Low memory alert row appears (REFRACT_FORCE_LOW_MEMORY=1)' });
  const memoryRowName = await axText(cdp, LOW_MEMORY_ROW_SPAN);
  assert(memoryRowName === 'Low memory', `low-memory row's own accessible name must read exactly "Low memory" (got ${JSON.stringify(memoryRowName)})`);
  log(`STEP PASS: low-memory alert row present, accessible name ${JSON.stringify(memoryRowName)}.`);

  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' !== undefined', { timeoutMs: 30_000, label: 'Unverified omp version alert row appears' });
  const ompRowName = await axText(cdp, OMPVERSION_ROW_SPAN);
  assert(ompRowName === 'omp 18.10.1: unverified version', `omp-version row's own accessible name must be exactly "omp 18.10.1: unverified version" (got ${JSON.stringify(ompRowName)})`);
  log('STEP PASS: unverified-omp-version alert row present with the exact expected text, with zero extra setup beyond the normal fake-omp harness launch.');
  await cdp.screenshot(path.join(evidenceDir, '01-both-alert-rows.png'));

  // Runs first, before anything touches the rows' dismiss state, and restores it. Reports NOT
  // EXERCISED rather than throwing if window.__refractStores is unavailable in this build.
  await runSelfClearingRowFocusRegressionTest(cdp, { TRIAGE_BUTTON, CHECK_BUTTON, LOW_MEMORY_ROW_SPAN, OMPVERSION_ROW_SPAN }, log, notExercised);

  // Keyboard-only Tab walk and HealthCheckDialog open/close (verify-tauri-560-gate2.mjs); returns the
  // profile name button's accessible name for the later keyboard Dismiss fallback assertion.
  const nameButtonAx = await runTabWalkAndHealthCheckDialogTest(cdp, { PROFILE_NAME_BUTTON, DIALOG_TITLE, DIALOG, OMP_CHECK_ROW }, evidenceDir, log);

  // ---- Focus-theft regression (verify-tauri-560-gate2.mjs) ----
  await runFocusTheftRegressionTest(cdp, { TRIAGE_BUTTON, LOW_MEMORY_ROW_SPAN }, log);

  // ---- Memory Triage: per-row Stop with confirmation ----
  // The settle sleep is REQUIRED: a synthetic click right after the keyboard-only sequence is a
  // one-shot miss (a CDP input-timing race, not an app bug).
  await cdp.evaluate(`document.activeElement?.blur()`);
  await sleep(300);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog opened' });
  const sessionARow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionA.name)}))`;
  await cdp.waitFor(sessionARow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionA.name}" listed in Triage` });
  const sessionARowText = await cdp.evaluate(`(${sessionARow})?.textContent`);
  assert(sessionARowText.includes(repoName), `Session row must show its own repository name (got ${JSON.stringify(sessionARowText)})`);
  assert(/Idle (just now|\d+m)/.test(sessionARowText), `Session row must show "Idle <relative time>" (got ${JSON.stringify(sessionARowText)})`);
  log(`STEP PASS: Triage lists the idle Session with its repository and relative time: ${JSON.stringify(sessionARowText)}.`);

  await sleep(300); // same settle-sleep race guard as every other post-dialog-open click in this file
  await cdp.click(`(${sessionARow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionA.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'per-Session Stop confirmation opened' });
  log('STEP PASS: the Session\'s own Stop button opens a confirmation naming that exact Session.');

  // Escape closes the confirm without stopping; a second closes Triage and returns focus to its alert-row button.
  // The settle sleep before the first Escape is REQUIRED: right after the opening click it races the
  // AlertDialog's FocusScope/DismissableLayer setup and is lost.
  await sleep(300);
  await pressEscape(cdp);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'per-Session confirmation closed via Escape (no stop)' });
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage Dialog closed via a second Escape' });
  const postEscapeCancelActive = await getActiveElementAccessibleName(cdp);
  assert(
    postEscapeCancelActive.name === 'Open memory triage',
    `Escape-cancelling the per-Session confirm then the Dialog must return focus to "Open memory triage" (got ${JSON.stringify(postEscapeCancelActive)})`
  );
  await waitForSessionStatus(cdp, sessionA.id, 'idle');
  log('STEP PASS: Escape-cancelling the per-Session confirm never stops the Session, and a second Escape (a keyboard-only close of the Triage dialog) returns focus to the alert row\'s own Triage button -- F1\'s second half, unaffected by the blank-space-click fix above.');

  // Settle sleeps before each click are REQUIRED (WebView2/CDP input-timing race): the click right
  // after dialog churn is a one-shot miss.
  await cdp.evaluate(`document.activeElement?.blur()`);
  await sleep(300);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened' });
  await sleep(300);
  await cdp.click(`(${sessionARow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionA.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'per-Session Stop confirmation reopened' });

  const titleAtOpen = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  assert(
    titleAtOpen === `Stop ${sessionA.name}'s agent?`,
    `the per-Session confirm's own title immediately after opening must read exactly "Stop ${sessionA.name}'s agent?" (got ${JSON.stringify(titleAtOpen)})`
  );
  const singleStopActionExpr = `Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() !== 'Cancel')`;
  await cdp.evaluate(`(${singleStopActionExpr})?.focus()`);
  const titleBeforeClick = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  assert(
    titleBeforeClick === `Stop ${sessionA.name}'s agent?`,
    `the per-Session confirm's own title right before the destructive Stop click must still read exactly "Stop ${sessionA.name}'s agent?" (got ${JSON.stringify(titleBeforeClick)})`
  );
  log(`STEP PASS: the per-Session confirm's own title read the exact expected string at both sampled moments (open: ${JSON.stringify(titleAtOpen)}, pre-click: ${JSON.stringify(titleBeforeClick)}).`);
  await cdp.click(singleStopActionExpr);

  // The button text is read BEFORE the second Enter: if it isn't "Stopping…" (first call already
  // settled) the sub-check is recorded NOT EXERCISED, not falsely passed or failed.
  const stopButtonTextBeforeSecondEnter = await cdp.evaluate(`(${singleStopActionExpr})?.textContent.trim()`);
  if (stopButtonTextBeforeSecondEnter === 'Stopping…') {
    log('STEP PASS: the Stop button read "Stopping…" immediately before the second Enter, confirming the busy guard is actually being exercised.');
  } else {
    notExercised.push(
      `Item 5c busy-guard-text sub-check: the Stop button read ${JSON.stringify(stopButtonTextBeforeSecondEnter)}, not "Stopping…", at the moment this script sampled it (the first stopAgent call likely already settled before the sample) -- the busy-guard COUNT assertion below still ran, but this specific textual sub-check did not.`
    );
  }
  // Busy guard: a second Enter while the button reads "Stopping…" must not reach stopAgent again,
  // so it fires with no await for the first call to settle.
  await pressRealEnter(cdp);
  const singleTitleSamples = await sampleWhileAlive(cdp, `(${ALERT_DIALOG_TITLE})?.textContent.trim()`, `!!(${ALERT_DIALOG})`);
  assert(singleTitleSamples.length > 0, 'expected at least one title sample while the per-Session confirmation was still mounted and closing');
  assert(
    singleTitleSamples.every((text) => typeof text === 'string' && text.length > 0 && text !== 'undefined' && !/Stop (undefined|null)'s agent\?/.test(text)),
    `the per-Session confirmation's own title must never go blank/undefined during the close animation -- the last-known target name must stay latched (got samples ${JSON.stringify(singleTitleSamples)})`
  );
  log(`STEP PASS: the per-Session confirmation's own title stayed real and non-blank through every sampled frame of the close animation (${singleTitleSamples.length} samples: ${JSON.stringify(singleTitleSamples)}).`);
  await waitForSessionStatus(cdp, sessionA.id, 'stopped');
  await cdp.waitFor(sessionARow + ' === undefined', { timeoutMs: 10_000, label: `Session "${sessionA.name}" no longer listed as idle` });
  const emptyAfterSingleStop = await cdp.evaluate(`(${DIALOG})?.textContent.includes('No idle agents to stop right now.')`);
  assert(emptyAfterSingleStop === true, 'Triage must fall back to the empty-state copy once its only idle Session is stopped');
  const stopAgentCallsAfterSingleStop = await cdp.evaluate('window.__stopAgentCallCount');
  assert(stopAgentCallsAfterSingleStop === 1, `a second real Enter keypress on an already-"Stopping…" Stop button must not fire a second stopAgent IPC call (got ${stopAgentCallsAfterSingleStop} calls)`);
  log('STEP PASS: the busy guard held -- exactly one real stopAgent call reached the IPC bridge despite a second real Enter keypress while "Stopping…".');
  const postStopActive = await getActiveElementAccessibleName(cdp);
  assert(
    postStopActive.role === 'button' && postStopActive.name === 'Done',
    `focus after a successful single Stop must land on a genuine, named, connected control, never <body> -- with no idle Sessions remaining (this Session was the only one) and "Stop idle" also gone, focusAfterStop()'s own documented fallback order (gate round 3, L3) lands on the always-present Done button before the dialog's own heading; got role=${JSON.stringify(postStopActive.role)} name=${JSON.stringify(postStopActive.name)}`
  );
  log(`STEP PASS: confirming Stop actually stopped the agent (sessions.list() status now 'stopped'), the row is gone, the dialog shows the empty-state copy, and focus landed on a real connected control: the Done button (role=${JSON.stringify(postStopActive.role)} name=${JSON.stringify(postStopActive.name)}), never <body>.`);
  await cdp.screenshot(path.join(evidenceDir, '03-triage-dialog-after-stop-A.png'));
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape' });

  // ---- Bulk "Stop idle" with a second idle Session ----
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
  assert(sessionB.id !== sessionA.id, 'the second quick-create must produce a genuinely new Session id');
  await waitForSessionStatus(cdp, sessionB.id, 'idle');
  log(`STEP PASS: second Session "${sessionB.name}" (${sessionB.id}) created and reached idle.`);

  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened' });
  const sessionBRow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionB.name)}))`;
  await cdp.waitFor(sessionBRow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionB.name}" listed in Triage` });
  const stillHasSessionA = await cdp.evaluate(`(${DIALOG})?.textContent.includes(${JSON.stringify(sessionA.name)})`);
  assert(stillHasSessionA === false, `the already-stopped Session "${sessionA.name}" must never reappear (status filter is by construction, not a one-time snapshot)`);
  await sleep(300); // same settle-sleep race guard as every other post-dialog-open click in this file
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  const bulkTitle = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  // A bulk confirm targeting one Session reuses the single-stop wording, not "Stop 1 idle agent?".
  assert(bulkTitle === `Stop ${sessionB.name}'s agent?`, `a bulk confirmation targeting exactly one Session must reuse the single-stop wording (got ${JSON.stringify(bulkTitle)})`);
  const ALERT_DIALOG_DESCRIPTION = `document.querySelector('[data-slot="alert-dialog-description"]')`;
  const bulkDescription = await cdp.evaluate(`(${ALERT_DIALOG_DESCRIPTION})?.textContent.trim()`);
  assert(
    (bulkDescription ?? '').includes(sessionB.name),
    `the bulk confirmation's own description must NAME the Session(s) being stopped, not just the count (got ${JSON.stringify(bulkDescription)})`
  );
  log('STEP PASS: "Stop idle" confirms with the real, current idle count, and its description names the Session(s) being stopped.');

  // Same Escape sequence as above; the settle sleep before the first Escape is REQUIRED (the
  // keydown right after the confirm opens intermittently races its FocusScope setup and is lost).
  await sleep(300);
  await pressEscape(cdp);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk confirmation closed via Escape (no stop)' });
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage Dialog closed via a second Escape' });
  const postBulkEscapeActive = await getActiveElementAccessibleName(cdp);
  assert(
    postBulkEscapeActive.name === 'Open memory triage',
    `Escape-cancelling the bulk confirm then the Dialog must return focus to "Open memory triage" (got ${JSON.stringify(postBulkEscapeActive)})`
  );
  await waitForSessionStatus(cdp, sessionB.id, 'idle');
  log('STEP PASS: Escape-cancelling the bulk confirm never stops any Session, and a second Escape returns focus to the alert row\'s own Triage button.');

  // Same settle-sleep guard as above.
  await cdp.evaluate(`document.activeElement?.blur()`);
  await sleep(300);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened for the real bulk stop' });
  await sleep(300);
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionB.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'bulk confirmation reopened' });
  // Settle-sleep race guard on the destructive "Stop" click (confirmed live, run 4/7: lost silently).
  await sleep(300);
  await cdp.click(`Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Stop')`);
  await waitForSessionStatus(cdp, sessionB.id, 'stopped');
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk confirmation closed after Stop idle' });
  await cdp.waitFor(`(${DIALOG})?.textContent.includes('No idle agents to stop right now.')`, { timeoutMs: 10_000, label: 'Triage falls back to empty state after bulk stop' });
  log('STEP PASS: bulk "Stop idle" stopped every listed Session and the dialog now shows the empty-state copy.');
  await cdp.screenshot(path.join(evidenceDir, '04-triage-dialog-empty-after-bulk-stop.png'));
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape' });

  // ---- Focus-theft / dismiss regressions (verify-tauri-560-gate2.mjs) ----
  await runForcedStopFailureRegressionTests(
    cdp,
    { repoName, sessionA, sessionB, evidenceDir, DIALOG_TITLE, ALERT_DIALOG_TITLE, ALERT_DIALOG, DIALOG, TRIAGE_BUTTON, CHAT_AREA_ANNOUNCE_REGION },
    log
  );

  // ---- Dismissing the low-memory row is immediate and local-only (survives a second sampler tick,
  // though REFRACT_FORCE_LOW_MEMORY=1 stays true) ----
  await cdp.click(DISMISS_MEMORY_BUTTON);
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' === undefined', { timeoutMs: 5_000, label: 'low-memory row removed immediately on Dismiss' });
  assert((await cdp.evaluate(OMPVERSION_ROW_SPAN + ' !== undefined')) === true, 'dismissing the low-memory row must not affect the unrelated omp-version row');
  log('STEP PASS: dismissing the low-memory row hides it immediately without touching the other row.');
  await sleep(7_000); // longer than memory.rs's own 5s SAMPLE_INTERVAL_MS -- at least one more real sample tick
  assert((await cdp.evaluate(LOW_MEMORY_ROW_SPAN + ' === undefined')) === true, 'the low-memory row must NOT reappear on its own after a further sampler tick -- dismissal is local React state, never re-derived from the store');
  log('STEP PASS: the dismissed low-memory row did not return after a further real sampler tick, confirming dismissal is local-only state, not read back from the store.');

  // ---- Dismissing the unverified-version row via Tab + Enter: with the low-memory row gone, Tab order
  // from the profile name button is Settings -> Check -> Dismiss. ----
  await cdp.evaluate(`(() => { const el = ${PROFILE_NAME_BUTTON}; el?.focus(); return !!el; })()`);
  await pressTab(cdp);
  await pressTab(cdp);
  await pressTab(cdp);
  const preKeyboardDismissActive = await getActiveElementAccessibleName(cdp);
  assert(
    preKeyboardDismissActive.name === 'Dismiss unverified version alert',
    `real Tab order (Name -> Settings -> Check -> Dismiss) must land on the omp-version Dismiss button (got ${JSON.stringify(preKeyboardDismissActive)})`
  );
  await pressRealEnter(cdp);
  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' === undefined', { timeoutMs: 5_000, label: 'omp-version row removed immediately on keyboard-driven Dismiss' });
  // Asserts the exact fallback (`focusProfileItemName()`) right after the keypress and again ~1s
  // later: a later cleanup stealing focus to another named control would pass a looser check.
  const postKeyboardDismissActive = await getActiveElementAccessibleName(cdp);
  assert(
    postKeyboardDismissActive.role === 'button' && postKeyboardDismissActive.name === nameButtonAx.name,
    `after a keyboard-driven Dismiss (Tab + Enter) of the last remaining row, focus must land EXACTLY on the profile item's own name button (role=button name=${JSON.stringify(nameButtonAx.name)}), never <body> or any other control (got ${JSON.stringify(postKeyboardDismissActive)})`
  );
  await sleep(1_000);
  const postKeyboardDismissActiveLater = await getActiveElementAccessibleName(cdp);
  assert(
    postKeyboardDismissActiveLater.role === 'button' && postKeyboardDismissActiveLater.name === nameButtonAx.name,
    `focus on the profile item's own name button must still hold about a second later, not get stolen back by a delayed cleanup (got ${JSON.stringify(postKeyboardDismissActiveLater)})`
  );
  log(`STEP PASS: dismissing the unverified-version row via Tab + Enter hides it immediately and leaves focus EXACTLY on the profile item's own name button (${JSON.stringify(nameButtonAx.name)}), confirmed both immediately and ~1s later.`);
  await cdp.screenshot(path.join(evidenceDir, '05-both-rows-dismissed.png'));

  // ---- A Settings round trip must not resurrect or re-announce a dismissed row ----
  const announceTextBeforeRoundTrip = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  await openSettingsAndReturn(cdp);
  await sleep(500); // lets any stray re-announce effect actually commit before sampling
  const announceTextAfterRoundTrip = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  assert(
    (await cdp.evaluate(LOW_MEMORY_ROW_SPAN + ' === undefined')) === true && (await cdp.evaluate(OMPVERSION_ROW_SPAN + ' === undefined')) === true,
    'both previously-dismissed rows must stay dismissed after a Settings round trip'
  );
  assert(
    announceTextAfterRoundTrip === announceTextBeforeRoundTrip,
    `the chat-area announcement region's own text must NOT change (re-announce either alert) after a Settings round trip over an already-dismissed row (before ${JSON.stringify(announceTextBeforeRoundTrip)}, after ${JSON.stringify(announceTextAfterRoundTrip)})`
  );
  log('STEP PASS: a Settings round trip leaves both dismissed rows dismissed and never re-announces them.');

  if (notExercised.length > 0) {
    for (const item of notExercised) log(`NOT EXERCISED: ${item}`);
  }
  return { notExercised };
}

async function main() {
  clearKnownOutputFiles(SHOT_DIR, 'refract-560-', [
    '01-both-alert-rows.png', '02-health-check-dialog-warning.png', '03-triage-dialog-after-stop-A.png',
    '04-triage-dialog-empty-after-bulk-stop.png', '05-both-rows-dismissed.png', '06-forced-stop-failure-still-listed.png',
    '99-diag-add-repository-failure.png', 'report.json', 'report.txt', 'app.log', 'fake-omp-invocations.log'
  ]);
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  let shimDir, dataDir, importSourceDir, repoDir, exeDir;
  let child, cdp;
  let exitCode = 0;
  let notExercised = [];

  const realRegistryPath = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realRegistryStatBefore = existsSync(realRegistryPath) ? statSync(realRegistryPath) : null;

  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-560-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-560-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-560-import-src-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-560-repo-')), 'refract-560-repo');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-560-exe-'));

    log(`verify-tauri-560: data dir ${dataDir}`);
    log(`verify-tauri-560: evidence dir ${SHOT_DIR}`);
    log(`verify-tauri-560: Project ${repoDir} (name "${repoName}")`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash, buildTime: exeBuildTime, gitHeadValue, rebuilt } = resolveExe(exeDir, REPO_ROOT, BUILD_OUTPUT_DIR);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOT_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOT_DIR, 'fake-omp-invocations.log'),
        REFRACT_FORCE_LOW_MEMORY: '1'
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);
    assertExeMatchesProcess(launched.targetPid, exePath, exeHash);
    log(`verify-tauri-560: launched, pid ${launched.targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path), rebuilt=${rebuilt}`);

    const result = await runChecks(cdp, SHOT_DIR, log, { repoDir, repoName });
    notExercised = result.notExercised;

    // The scratch REFRACT_DATA_DIR took effect: its registry.json exists (RegistryStore::open only
    // creates it on first write, so check after runChecks) and the real %APPDATA% profile was untouched.
    const scratchRegistryPath = path.join(dataDir, 'registry.json');
    assert(existsSync(scratchRegistryPath), `the scratch REFRACT_DATA_DIR must have its own registry.json (got none at ${scratchRegistryPath}) -- the override may not have taken effect`);
    log(`verify-tauri-560: isolation confirmed -- scratch data dir has its own registry.json at ${scratchRegistryPath}.`);

    const realRegistryStatAfter = existsSync(realRegistryPath) ? statSync(realRegistryPath) : null;
    const realProfileUntouched =
      (realRegistryStatBefore === null) === (realRegistryStatAfter === null) &&
      (realRegistryStatBefore === null || realRegistryStatBefore.mtimeMs === realRegistryStatAfter.mtimeMs);
    assert(realProfileUntouched, `Stuart's real %APPDATA%\\refract-tauri\\registry.json must be untouched by this run (before ${JSON.stringify(realRegistryStatBefore?.mtimeMs)}, after ${JSON.stringify(realRegistryStatAfter?.mtimeMs)})`);
    log('verify-tauri-560: confirmed the real %APPDATA%\\refract-tauri\\registry.json mtime is unchanged by this run.');

    log(`verify-tauri-560: ALL PASS. Evidence and screenshots: ${SHOT_DIR}`);
    const screenshots = citeScreenshots(SHOT_DIR, [
      '01-both-alert-rows.png', '02-health-check-dialog-warning.png', '03-triage-dialog-after-stop-A.png',
      '04-triage-dialog-empty-after-bulk-stop.png', '05-both-rows-dismissed.png', '06-forced-stop-failure-still-listed.png'
    ]);
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        {
          gitHead: gitHeadValue,
          exitCode: 0,
          frozenExe: { path: exePath, sha256AtRunTime: exeHash, buildTime: exeBuildTime, rebuilt },
          notExercised,
          screenshots,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  } catch (err) {
    exitCode = 1;
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        {
          gitHead: gitHead(REPO_ROOT),
          exitCode: 1,
          error: String(err?.message ?? err),
          notExercised,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    // Deliberately NOT removing SHOT_DIR: its report and screenshots are this run's audit trail.
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error('verify-tauri-560: FAIL');
  console.error(err);
  process.exitCode = 1;
});
