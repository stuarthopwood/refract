// Gate round 2 (F1/F2) regression tests for verify-tauri-560.mjs, split out solely to keep that
// file under the repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change
// from running this code inline. See verify-tauri-560.mjs's own header comment for what each
// proves; this module holds the two regression tests themselves, not the setup/plumbing they
// run inside (that stays in verify-tauri-560-helpers.mjs).
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { assert, waitForSessionStatus, latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { createSessionViaQuickCreate, getActiveElementAccessibleName, pressEscape } from './verify-tauri-session-list-helpers.mjs';

/** Gate round 2 F1 regression test: clicking blank space must NOT steal focus back onto an
 *  alert row. The round 1 focus-redirect fix treated `document.activeElement === document.body`
 *  alone as proof a row's focused descendant had been removed from the DOM, but an ordinary
 *  click on a non-focusable target (anywhere with no focusable element under the pointer) causes
 *  the IDENTICAL symptom without removing anything -- the bug redirected focus straight back
 *  onto an alert row's own control every time. Reproduced here with the most direct "blank space
 *  inside a row" target available: the low-memory row's own descriptive label `<span>`, which
 *  has no onClick and is not focusable, so a real click on it blurs whatever was focused without
 *  moving focus anywhere (ordinary browser behaviour) -- it must stay on <body>, never
 *  redirected to the OTHER row's "Check" button (the pre-fix `redirectFocusFrom('memory')`
 *  target, since the omp-version row is still shown at this point in the run). */
export async function runFocusTheftRegressionTest(cdp, { TRIAGE_BUTTON, LOW_MEMORY_ROW_SPAN }, log) {
  await cdp.evaluate(`(() => { const el = ${TRIAGE_BUTTON}; el?.focus(); return !!el; })()`);
  const preBlankClickActive = await getActiveElementAccessibleName(cdp);
  assert(
    preBlankClickActive.name === 'Open memory triage',
    `must have focused the Triage button before the blank-space click (got ${JSON.stringify(preBlankClickActive)})`
  );
  await cdp.click(LOW_MEMORY_ROW_SPAN);
  await sleep(300); // the focusout handler's own synchronous check plus this script's own CDP round trip
  const postBlankClickIsBody = await cdp.evaluate(`document.activeElement === document.body`);
  assert(
    postBlankClickIsBody === true,
    `clicking blank space inside the low-memory row (its own non-focusable label) must leave focus on <body> -- an ordinary blur -- never redirected back onto an alert row's own control (gate round 2 F1 regression; got activeElement tag ${await cdp.evaluate('document.activeElement?.tagName ?? null')})`
  );
  log('STEP PASS: clicking blank space inside the low-memory row leaves focus on <body> -- it is never stolen back onto an alert row\'s own action button (F1).');
}

/** Gate round 2 F2 regression tests: a failed Stop must be announced as a failure, never
 *  success, naming the failing Session(s) -- the exact bug the previous version of this fix had
 *  (`stopAgent` resolved `void` unconditionally, so a clean `{ok:false}` response was always
 *  announced as "Stopped"; in bulk, filtering on `status === 'rejected'` never matched a clean
 *  failure either, so a partly-failed bulk stop always reported every target as stopped).
 *
 *  Forced scratch-safely: `window.refract.sessions.stopAgent` (the exact boundary
 *  `sessions-store.ts` calls) is monkey-patched in the renderer to resolve `{ok:false}` for one
 *  specific Session id -- the same established technique verify-tauri-560.mjs's own
 *  `runChecks` already uses to count real calls, applied here to inject a controlled failure
 *  instead. NO process is touched (not the real backend, not any child process, let alone
 *  Stuart's own) -- the real IPC call for the targeted id is never even dispatched, which is
 *  both safer and more deterministic than killing a specific child process to induce the same
 *  symptom. Covers single AND bulk (mixed with genuinely-succeeding Sessions, proving the
 *  announced success COUNT and the failing Session's NAME are both truthful for a mixed
 *  outcome, not just an all-fail/all-succeed case). */
export async function runForcedStopFailureRegressionTests(
  cdp,
  { repoName, sessionA, sessionB, evidenceDir, DIALOG_TITLE, ALERT_DIALOG_TITLE, ALERT_DIALOG, DIALOG, TRIAGE_BUTTON, CHAT_AREA_ANNOUNCE_REGION },
  log
) {
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionC = await latestSessionIdAndName(cdp, repoName, [sessionA.id, sessionB.id]);
  await waitForSessionStatus(cdp, sessionC.id, 'idle');
  log(`STEP PASS: third Session "${sessionC.name}" (${sessionC.id}) created and reached idle, for the forced single-Stop-failure test.`);

  await cdp.evaluate(`(() => {
    window.__origStopAgent = window.refract.sessions.stopAgent.bind(window.refract.sessions);
    window.refract.sessions.stopAgent = (id) => {
      if (id === ${JSON.stringify(sessionC.id)}) {
        return Promise.resolve({ ok: false, error: { code: 'agent-not-running', message: 'Scratch-forced failure for the F2 regression test (no real process touched).' } });
      }
      return window.__origStopAgent(id);
    };
  })()`);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog opened for the forced single-failure test' });
  const sessionCRow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionC.name)}))`;
  await cdp.waitFor(sessionCRow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionC.name}" listed in Triage` });
  await cdp.click(`(${sessionCRow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionC.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'forced-failure Stop confirmation opened' });
  await cdp.click(`Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() !== 'Cancel')`);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'forced-failure confirm closed' });
  await sleep(300);
  const announceAfterForcedFailure = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  assert(
    announceAfterForcedFailure === `Couldn't stop ${sessionC.name}'s agent`,
    `a forced single Stop failure must be announced as a failure naming the Session, never as success (gate round 2 F2 regression; got ${JSON.stringify(announceAfterForcedFailure)})`
  );
  await cdp.waitFor(sessionCRow + ' !== undefined', { timeoutMs: 5_000, label: `Session "${sessionC.name}" must STILL be listed in Triage (the forced failure never actually stopped it)` });
  log(`STEP PASS: a forced single Stop failure is announced truthfully as ${JSON.stringify(announceAfterForcedFailure)} (never success), and the Session stays listed since it was never actually stopped (F2).`);

  // Bulk partial failure: two more idle Sessions, one forced to fail, one routed through the
  // REAL backend and genuinely stopped -- proves the announced success COUNT and the failing
  // Session's NAME are both truthful for a mixed outcome, not just an all-fail/all-succeed case.
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionD = await latestSessionIdAndName(cdp, repoName, [sessionA.id, sessionB.id, sessionC.id]);
  await waitForSessionStatus(cdp, sessionD.id, 'idle');
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionE = await latestSessionIdAndName(cdp, repoName, [sessionA.id, sessionB.id, sessionC.id, sessionD.id]);
  await waitForSessionStatus(cdp, sessionE.id, 'idle');
  log(`STEP PASS: two more idle Sessions "${sessionD.name}" and "${sessionE.name}" created, for the bulk partial-failure test.`);

  await cdp.evaluate(`(() => {
    window.refract.sessions.stopAgent = (id) => {
      if (id === ${JSON.stringify(sessionD.id)}) {
        return Promise.resolve({ ok: false, error: { code: 'agent-not-running', message: 'Scratch-forced failure for the bulk F2 regression test (no real process touched).' } });
      }
      return window.__origStopAgent(id);
    };
  })()`);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened for the bulk partial-failure test' });
  const sessionDRow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionD.name)}))`;
  const sessionERow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionE.name)}))`;
  await cdp.waitFor(sessionCRow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionC.name}" still listed in Triage` });
  await cdp.waitFor(sessionDRow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionD.name}" listed in Triage` });
  await cdp.waitFor(sessionERow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionE.name}" listed in Triage` });
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  await cdp.waitFor(`!!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk partial-failure confirmation opened' });
  await cdp.click(`Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Stop')`);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk partial-failure confirmation closed' });
  await sleep(300);
  const announceAfterBulkForcedFailure = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  assert(
    announceAfterBulkForcedFailure === `Stopped 2 agents. Couldn't stop ${sessionD.name}'s agent`,
    `a partially-failed bulk Stop must announce the real success count AND name the failing Session, never report every target as stopped (gate round 2 F2 regression; got ${JSON.stringify(announceAfterBulkForcedFailure)})`
  );
  await cdp.waitFor(sessionDRow + ' !== undefined', { timeoutMs: 5_000, label: `Session "${sessionD.name}" must STILL be listed (the forced failure never actually stopped it)` });
  await waitForSessionStatus(cdp, sessionC.id, 'stopped');
  await waitForSessionStatus(cdp, sessionE.id, 'stopped');
  log(`STEP PASS: a partially-failed bulk Stop (2 genuinely stopped via the real backend, 1 forced-failed) announces truthfully: ${JSON.stringify(announceAfterBulkForcedFailure)}; the failed Session stays listed, the genuinely-stopped ones do not (F2).`);
  await cdp.screenshot(path.join(evidenceDir, '06-forced-stop-failure-still-listed.png'));

  await cdp.evaluate(`(() => { window.refract.sessions.stopAgent = window.__origStopAgent; delete window.__origStopAgent; })()`);
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape after the F2 regression tests' });
}
