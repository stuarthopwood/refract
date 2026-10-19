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
//
// Build/launch/CDP plumbing reused from the established `verify-tauri-*` scripts
// (`verify-tauri-scratch-helpers.mjs`, `verify-tauri-cdp.mjs`, `verify-tauri-session-list-
// helpers.mjs`, `verify-tauri-560-helpers.mjs`); the Delete-dialog driving and scratch-content
// generation are new (`verify-891-delete-leftovers-helpers.mjs`) -- no existing script touches
// this dialog.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
  spawnCwdHolder,
  spawnFileHolder,
  killSpawned,
  openDeleteDialogFor,
  waitForLeftoverSummary,
  clickDeleteButton,
  readDialogError,
  isSessionListed
} from './verify-891-delete-leftovers-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: refuses to build without the shared CARGO_TARGET_DIR, never a worktree-local target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SCRATCH_ROOT = process.env.REFRACT_891_SCRATCH_ROOT || path.join(tmpdir(), `refract-891-${STAMP}`);
const SHOT_DIR = process.env.REFRACT_891_SHOT_DIR || path.join(tmpdir(), `refract-891-shots-${STAMP}`);

const failures = [];
const notExercised = [];
function fail(label, err) {
  failures.push({ label, message: err instanceof Error ? err.message : String(err) });
  console.error(`FAIL ${label}: ${err instanceof Error ? err.message : err}`);
}
function ok(label) {
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
  const canaryDir = path.join(SCRATCH_ROOT, 'canary-outside-worktree');
  const port = await getFreePort();

  const { child, targetPid } = await launchBuiltExe(launcherExe, exePath, {
    port,
    dataDir,
    importSourceDir: path.join(SCRATCH_ROOT, 'import-unused'),
    logFile: path.join(SCRATCH_ROOT, 'app.log')
  });

  let cdp;
  const spawned = [];
  try {
    const wsUrl = await waitForCdpTarget(port);
    cdp = await CdpSession.connect(wsUrl);
    assertExeMatchesProcess(targetPid, exePath, hash);

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
    await openDeleteDialogFor(cdp, nameA);
    const summaryTextA = await waitForLeftoverSummary(cdp);
    if (summaryTextA.toLowerCase().includes('node_modules')) ok('(e) dialog shows the leftover summary (node_modules bucket present)');
    else fail('(e) dialog shows the leftover summary', new Error(`no node_modules bucket in: ${summaryTextA}`));
    await cdp.screenshot(path.join(SHOT_DIR, '01-dialog-summary.png'));
    await clickDeleteButton(cdp);
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 60_000, label: 'scenario (a) delete dialog closed' });
    const aGone = !(await isSessionListed(cdp, nameA));
    const aWorktreeGone = !existsSync(sessionA.worktreePath);
    const aCanarySurvived = existsSync(canaryFile);
    const aAdminGone = !isRegisteredWorktree(repoDir, sessionA.worktreePath);
    if (aGone && aWorktreeGone && aCanarySurvived && aAdminGone) ok('(a) full worktree with junctions/long paths/read-only deletes; canary survives; admin entry gone');
    else fail('(a) full worktree deletes cleanly', new Error(`sessionGone=${aGone} worktreeGone=${aWorktreeGone} canarySurvived=${aCanarySurvived} adminGone=${aAdminGone}`));

    // ---- Scenario (b): unregistered leftover full folder ----
    const nameB = await newSession('b');
    const sessionB = sessionByName(dataDir, nameB);
    dropAdminEntry(repoDir, sessionB.worktreePath);
    populateOrphanWorktree(sessionB.worktreePath);
    await openDeleteDialogFor(cdp, nameB);
    await waitForLeftoverSummary(cdp);
    await clickDeleteButton(cdp);
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 60_000, label: 'scenario (b) delete dialog closed' });
    const bGone = !(await isSessionListed(cdp, nameB));
    const bWorktreeGone = !existsSync(sessionB.worktreePath);
    if (bGone && bWorktreeGone) ok('(b) leftover unregistered full folder deletes');
    else fail('(b) leftover unregistered full folder deletes', new Error(`sessionGone=${bGone} worktreeGone=${bWorktreeGone}`));

    // ---- Scenario (c): a bare cmd.exe holding the folder as its own cwd ----
    const nameC = await newSession('c');
    const sessionC = sessionByName(dataDir, nameC);
    mkdirSync(sessionC.worktreePath, { recursive: true });
    const cmdHolder = spawnCwdHolder(sessionC.worktreePath);
    spawned.push(cmdHolder);
    await new Promise((r) => setTimeout(r, 300)); // let Windows finish establishing the child's own cwd
    await openDeleteDialogFor(cdp, nameC);
    await waitForLeftoverSummary(cdp);
    await clickDeleteButton(cdp);
    const errC = await readDialogError(cdp);
    await cdp.screenshot(path.join(SHOT_DIR, '02-dialog-refusal-cwd-holder.png'));
    const cRefusedCorrectly =
      !!errC && errC.toLowerCase().includes('close it') && (await isSessionListed(cdp, nameC)) && existsSync(sessionC.worktreePath);
    if (cRefusedCorrectly) ok('(c) cmd.exe cwd-holder refuses Delete with the in-use message; Session stays listed; nothing deleted');
    else fail('(c) cmd.exe cwd-holder refuses Delete', new Error(`error=${JSON.stringify(errC)} listed=${await isSessionListed(cdp, nameC)} exists=${existsSync(sessionC.worktreePath)}`));
    await killSpawned(cmdHolder);
    await clickDeleteButton(cdp); // Retry: same button
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 60_000, label: 'scenario (c) Retry delete dialog closed' });
    const cRetryGone = !(await isSessionListed(cdp, nameC)) && !existsSync(sessionC.worktreePath);
    if (cRetryGone) ok('(c) Retry succeeds once the cwd-holding process is gone');
    else fail('(c) Retry succeeds after the holder is killed', new Error(`listed=${await isSessionListed(cdp, nameC)} exists=${existsSync(sessionC.worktreePath)}`));

    // ---- Scenario (d): a PowerShell process holding one FILE open inside the worktree ----
    const nameD = await newSession('d');
    const sessionD = sessionByName(dataDir, nameD);
    mkdirSync(sessionD.worktreePath, { recursive: true });
    const heldFile = path.join(sessionD.worktreePath, 'held.txt');
    writeFileSync(heldFile, 'held open by a spawned process');
    const fileHolder = spawnFileHolder(heldFile);
    spawned.push(fileHolder);
    await new Promise((r) => setTimeout(r, 500));
    await openDeleteDialogFor(cdp, nameD);
    await waitForLeftoverSummary(cdp);
    await clickDeleteButton(cdp);
    const errD = await readDialogError(cdp);
    await cdp.screenshot(path.join(SHOT_DIR, '03-dialog-refusal-named-holder.png'));
    const dNamed = !!errD && /powershell/i.test(errD) && /process \d+/i.test(errD);
    if (dNamed) ok(`(d) spawned file-holder is named in the refusal: ${errD}`);
    else fail('(d) spawned file-holder is named in the refusal', new Error(`error=${JSON.stringify(errD)}`));
    await killSpawned(fileHolder);
    await clickDeleteButton(cdp);
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 60_000, label: 'scenario (d) Retry delete dialog closed' });
    const dRetryGone = !(await isSessionListed(cdp, nameD)) && !existsSync(sessionD.worktreePath);
    if (dRetryGone) ok('(d) Retry succeeds once the file-holding process is gone');
    else fail('(d) Retry succeeds after the holder is killed', new Error(`listed=${await isSessionListed(cdp, nameD)} exists=${existsSync(sessionD.worktreePath)}`));
  } catch (err) {
    fail('unhandled', err);
  } finally {
    for (const p of spawned) await killSpawned(p).catch(() => {});
    if (cdp) cdp.close();
    await stopLauncher(child).catch(() => {});
    await safeRmSync(SCRATCH_ROOT, 'verify-891');
  }

  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length > 0;
  const report = {
    gitHead: gitHead(REPO_ROOT),
    dirty,
    failures,
    notExercised,
    screenshots: citeScreenshots(SHOT_DIR, ['01-dialog-summary.png', '02-dialog-refusal-cwd-holder.png', '03-dialog-refusal-named-holder.png'])
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
