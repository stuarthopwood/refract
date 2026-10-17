// Gate round 2 (F1/F2) regression tests for verify-tauri-560.mjs, split out solely to keep that
// file under the repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change
// from running this code inline. See verify-tauri-560.mjs's own header comment for what each
// proves; this module holds the two regression tests themselves, not the setup/plumbing they
// run inside (that stays in verify-tauri-560-helpers.mjs). Also holds the Items 7 & 8 Tab-walk
// / HealthCheckDialog check (moved here for the same line-cap reason, round 3).
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { assert, axText, pressRealEnter, waitForSessionStatus, latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { createSessionViaQuickCreate, getActiveElementAccessibleName, pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';

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

/** Items 7 & 8: a real keyboard-only Tab walk from the profile name button, through the cog,
 *  through both alert rows -- reading every control's own accessible name off the Accessibility
 *  domain as it goes (never textContent) -- then Enter (not a click) on Check to open the real
 *  HealthCheckDialog, satisfying item 5 (the warning state word, Done, and the focus-return) in
 *  the same pass. Split out of verify-tauri-560.mjs's own `runChecks` solely to keep that file
 *  under the repo's 600-line soft cap (round 3) -- no behaviour change. Returns `nameButtonAx`
 *  (the profile item's own name button accessible name), the one value `runChecks` still needs
 *  afterward (item 6's keyboard-driven Dismiss fallback assertion). */
export async function runTabWalkAndHealthCheckDialogTest(cdp, { PROFILE_NAME_BUTTON, DIALOG_TITLE, DIALOG, OMP_CHECK_ROW }, evidenceDir, log) {
  await cdp.evaluate(`(() => { const el = ${PROFILE_NAME_BUTTON}; el?.focus(); return !!el; })()`);
  const nameButtonAx = await getActiveElementAccessibleName(cdp);
  assert(nameButtonAx.role === 'button', `the profile item's own name control must be a button (got role ${JSON.stringify(nameButtonAx.role)}, name ${JSON.stringify(nameButtonAx.name)})`);
  const tabOrder = [{ step: 'start (profile name button)', ...nameButtonAx }];

  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Settings', `Tab from the name button must land on the Settings cog (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 1', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Open memory triage', `Tab from Settings must land on the Triage button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 2', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Dismiss low memory alert', `Tab from Triage must land on the low-memory Dismiss button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 3', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Open Health check', `Tab from the low-memory Dismiss button must land on the Check button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 4', ...active });
  log(`STEP PASS: real Tab order from the profile name button: ${tabOrder.map((s) => `${s.step}=${JSON.stringify(s.name)}`).join(' -> ')}.`);

  await pressRealEnter(cdp);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Health check'`, { timeoutMs: 10_000, label: 'HealthCheckDialog opened via Enter (not a click)' });
  log('STEP PASS: Enter on the focused Check button opened the real HealthCheckDialog (keyboard-only activation).');

  await cdp.waitFor(`(${OMP_CHECK_ROW})?.textContent.includes('Passed with a warning')`, { timeoutMs: 20_000, label: 'omp row shows "Passed with a warning"' });
  const ompCheckRowName = await axText(cdp, `(${OMP_CHECK_ROW})?.querySelector('span')?.querySelector('span')`); // CheckRow.tsx: the li's own FIRST span is the label span, and the state word is a span NESTED inside that one -- a warning Check ALSO renders a later sibling hint span at the li level, so ".pop()" (last span overall) grabbed that hint text in round 1, confirmed live, instead of the state word
  assert((ompCheckRowName ?? '').includes('Passed with a warning'), `the omp CheckRow's own rendered state word must be "Passed with a warning" (got ${JSON.stringify(ompCheckRowName)}), never an invented string`);
  log(`STEP PASS: HealthCheckDialog's omp row renders its own real state word: ${JSON.stringify(ompCheckRowName)}.`);
  await cdp.screenshot(path.join(evidenceDir, '02-health-check-dialog-warning.png'));

  const preDoneActive = await getActiveElementAccessibleName(cdp);
  assert(preDoneActive.name === 'Done', `Done must still be focused (it is auto-focused on open and nothing should have stolen focus) (got ${JSON.stringify(preDoneActive)})`);
  await pressRealEnter(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'HealthCheckDialog closed via Enter on Done' });
  const postCloseActive = await getActiveElementAccessibleName(cdp);
  assert(postCloseActive.name === 'Open Health check', `Done must return focus to the alert row's own Check button, not <body>/the Settings cog (got ${JSON.stringify(postCloseActive)})`);
  log('STEP PASS: Done closes HealthCheckDialog and returns focus to the alert row\'s own Check button (never <body>).');

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Dismiss unverified version alert', `Tab from Check must land on the omp-version Dismiss button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 5 (post Health-check close)', ...active });
  log(`STEP PASS: full documented Tab order confirmed: ${tabOrder.map((s) => JSON.stringify(s.name)).join(' -> ')}.`);

  return nameButtonAx;
}

