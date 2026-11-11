#!/usr/bin/env node
// Live CDP check for #891 (Delete Session on a full/held worktree), scratch data. Covers: junction/long-path/
// read-only worktree deletes fully (canary survives); unregistered leftover folder deletes; a held cwd or open
// file refuses and NAMES the holder (Restart Manager), Retry succeeds once killed; leftover summary shown;
// Delete during the summary walk cancels it cleanly. Helpers: verify-891-delete-leftovers-helpers.mjs.

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
  buildAndCopyExeFresh,
  switchTheme
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
// Anything this harness can't exercise live is recorded here rather than passing by omission.
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

    // Forwards renderer console/exception output: the only way to see a silent JS throw in an onSelect handler.
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

    // Readiness checks can take up to a minute on a brand-new scratch profile.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await addRepository(cdp, repoDir);
    await switchTheme(cdp, 'dark', 'Dark');

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
    // Positive control: prove the worktree WAS registered, so "admin entry gone" can't pass trivially.
    if (isRegisteredWorktree(repoDir, sessionA.worktreePath)) ok('(a) positive control: worktree is registered before Delete runs');
    else fail('(a) positive control: worktree is registered before Delete runs', new Error('isRegisteredWorktree returned false before any delete attempt'));
    await openDeleteDialogFor(cdp, nameA, SHOT_DIR);
    const summaryTextA = await waitForLeftoverSummary(cdp);
    if (summaryTextA.toLowerCase().includes('node_modules')) ok('(e) dialog shows the leftover summary (node_modules bucket present)');
    else fail('(e) dialog shows the leftover summary', new Error(`no node_modules bucket in: ${summaryTextA}`));
    await cdp.screenshot(path.join(SHOT_DIR, '01-dialog-summary.png'));
    // Shot taken once both checks have settled, right before the click: proves the dialog is ready to click.
    await clickDeleteButton(cdp, { onReadyToClick: () => cdp.screenshot(path.join(SHOT_DIR, '04-dialog-ready.png')) });
    const outcomeA = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeA.closed) fail('(a) full worktree deletes cleanly', new Error(`delete failed: ${outcomeA.error}`));
    // sessions.delete acks once its checks pass; removal finishes afterwards, so poll instead of reading once.
    await cdp.waitFor(`!Array.from(document.querySelectorAll('[data-session-open]')).some((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(nameA)}))`, { timeoutMs: 120_000, label: `${nameA} removed` }).catch(() => {});
    for (let i = 0; i < 120 && existsSync(sessionA.worktreePath); i++) await new Promise((r) => setTimeout(r, 500));
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
    // Positive control: prove `dropAdminEntry` really unregistered the worktree, not a silent no-op.
    if (!isRegisteredWorktree(repoDir, sessionB.worktreePath)) ok('(b) positive control: worktree is unregistered right after dropAdminEntry');
    else fail('(b) positive control: worktree is unregistered right after dropAdminEntry', new Error('isRegisteredWorktree still returned true'));
    populateOrphanWorktree(sessionB.worktreePath);
    await openDeleteDialogFor(cdp, nameB, SHOT_DIR);
    await waitForDialogSettled(cdp);
    // An unregistered folder makes every `git status` fail; that must read as "we don't know", never "Nothing left in the worktree".
    const statusTextB = await readLeftoverStatusText(cdp);
    if (statusTextB.startsWith("Couldn't list the folder's files.")) ok(`(b, H2) unregistered folder's failed git status reads "${statusTextB}", never a false "Nothing left"`);
    else fail('(b, H2) unregistered folder shows "Couldn\'t list the folder\'s files."', new Error(`status line read: ${JSON.stringify(statusTextB)}`));
    await cdp.screenshot(path.join(SHOT_DIR, '05-dialog-cant-list.png'));
    await clickDeleteButton(cdp);
    const outcomeB = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeB.closed) fail('(b) leftover unregistered full folder deletes', new Error(`delete failed: ${outcomeB.error}`));
    await cdp.waitFor(`!Array.from(document.querySelectorAll('[data-session-open]')).some((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(nameB)}))`, { timeoutMs: 120_000, label: `${nameB} removed` }).catch(() => {});
    for (let i = 0; i < 120 && existsSync(sessionB.worktreePath); i++) await new Promise((r) => setTimeout(r, 500));
    const bGone = !(await isSessionListed(cdp, nameB));
    const bWorktreeGone = !existsSync(sessionB.worktreePath);
    if (outcomeB.closed && bGone && bWorktreeGone) ok('(b) leftover unregistered full folder deletes');
    else if (outcomeB.closed) fail('(b) leftover unregistered full folder deletes', new Error(`sessionGone=${bGone} worktreeGone=${bWorktreeGone}`));

    // ---- Scenario (c): a bare cmd.exe holding the folder as its own cwd ----
    const nameC = await newSession('c');
    const sessionC = sessionByName(dataDir, nameC);
    mkdirSync(sessionC.worktreePath, { recursive: true });
    // Snapshot BEFORE clicking Delete so "nothing was touched" is proven, not assumed.
    const sentinelC = path.join(sessionC.worktreePath, 'sentinel.txt');
    writeFileSync(sentinelC, 'untouched');
    const cFileCountBefore = countFilesRecursive(sessionC.worktreePath);
    const cmdHolder = spawnCwdHolder(sessionC.worktreePath);
    spawned.push(cmdHolder);
    await new Promise((r) => setTimeout(r, 300)); // let Windows finish establishing the child's own cwd
    await openDeleteDialogFor(cdp, nameC, SHOT_DIR);
    await waitForLeftoverSummary(cdp);
    // #1159: records every status-line state so the transient "Rechecking…" + spinner after a refusal is provable.
    await cdp.evaluate(
      `(() => { window.__statusLog = []; const root = document.querySelector('[role="alertdialog"]'); const rec = () => { const s = root.querySelector('[role="status"]'); window.__statusLog.push({ text: s?.textContent || '', spinner: !!s?.querySelector('svg.animate-spin') }); }; new MutationObserver(rec).observe(root, { subtree: true, childList: true, characterData: true, attributes: true }); })()`
    );
    await clickDeleteButton(cdp);
    const errC = await readDialogError(cdp, { timeoutMs: 30_000 });
    await cdp.screenshot(path.join(SHOT_DIR, '02-dialog-refusal-cwd-holder.png'));
    const statusLogC = await cdp.evaluate(`window.__statusLog`);
    if (statusLogC.some((s) => s.text === 'Rechecking…' && s.spinner)) ok('(c, #1159) after the refusal the status line shows a spinner with "Rechecking…"');
    else fail('(c, #1159) Rechecking… with spinner after refusal', new Error(`status log: ${JSON.stringify(statusLogC)}`));
    const retryLabelC = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).map((b) => b.textContent.trim()).includes('Retry')`);
    const errClassC = await cdp.evaluate(`document.querySelector('[role="alertdialog"] [role="alert"]')?.className || ''`);
    if (retryLabelC && !/sr-only/.test(errClassC)) ok('(c, #1159) confirm reads Retry and the shared DialogError renders visibly (not sr-only)');
    else fail('(c, #1159) Retry label + visible DialogError', new Error(`retry=${retryLabelC} class=${errClassC}`));
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
    // A refused Delete must leave (or restart) the Session's agent running (Stuart's decision, issuecomment-6273442096);
    // checked by its real status, not just that the row exists.
    try {
      const cAgentStatus = await waitForSessionAgentRunning(cdp, nameC, { timeoutMs: 20_000 });
      ok(`(c) Session's agent is running again after the refusal (status: ${cAgentStatus})`);
    } catch (err) {
      fail("(c) Session's agent is running again after the refusal", err);
    }
    await killSpawned(cmdHolder);
    // A single Retry click, no retry loop: a script-level loop would hide a regression in the product-side
    // fixes (deleteCheck refresh no longer races removal; bounded retry in remove_tree_blocking).
    await clickDeleteButton(cdp);
    const outcomeC = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeC.closed) fail('(c) Retry succeeds after the holder is killed', new Error(`attempts=1 delete failed: ${outcomeC.error}`));
    else {
      const cRetryGone = !(await isSessionListed(cdp, nameC)) && !existsSync(sessionC.worktreePath);
      if (cRetryGone) ok('(c) Retry succeeds once the cwd-holding process is gone (single attempt)');
      else fail('(c) Retry succeeds after the holder is killed', new Error(`attempts=1 listed=${await isSessionListed(cdp, nameC)} exists=${existsSync(sessionC.worktreePath)}`));
    }

    // ---- Scenario (d): a PowerShell process holding one FILE open inside the worktree ----
    const nameD = await newSession('d');
    const sessionD = sessionByName(dataDir, nameD);
    mkdirSync(sessionD.worktreePath, { recursive: true });
    const heldFile = path.join(sessionD.worktreePath, 'held.txt');
    writeFileSync(heldFile, 'held open by a spawned process');
    // A separate sentinel plus a before/after file-count snapshot prove "nothing was touched".
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
    // Single click, as in scenario (c).
    await clickDeleteButton(cdp);
    const outcomeD = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (!outcomeD.closed) fail('(d) Retry succeeds after the holder is killed', new Error(`attempts=1 delete failed: ${outcomeD.error}`));
    else {
      const dRetryGone = !(await isSessionListed(cdp, nameD)) && !existsSync(sessionD.worktreePath);
      if (dRetryGone) ok('(d) Retry succeeds once the file-holding process is gone (single attempt)');
      else fail('(d) Retry succeeds after the holder is killed', new Error(`attempts=1 listed=${await isSessionListed(cdp, nameD)} exists=${existsSync(sessionD.worktreePath)}`));
    }

    // ---- Scenario (f): clicking Delete while the leftover-summary walk is still running ----
    // Deliberately skips `waitForLeftoverSummary`: `clickDeleteButton` waits only for the fast git-only
    // `deleteCheck`, so Delete fires while "Checking files…" is still walking. Proves `sessions.delete`
    // cancels that walk before the holder preflight (no false refusal over Refract's own handles).
    // The status line is read at `onReadyToClick`, right before the click; a run that doesn't overlap
    // is recorded notExercised, never a pass.
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
      // `cancel_and_wait` must have cancelled this Session's in-flight walk, proven by its app.log debug
      // line scoped to this Session id. Retried: the log writer flushes asynchronously.
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
    // Kept alongside screenshots (SHOT_DIR survives, SCRATCH_ROOT doesn't): the app log is lost when
    // `safeRmSync` runs, which is when a failure most needs it.
    if (existsSync(appLogFile)) {
      try {
        copyFileSync(appLogFile, path.join(SHOT_DIR, 'app.log'));
      } catch {
        /* best-effort */
      }
    }
    await safeRmSync(SCRATCH_ROOT, 'verify-891');
  }

  // Can't simulate a stalled `git worktree list` (RegistrationState::Unknown, worktree_delete.rs) or an
  // undetectable holder; both are code-reviewed only.
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
