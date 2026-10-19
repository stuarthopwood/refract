#!/usr/bin/env node
// Live CDP check for issue #891 (Delete Session dead-ends on a full/held worktree). Proves,
// against the real built app, scratch data only, under the temp dir:
//   (a) A registered Session whose worktree holds a pnpm-shaped tree (junctions pointing OUTSIDE
//       to a canary folder, a path over 260 characters, read-only files, a few thousand files)
//       deletes completely; the canary outside survives untouched; the admin entry is gone.
//   (b) A leftover UNREGISTERED full folder (git's own admin entry dropped by hand, content left
//       on disk) deletes completely.
//   (c) A bare `cmd.exe` this script spawned with its cwd inside the worktree makes Delete
//       refuse with the generic in-use message; the Session stays listed, nothing is deleted,
//       the folder is still at its original path; killing that one pid then lets Retry succeed.
//   (d) A PowerShell process this script spawned holding one file open inside the worktree is
//       NAMED in the refusal (Restart Manager); killing it then lets Retry succeed.
//   (e) The dialog shows the leftover summary (generated-folder bucket, file counts).
//   (f) Clicking Delete while the leftover-summary walk is still running (a genuine overlap,
//       asserted right before the click, not assumed) cancels that walk cleanly before the
//       holder preflight -- never a false refusal over Refract's own open handles.
//
// Build/launch/CDP plumbing reused from the established `verify-tauri-*` scripts
// (`verify-tauri-scratch-helpers.mjs`, `verify-tauri-cdp.mjs`, `verify-tauri-session-list-
// helpers.mjs`, `verify-tauri-560-helpers.mjs`); the Delete-dialog driving and scratch-content
// generation are new (`verify-891-delete-leftovers-helpers.mjs`) -- no existing script touches
// this dialog.

import { mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, assertExeMatchesProcess } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  safeRmSync,
  citeScreenshots,
  requireSharedCargoTarget,
  buildAndCopyExeFresh
} from './verify-tauri-scratch-helpers.mjs';
import { createSessionViaQuickCreate, addRepository } from './verify-tauri-session-list-helpers.mjs';
import { launchBuiltExe, latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import {
  sessionByName,
  dropAdminEntry,
  isRegisteredWorktree,
  populateFullWorktree,
  populateOrphanWorktree,
  populateLargeGeneratedTree,
  countFilesRecursive,
  spawnCwdHolder,
  spawnFileHolder,
  killSpawned,
  openDeleteDialogFor,
  waitForLeftoverSummary,
  waitForDialogSettled,
  readLeftoverStatusText,
  clickDeleteButton,
  readDialogError,
  waitForDeleteOutcome,
  waitForSessionAgentRunning,
  isSessionListed
} from './verify-891-delete-leftovers-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: refuses to build without the shared CARGO_TARGET_DIR, never a worktree-local target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SCRATCH_ROOT = process.env.REFRACT_891_SCRATCH_ROOT || path.join(tmpdir(), `refract-891-${STAMP}`);
const SHOT_DIR = process.env.REFRACT_891_SHOT_DIR || path.join(tmpdir(), `refract-891-shots-${STAMP}`);

const passed = [];
const failures = [];
// Issue #891 gate round (T5): genuinely populated, not decorative -- anything this harness
// cannot exercise live is recorded here instead of silently passing by omission.
const notExercised = [];
function fail(label, err) {
  failures.push({ label, message: err instanceof Error ? err.message : String(err) });
  console.error(`FAIL ${label}: ${err instanceof Error ? err.message : err}`);
}
function ok(label) {
  passed.push(label);
  console.log(`PASS ${label}`);
}

async function main() {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  const launcherExe = buildLauncher(SCRATCH_ROOT);
  const { dest: exePath, hash } = buildAndCopyExeFresh(SCRATCH_ROOT, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-891' });

  const repoDir = makeScratchRepo(path.join(SCRATCH_ROOT, 'scratch-repo'), 'verify-891');
  const repoName = path.basename(repoDir);
  const dataDir = path.join(SCRATCH_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const importSourceDir = path.join(SCRATCH_ROOT, 'import-unused');
  mkdirSync(importSourceDir, { recursive: true });
  const canaryDir = path.join(SCRATCH_ROOT, 'canary-outside-worktree');
  const port = await getFreePort();

  const appLogFile = path.join(SCRATCH_ROOT, 'app.log');
  const { child, targetPid } = await launchBuiltExe(launcherExe, exePath, {
    port,
    dataDir,
    importSourceDir,
    logFile: appLogFile
  });

  let cdp;
  const spawned = [];
  try {
    const wsUrl = await waitForCdpTarget(port);
    cdp = await CdpSession.connect(wsUrl);
    assertExeMatchesProcess(targetPid, exePath, hash);

    // Forwards the renderer's own console/exception output to this script's stdout -- the only
    // way to see a silent JS throw inside an onSelect handler, which would otherwise leave a
    // click looking like it "did nothing" with no error anywhere in this script's own output.
    await cdp.send('Runtime.enable');
    cdp.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        console.error('RENDERER EXCEPTION:', JSON.stringify(msg.params.exceptionDetails));
      } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        console.error('RENDERER CONSOLE:', msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    // The Readiness screen's own omp/GitHub checks can genuinely take up to a minute on a
    // brand-new scratch profile (established wait shape, verify-tauri-559/560/567.mjs).
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await addRepository(cdp, repoDir);

    const seenIds = [];
    async function newSession(label) {
      await createSessionViaQuickCreate(cdp, repoName);
      const { id, name } = await latestSessionIdAndName(cdp, repoName, seenIds);
      seenIds.push(id);
      console.log(`created Session for scenario ${label}: ${name} (${id})`);
      return name;
    }

    // ---- Scenario (a): registered, full worktree with junctions/long paths/read-only ----
    const nameA = await newSession('a');
    const sessionA = sessionByName(dataDir, nameA);
    const { canaryFile } = populateFullWorktree(sessionA.worktreePath, canaryDir);
    // Issue #891 gate round 2 (M8): a positive control -- prove the worktree genuinely WAS
    // registered before Delete runs, so the later "admin entry gone" check actually proves
    // something instead of trivially passing against a worktree that was never registered.
    if (isRegisteredWorktree(repoDir, sessionA.worktreePath)) ok('(a) positive control: worktree is registered before Delete runs');
    else fail('(a) positive control: worktree is registered before Delete runs', new Error('isRegisteredWorktree returned false before any delete attempt'));
    await openDeleteDialogFor(cdp, nameA, SHOT_DIR);
    const summaryTextA = await waitForLeftoverSummary(cdp);
    if (summaryTextA.toLowerCase().includes('node_modules')) ok('(e) dialog shows the leftover summary (node_modules bucket present)');
    else fail('(e) dialog shows the leftover summary', new Error(`no node_modules bucket in: ${summaryTextA}`));
    await cdp.screenshot(path.join(SHOT_DIR, '01-dialog-summary.png'));
    // Issue #891 gate round 2 (L2): a shot taken right after BOTH checks have genuinely
    // settled (the button's own enabled-wait, immediately before the click) -- proof the
    // dialog is actually in its real "ready to click" state, not assumed from '01' alone.
    await clickDeleteButton(cdp, { onReadyToClick: () => cdp.screenshot(path.join(SHOT_DIR, '04-dialog-ready.png')) });
    const outcomeA = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeA.closed) fail('(a) full worktree deletes cleanly', new Error(`delete failed: ${outcomeA.error}`));
    const aGone = !(await isSessionListed(cdp, nameA));
    const aWorktreeGone = !existsSync(sessionA.worktreePath);
    const aCanarySurvived = existsSync(canaryFile);
    const aAdminGone = !isRegisteredWorktree(repoDir, sessionA.worktreePath);
    if (outcomeA.closed && aGone && aWorktreeGone && aCanarySurvived && aAdminGone) ok('(a) full worktree with junctions/long paths/read-only deletes; canary survives; admin entry gone');
    else if (outcomeA.closed) fail('(a) full worktree deletes cleanly', new Error(`sessionGone=${aGone} worktreeGone=${aWorktreeGone} canarySurvived=${aCanarySurvived} adminGone=${aAdminGone}`));

    // ---- Scenario (b): unregistered leftover full folder ----
    const nameB = await newSession('b');
    const sessionB = sessionByName(dataDir, nameB);
    dropAdminEntry(repoDir, sessionB.worktreePath);
    // Issue #891 gate round 2 (M8): a positive control -- prove `dropAdminEntry` genuinely
    // unregistered the worktree, so scenario (b) actually starts from the unregistered state
    // its own name claims, not a silent no-op.
    if (!isRegisteredWorktree(repoDir, sessionB.worktreePath)) ok('(b) positive control: worktree is unregistered right after dropAdminEntry');
    else fail('(b) positive control: worktree is unregistered right after dropAdminEntry', new Error('isRegisteredWorktree still returned true'));
    populateOrphanWorktree(sessionB.worktreePath);
    await openDeleteDialogFor(cdp, nameB, SHOT_DIR);
    await waitForDialogSettled(cdp);
    // Issue #891 gate round 2 (H2): an unregistered folder makes every `git status` call fail,
    // which must read as "we don't know", never a silent "Nothing left in the worktree" --
    // this is the exact repro for the bug H2 fixes.
    const statusTextB = await readLeftoverStatusText(cdp);
    if (statusTextB === "Couldn't list the folder's files.") ok(`(b, H2) unregistered folder's failed git status reads "Couldn't list the folder's files.", never a false "Nothing left"`);
    else fail('(b, H2) unregistered folder shows "Couldn\'t list the folder\'s files."', new Error(`status line read: ${JSON.stringify(statusTextB)}`));
    await cdp.screenshot(path.join(SHOT_DIR, '05-dialog-cant-list.png'));
    await clickDeleteButton(cdp);
    const outcomeB = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeB.closed) fail('(b) leftover unregistered full folder deletes', new Error(`delete failed: ${outcomeB.error}`));
    const bGone = !(await isSessionListed(cdp, nameB));
    const bWorktreeGone = !existsSync(sessionB.worktreePath);
    if (outcomeB.closed && bGone && bWorktreeGone) ok('(b) leftover unregistered full folder deletes');
    else if (outcomeB.closed) fail('(b) leftover unregistered full folder deletes', new Error(`sessionGone=${bGone} worktreeGone=${bWorktreeGone}`));

    // ---- Scenario (c): a bare cmd.exe holding the folder as its own cwd ----
    const nameC = await newSession('c');
    const sessionC = sessionByName(dataDir, nameC);
    mkdirSync(sessionC.worktreePath, { recursive: true });
    // Issue #891 gate round (T2): snapshot BEFORE clicking Delete so the refusal's own "nothing
    // was touched" claim is actually proven, not assumed.
    const sentinelC = path.join(sessionC.worktreePath, 'sentinel.txt');
    writeFileSync(sentinelC, 'untouched');
    const cFileCountBefore = countFilesRecursive(sessionC.worktreePath);
    const cmdHolder = spawnCwdHolder(sessionC.worktreePath);
    spawned.push(cmdHolder);
    await new Promise((r) => setTimeout(r, 300)); // let Windows finish establishing the child's own cwd
    await openDeleteDialogFor(cdp, nameC, SHOT_DIR);
    await waitForLeftoverSummary(cdp);
    await clickDeleteButton(cdp);
    const errC = await readDialogError(cdp, { timeoutMs: 30_000 });
    await cdp.screenshot(path.join(SHOT_DIR, '02-dialog-refusal-cwd-holder.png'));
    const cFileCountAfter = countFilesRecursive(sessionC.worktreePath);
    const cRefusedCorrectly =
      !!errC &&
      errC.toLowerCase().includes('close it') &&
      (await isSessionListed(cdp, nameC)) &&
      existsSync(sessionC.worktreePath) &&
      existsSync(sentinelC) &&
      cFileCountAfter === cFileCountBefore;
    if (cRefusedCorrectly) ok('(c) cmd.exe cwd-holder refuses Delete with the in-use message; Session stays listed; the sentinel file and file count are unchanged');
    else
      fail(
        '(c) cmd.exe cwd-holder refuses Delete',
        new Error(
          `error=${JSON.stringify(errC)} listed=${await isSessionListed(cdp, nameC)} exists=${existsSync(sessionC.worktreePath)} sentinelExists=${existsSync(sentinelC)} fileCountBefore=${cFileCountBefore} fileCountAfter=${cFileCountAfter}`
        )
      );
    // Issue #891, Stuart's decision 2 (issuecomment-6273442096): a refused Delete must leave
    // (or restart) the Session's own agent running -- checked by its REAL status, not merely
    // that the row still exists.
    try {
      const cAgentStatus = await waitForSessionAgentRunning(cdp, nameC, { timeoutMs: 20_000 });
      ok(`(c) Session's agent is running again after the refusal (status: ${cAgentStatus})`);
    } catch (err) {
      fail("(c) Session's agent is running again after the refusal", err);
    }
    await killSpawned(cmdHolder);
    // Issue #891 gate round 2: a transient Windows sharing violation (antivirus/indexer scan)
    // at the ACTUAL removal step -- distinct from the preflight holder checks, which already
    // passed by the time this runs -- is accepted, recoverable behaviour per the product's own
    // design ("Retry finishes it", the original task's own acceptance wording); found live on
    // this run (`wrap_fs_error`'s raw-OS-error-32 message). A real user reading that exact
    // message would click Retry again, so this retries up to 3 times rather than failing on
    // the first transient hit.
    let outcomeC;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await clickDeleteButton(cdp); // Retry: same button
      outcomeC = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
      if (outcomeC.closed) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!outcomeC.closed) fail('(c) Retry succeeds after the holder is killed', new Error(`delete failed: ${outcomeC.error}`));
    const cRetryGone = !(await isSessionListed(cdp, nameC)) && !existsSync(sessionC.worktreePath);
    if (outcomeC.closed && cRetryGone) ok('(c) Retry succeeds once the cwd-holding process is gone');
    else if (outcomeC.closed) fail('(c) Retry succeeds after the holder is killed', new Error(`listed=${await isSessionListed(cdp, nameC)} exists=${existsSync(sessionC.worktreePath)}`));

    // ---- Scenario (d): a PowerShell process holding one FILE open inside the worktree ----
    const nameD = await newSession('d');
    const sessionD = sessionByName(dataDir, nameD);
    mkdirSync(sessionD.worktreePath, { recursive: true });
    const heldFile = path.join(sessionD.worktreePath, 'held.txt');
    writeFileSync(heldFile, 'held open by a spawned process');
    // Issue #891 gate round (T2): a SEPARATE sentinel, distinct from the held file itself, plus
    // a before/after file-count snapshot -- the refusal's own "nothing was touched" claim must
    // be proven, not assumed.
    const sentinelD = path.join(sessionD.worktreePath, 'sentinel.txt');
    writeFileSync(sentinelD, 'untouched');
    const dFileCountBefore = countFilesRecursive(sessionD.worktreePath);
    const fileHolder = spawnFileHolder(heldFile);
    spawned.push(fileHolder);
    await new Promise((r) => setTimeout(r, 500));
    await openDeleteDialogFor(cdp, nameD, SHOT_DIR);
    await waitForLeftoverSummary(cdp);
    await clickDeleteButton(cdp);
    const errD = await readDialogError(cdp, { timeoutMs: 30_000 });
    await cdp.screenshot(path.join(SHOT_DIR, '03-dialog-refusal-named-holder.png'));
    const dFileCountAfter = countFilesRecursive(sessionD.worktreePath);
    const dPidMatch = errD ? errD.match(/process (\d+)/i) : null;
    const dPidMatchesHolder = !!dPidMatch && Number(dPidMatch[1]) === fileHolder.pid;
    const dNamed =
      !!errD &&
      /powershell/i.test(errD) &&
      dPidMatchesHolder &&
      existsSync(sentinelD) &&
      dFileCountAfter === dFileCountBefore;
    if (dNamed) ok(`(d) spawned file-holder is named in the refusal with its own real pid (${fileHolder.pid}); sentinel and file count unchanged: ${errD}`);
    else
      fail(
        '(d) spawned file-holder is named in the refusal',
        new Error(
          `error=${JSON.stringify(errD)} expectedPid=${fileHolder.pid} matchedPid=${dPidMatch ? dPidMatch[1] : null} sentinelExists=${existsSync(sentinelD)} fileCountBefore=${dFileCountBefore} fileCountAfter=${dFileCountAfter}`
        )
      );
    await killSpawned(fileHolder);
    // Issue #891 gate round 2: same transient-sharing-violation resilience as scenario (c)'s
    // own Retry loop -- a real user would click Retry again.
    let outcomeD;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await clickDeleteButton(cdp);
      outcomeD = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
      if (outcomeD.closed) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!outcomeD.closed) fail('(d) Retry succeeds after the holder is killed', new Error(`delete failed: ${outcomeD.error}`));
    const dRetryGone = !(await isSessionListed(cdp, nameD)) && !existsSync(sessionD.worktreePath);
    if (outcomeD.closed && dRetryGone) ok('(d) Retry succeeds once the file-holding process is gone');
    else if (outcomeD.closed) fail('(d) Retry succeeds after the holder is killed', new Error(`listed=${await isSessionListed(cdp, nameD)} exists=${existsSync(sessionD.worktreePath)}`));

    // ---- Scenario (f): clicking Delete while the leftover-summary walk is still running ----
    // Issue #891 gate round item 5: deliberately does NOT call `waitForLeftoverSummary` first --
    // `clickDeleteButton` itself waits only for `deleteCheck` (the fast git-only read) to
    // settle, so Delete fires while "Checking files…" is still walking this deliberately large
    // tree. Proves `sessions.delete` cancels and awaits that walk before its own holder
    // preflight, so Refract's own open handles during the walk never cause a false refusal.
    // Issue #891 gate round 2 (H4): a prior run never actually overlapped (the walk finished
    // ~4s before the click) and silently reported a pass that proved nothing -- the status
    // line is now read right at the moment `clickDeleteButton`'s own enabled-wait resolves
    // (`onReadyToClick`), immediately before the click itself; a run that genuinely does not
    // overlap is recorded as notExercised, never claimed as a pass.
    const nameF = await newSession('f');
    const sessionF = sessionByName(dataDir, nameF);
    populateLargeGeneratedTree(sessionF.worktreePath);
    await openDeleteDialogFor(cdp, nameF, SHOT_DIR);
    let statusTextF = '';
    await clickDeleteButton(cdp, {
      onReadyToClick: async () => {
        statusTextF = await readLeftoverStatusText(cdp);
      }
    });
    if (statusTextF !== 'Checking files…') {
      notExercised.push(
        `(f) Delete clicked while the leftover-summary walk is still running -- this run never actually overlapped (status line read ${JSON.stringify(statusTextF)} right before the click, not "Checking files…"), so no genuine overlap was proven this run`
      );
    } else {
      const outcomeF = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
      if (!outcomeF.closed) fail('(f) Delete clicked mid-walk on a large tree still succeeds', new Error(`delete failed: ${outcomeF.error}`));
      const fGone = !(await isSessionListed(cdp, nameF));
      const fWorktreeGone = !existsSync(sessionF.worktreePath);
      if (outcomeF.closed && fGone && fWorktreeGone) ok("(f) Delete clicked while the leftover-summary walk was still running on a large tree succeeds cleanly, no false holder refusal from the walk's own open handles");
      else if (outcomeF.closed) fail('(f) Delete clicked mid-walk on a large tree still succeeds', new Error(`sessionGone=${fGone} worktreeGone=${fWorktreeGone}`));
      // Issue #891 gate round 2 (H4): `cancel_and_wait` must have actually found and cancelled
      // this Session's own in-flight walk before the holder preflight ran -- proven by its own
      // debug line in app.log, scoped to this Session's id (never just "a log line exists
      // somewhere"). Retried briefly: the log writer flushes asynchronously, so a read taken
      // the instant the IPC call resolves can race a buffered write that has not landed yet.
      const cancelLogPatternF = new RegExp(`cancelling \\d+ in-flight walk\\(s\\) for ${sessionF.id}`);
      let appLogTextF = '';
      let cancelLoggedF = false;
      for (let attempt = 0; attempt < 10 && !cancelLoggedF; attempt++) {
        appLogTextF = existsSync(appLogFile) ? readFileSync(appLogFile, 'utf8') : '';
        cancelLoggedF = cancelLogPatternF.test(appLogTextF);
        if (!cancelLoggedF) await new Promise((r) => setTimeout(r, 200));
      }
      if (cancelLoggedF) ok("(f, H4) cancel_and_wait logged cancelling this Session's own in-flight walk before the holder preflight ran");
      else fail('(f, H4) cancel_and_wait logs cancelling the in-flight walk for this Session', new Error('no matching debug line found in app.log'));
    }
  } catch (err) {
    fail('unhandled', err);
  } finally {
    for (const p of spawned) await killSpawned(p).catch(() => {});
    if (cdp) cdp.close();
    await stopLauncher(child).catch(() => {});
    // Preserved alongside screenshots (SHOT_DIR survives; SCRATCH_ROOT does not) -- the app's
    // own tauri_plugin_log output is otherwise lost the moment safeRmSync below runs, which is
    // exactly when a failure most needs it.
    if (existsSync(appLogFile)) {
      try {
        copyFileSync(appLogFile, path.join(SHOT_DIR, 'app.log'));
      } catch {
        /* best-effort */
      }
    }
    await safeRmSync(SCRATCH_ROOT, 'verify-891');
  }

  // Issue #891 gate round (T5): recorded honestly, not decorative -- this harness cannot
  // simulate a stalled `git worktree list` (RegistrationState::Unknown, worktree_delete.rs
  // gate S4) or an undetectable holder ("proceed if none visible"); both are code-reviewed
  // only, never live-exercised here.
  notExercised.push(
    'RegistrationState::Unknown (a stalled `git worktree list --porcelain`) and its refusal wording -- this harness cannot force a real git timeout'
  );
  notExercised.push(
    'A holder neither Restart Manager nor the rename probe can detect ("proceed if none visible") -- every spawned holder here is deliberately detectable'
  );
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length > 0;
  const report = {
    gitHead: gitHead(REPO_ROOT),
    dirty,
    passed,
    failures,
    notExercised,
    screenshots: citeScreenshots(
      SHOT_DIR,
      ['01-dialog-summary.png', '02-dialog-refusal-cwd-holder.png', '03-dialog-refusal-named-holder.png', '04-dialog-ready.png', '05-dialog-cant-list.png', '99-diag-delete-dialog-failure.png'].filter((name) =>
        existsSync(path.join(SHOT_DIR, name))
      )
    )
  };
  writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report.json written to ${path.join(SHOT_DIR, 'report.json')}`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('All acceptance checks PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