/** Gate round 3 H1 regression test: a row that clears ON ITS OWN (the real condition resolving
 *  -- memory recovers, the omp version becomes verified -- never a user clicking Dismiss) while
 *  focus was inside it never redirected: the round-2 fix read `event.target.isConnected`
 *  SYNCHRONOUSLY inside `focusout`, but Chromium/WebView2 fires blur/focusout BEFORE the removed
 *  node is actually detached, so `isConnected` always read `true` at that exact moment even for a
 *  genuine removal -- the redirect never ran. The FIX itself (ProfileAlertRows.tsx) matches
 *  `FileExplorerPanel.tsx`'s own already-established `handleFocusOut` pattern exactly (defer the
 *  connectedness check one frame, via the shared `isFocusStranded`), so it is code-verified
 *  against a precedent this repo already trusts without a live-reproduction harness of its own.
 *
 *  Live reproduction needs the real memory/health condition to flip WHILE focus is already
 *  inside the row, with nothing else involved -- `window.__refractStores` (the dev-only map
 *  this repo's own `verify-tauri-569.mjs` already documented as unavailable here: a Tauri debug
 *  build still runs `vite build` in production mode per `tauri.conf.json`'s own
 *  `beforeBuildCommand`, so `import.meta.env.DEV` is false) would be the direct way, but does
 *  not exist in this build; the only OTHER real levers (actually exhausting the shared machine's
 *  free memory below the 2GB threshold, or relaunching with a different fake-omp version) are
 *  either unsafe for a shared machine or do not reproduce "while focus is inside it" at all.
 *  Reports NOT EXERCISED rather than silently skipping or falsely passing, the same honest-gaps
 *  convention this PR already uses for forced-colours rendering. */
export async function runSelfClearingRowFocusRegressionTest(cdp, { TRIAGE_BUTTON, CHECK_BUTTON, LOW_MEMORY_ROW_SPAN, OMPVERSION_ROW_SPAN }, log, notExercised) {
  const devStoresAvailable = await cdp.evaluate(`typeof window.__refractStores !== 'undefined'`);
  if (!devStoresAvailable) {
    notExercised.push(
      'Gate round 3 H1 (a row clearing ON ITS OWN -- memory recovers, the omp version becomes ' +
        'verified -- while focus is inside it): window.__refractStores (the dev-only global this ' +
        'test would flip to simulate the real condition changing) does not exist in this build ' +
        '(a Tauri debug build still runs `vite build` in production mode, confirmed against ' +
        'tauri.conf.json\'s own beforeBuildCommand, matching verify-tauri-569.mjs\'s own prior ' +
        'finding) -- code-verified only, against FileExplorerPanel.tsx\'s own already-established ' +
        'handleFocusOut pattern the fix matches exactly.'
    );
    return;
  }
  // ---- Memory row clears on its own while Triage has focus -> falls back to the omp-version
  // row's own Check button. ----
  await cdp.evaluate(`(() => { const el = ${TRIAGE_BUTTON}; el?.focus(); return !!el; })()`);
  const preMemorySelfClear = await getActiveElementAccessibleName(cdp);
  assert(
    preMemorySelfClear.name === 'Open memory triage',
    `must have focused Triage before the self-clearing-row test (got ${JSON.stringify(preMemorySelfClear)})`
  );
  await cdp.evaluate(`window.__refractStores.memory.setState({ warning: null })`);
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' === undefined', {
    timeoutMs: 5_000,
    label: 'low-memory row cleared on its own (store flipped directly, not via Dismiss)'
  });
  const postMemorySelfClear = await getActiveElementAccessibleName(cdp);
  assert(
    postMemorySelfClear.role === 'button' && postMemorySelfClear.name === 'Open Health check',
    `a row that clears ON ITS OWN while focus is inside it must redirect to the OTHER row's own action button (gate round 3 H1; got ${JSON.stringify(postMemorySelfClear)})`
  );
  await sleep(1_000);
  const postMemorySelfClearLater = await getActiveElementAccessibleName(cdp);
  assert(
    postMemorySelfClearLater.role === 'button' && postMemorySelfClearLater.name === 'Open Health check',
    `focus on the Check button must still hold about a second later (got ${JSON.stringify(postMemorySelfClearLater)})`
  );
  log('STEP PASS: the low-memory row clearing ON ITS OWN (store flipped directly, never Dismiss) while Triage had focus redirects to the omp-version row\'s own Check button, holding at least a second later (H1).');

  // Real condition is still forced low (REFRACT_FORCE_LOW_MEMORY=1); the real sampler re-reports
  // it within its own 5s SAMPLE_INTERVAL_MS -- restores the row so every later assertion in this
  // script sees it exactly as before this test ran.
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' !== undefined', {
    timeoutMs: 10_000,
    label: 'low-memory row reappears once the real sampler tick re-reports the still-true condition'
  });

  // ---- omp-version row clears on its own while Check has focus -> falls back to the
  // low-memory row's own Triage button. ----
  await cdp.evaluate(`(() => { const el = ${CHECK_BUTTON}; el?.focus(); return !!el; })()`);
  const preOmpSelfClear = await getActiveElementAccessibleName(cdp);
  assert(
    preOmpSelfClear.name === 'Open Health check',
    `must have focused Check before the self-clearing-row test (got ${JSON.stringify(preOmpSelfClear)})`
  );
  await cdp.evaluate(`window.__refractStores.health.setState({ ompVersionWarning: null })`);
  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' === undefined', {
    timeoutMs: 5_000,
    label: 'omp-version row cleared on its own (store flipped directly, not via Dismiss)'
  });
  const postOmpSelfClear = await getActiveElementAccessibleName(cdp);
  assert(
    postOmpSelfClear.role === 'button' && postOmpSelfClear.name === 'Open memory triage',
    `a row that clears ON ITS OWN while focus is inside it must redirect to the OTHER row's own action button (gate round 3 H1; got ${JSON.stringify(postOmpSelfClear)})`
  );
  await sleep(1_000);
  const postOmpSelfClearLater = await getActiveElementAccessibleName(cdp);
  assert(
    postOmpSelfClearLater.role === 'button' && postOmpSelfClearLater.name === 'Open memory triage',
    `focus on the Triage button must still hold about a second later (got ${JSON.stringify(postOmpSelfClearLater)})`
  );
  log('STEP PASS: the omp-version row clearing ON ITS OWN (store flipped directly, never Dismiss) while Check had focus redirects to the low-memory row\'s own Triage button, holding at least a second later (H1).');

  // `readiness.ts`'s own check never re-runs on its own, unlike memory's periodic sampler, so
  // this row is restored manually to its EXACT original shape/value (fake-omp's hardcoded
  // 18.10.1) rather than waited for, so the Tab-walk/Health-check/Item-6-Dismiss tests below see
  // it exactly as readiness.rs's own real check first set it.
  await cdp.evaluate(`window.__refractStores.health.setState({ ompVersionWarning: { ok: true, found: '18.10.1', warning: true } })`);
  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' !== undefined', {
    timeoutMs: 5_000,
    label: 'omp-version row restored to its original state after the H1 self-clear test'
  });
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
 *  symptom.
 *
 *  Single AND bulk both reuse the SAME one Session (sessionC), never a second concurrently-idle
 *  one: this harness forces `REFRACT_FORCE_LOW_MEMORY=1` for the whole run (#560's own
 *  low-memory alert row needs it), and issue #512's real "defer a new agent start while memory
 *  is low AND another agent is already spawned" feature (`start_queue.rs`'s own
 *  `spawned_in_flight() > 0` check) then defers any SECOND concurrently-live Session's start for
 *  up to its own 60s `MEMORY_DEFER_CEILING_MS` -- confirmed live (two separate runs) racing this
 *  script's own 60s wait for the same session to become ready. Not a flake to work around: a
 *  real feature this test would otherwise have to fight. Bulk with a single target (matching the
 *  pre-existing bulk test's own n=1 precedent above) still fully exercises
 *  `handleConfirmBulkStop`'s failure path -- the id-to-name lookup, the per-id outcome mapping,
 *  the notify() toast, and the announce() -- without needing a second live Session at all. */
export async function runForcedStopFailureRegressionTests(
  cdp,
  { repoName, sessionA, sessionB, evidenceDir, DIALOG_TITLE, ALERT_DIALOG_TITLE, ALERT_DIALOG, DIALOG, TRIAGE_BUTTON, CHAT_AREA_ANNOUNCE_REGION },
  log
) {
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionC = await latestSessionIdAndName(cdp, repoName, [sessionA.id, sessionB.id]);
  await waitForSessionStatus(cdp, sessionC.id, 'idle');
  log(`STEP PASS: third Session "${sessionC.name}" (${sessionC.id}) created and reached idle, for the forced-Stop-failure tests.`);

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
  await sleep(300); // same settle-sleep race guard as every other post-dialog-open click in this file
  await cdp.click(`(${sessionCRow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionC.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'forced-failure Stop confirmation opened' });
  await sleep(300); // settle-sleep race guard: see verify-tauri-560.mjs's own bulk-confirm comment
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

  // Bulk forced failure: the SAME Session (sessionC, still the only idle one) via "Stop idle"
  // instead of its own per-row Stop -- proves `handleConfirmBulkStop`'s failure path separately
  // from `handleConfirmStop`'s (different code, same store call underneath). See this
  // function's own doc comment above for why this never needs a second concurrently-idle
  // Session.
  // Gate round 3 fix (M3): clears the live region FIRST -- the single-failure test above
  // already left this exact text ("Couldn't stop {sessionC.name}'s agent") sitting there, so
  // without this, a regressed announce() call here (or none at all) could still read back as a
  // false pass purely from the leftover text, not from anything this bulk action actually did.
  await cdp.evaluate(`(() => { const el = ${CHAT_AREA_ANNOUNCE_REGION}; if (el) el.textContent = ''; })()`);
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  // Gate round 3 (L4): a bulk confirm targeting exactly one Session now reuses the single-stop
  // wording verbatim, not "Stop 1 idle agent?".
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionC.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'bulk forced-failure confirmation opened' });
  await sleep(300); // settle-sleep race guard: see verify-tauri-560.mjs's own bulk-confirm comment
  await cdp.click(`Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Stop')`);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk forced-failure confirmation closed' });
  await sleep(300);
  const announceAfterBulkForcedFailure = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  assert(
    announceAfterBulkForcedFailure === `Couldn't stop ${sessionC.name}'s agent`,
    `a forced bulk Stop failure must announce the real failure, naming the Session, never report it as stopped (gate round 2 F2 regression; got ${JSON.stringify(announceAfterBulkForcedFailure)})`
  );
  await cdp.waitFor(sessionCRow + ' !== undefined', { timeoutMs: 5_000, label: `Session "${sessionC.name}" must STILL be listed (the forced bulk failure never actually stopped it)` });
  log(`STEP PASS: a forced bulk Stop failure ("Stop idle" on the one idle Session) is announced truthfully as ${JSON.stringify(announceAfterBulkForcedFailure)} (never success), and the Session stays listed (F2).`);
  await cdp.screenshot(path.join(evidenceDir, '06-forced-stop-failure-still-listed.png'));

  await cdp.evaluate(`(() => { window.refract.sessions.stopAgent = window.__origStopAgent; delete window.__origStopAgent; })()`);
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape after the F2 regression tests' });
}
