#!/usr/bin/env node
// Live CDP check for issue #464 (spec 018 slice 1: Git changes panel, right-pane rail entry
// `'git-changes'`). Structural template: `verify-554-chat-width.mjs`. Shared scratch/launch
// helpers: `verify-tauri-scratch-helpers.mjs`. Panel-specific git-plumbing/CDP helpers split into
// `verify-464-git-changes-helpers.mjs` to stay under `check-file-size.mjs`'s 600-line soft cap.
//
// Precedent check (explicitly asked for in this script's brief): `verify-991-stage-focus.mjs`/
// `verify-1001-stage-focus-join.mjs` are NOT relevant precedent despite the name -- their "Stage"
// is the chat transcript's Subagent disclosure row (`StageGroupRow`), an unrelated UI concept; a
// red herring for this panel's git stage/unstage. Nothing from either file is reused here.
//
// Isolation posture: a scratch `REFRACT_DATA_DIR`/worktree/repo, same as every `verify-tauri-5xx+`
// script -- never touches Stuart's real Session list.
//
// AGENTS.md destructive-ops rule, honoured throughout (also followed by every helper this script
// calls): every deleted path is either a literal, freshly-`mkdtempSync`'d directory under the OS
// temp dir, or routed through `safeRmSync`'s own guard (realpath-checked against the temp dir).
// Never a bare drive letter, `.`, `..`, `~`, or a path built from an unset/default-valued variable.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-464-git-changes.mjs (requires a prior `pnpm tauri build --debug --no-bundle`).
//
// Checks exercised (see the brief's own numbered list for full detail); honestly-flagged gaps:
//   - FR-012's inline "Agent is working -- review before committing" banner is NOT exercised:
//     reaching a real `working` session status needs sending a real prompt to the real agent,
//     which this script deliberately never does (no model tokens spent, matching every other
//     `verify-5xx+` script's own posture) -- recorded in `notExercised`, not silently skipped.
//   - Ahead/behind (FR-014): grounded in `worktrees.rs`'s own `git branch -- <candidate>
//     <base_branch>` (no `--track`), a freshly created Session branch carries NO upstream
//     tracking at all in this scratch, remote-less repo -- so `ahead_behind` is correctly
//     `None`/omitted here, not a populated figure this script could honestly produce without
//     fabricating an upstream that would not exist for a real local Session either. Checked as
//     "correctly absent", both via the real IPC response and the rendered DOM, not assumed.
//   - Containment refusal: NOT independently reachable via the real UI at all (paths only ever
//     come from the panel's own already-validated snapshot, `git-changes-store.ts`) -- exercised
//     by calling `window.refract.gitChanges.*` directly via CDP `Runtime.evaluate` instead, the
//     same real-IPC-bridge-bypassing-the-UI precedent `verify-926-attach-any-file.mjs` already
//     established for `window.refract.attachments`. A Rust-side `validate_pathspec` gate
//     (`src-tauri/src/git/pathspec.rs`, added 2026-10-20) now refuses an absolute/outside-
//     worktree path before it ever reaches a `git` subprocess, wire code `outside-worktree`.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget,
  citeScreenshots,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import {
  runGit,
  FIXTURE,
  commitRepoBaseline,
  buildScratchWorkingTree,
  clickRowMenuItem,
  clickBulkAction,
  fileRowOpenButtonFinder,
  readGroupSummaries,
  readGroupFileTitles,
  diffViewText,
  BACK_TO_CHANGES_FINDER,
  pressCtrlEnter,
  clearField,
  typeIntoField,
  SUBJECT_FINDER,
  BODY_FINDER,
  readCommitButtonState,
  COMMIT_BUTTON_FINDER,
  collectTabTrail,
  assertTabSubsequence,
  assertArrayEqual,
  assertEqual
} from './verify-464-git-changes-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_464_SHOTS_DIR || path.join(tmpdir(), 'refract-464-git-changes-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Every built-in preset (`src/shared/themes.ts`), the same "all five literally" convention
// `verify-997-notice-severity.mjs` already uses for this panel's own scope of "no obvious broken
// state" (never the abbreviated Dark/Obsidian stand-in pair).
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const CONFLICTS_TRIGGER_FINDER = `Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Conflicts, '))`;

// Ties the exe under test to the actual commit (never a reused, possibly sibling-lane-clobbered
// exe) -- a string present only because this story's own `GitCommitBox.tsx` exists.
function assertBundleContainsIssue464Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsIssue464Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const marker = 'Agent is working -- review before committing';
  const found = readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes(marker));
  if (!found) throw new Error(`assertBundleContainsIssue464Marker: marker ${JSON.stringify(marker)} not found in any built renderer asset -- this build does not contain issue #464's Git changes panel code.`);
  console.log(`verify-464: confirmed #464-only marker ${JSON.stringify(marker)} present in the built renderer bundle.`);
}

function gitLogField(worktreePath, pretty) {
  return execFileSync('git', ['-C', worktreePath, 'log', '-1', `--pretty=${pretty}`], { encoding: 'utf8', windowsHide: true }).toString().trim();
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir, outsideDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  const screenshotNames = [];

  async function shot(name) {
    await cdp.screenshot(path.join(SHOTS_DIR, name));
    screenshotNames.push(name);
  }

  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-464-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-464-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-464-repo-')), 'verify-464-git-changes');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-464-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-464-launcher-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'refract-464-outside-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    console.log(`verify-464: git HEAD ${gitHeadSha}`);
    console.log(`verify-464: shots dir ${SHOTS_DIR}`);

    commitRepoBaseline(repoDir);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-464' });
    assertBundleContainsIssue464Marker();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-464: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-464');

    // ---- Add the scratch repo, create a Session, read its real worktreePath/branch. ----
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });

    const sessionInfo = await cdp.waitFor(
      `window.refract.sessions.list().then((r) => { if (!r.ok || !r.value[0]) return null; const s = r.value[0]; return { id: s.id, worktreePath: s.worktreePath, branch: s.branch, baseBranch: s.baseBranch }; })`,
      { timeoutMs: 15_000, label: 'Session registered (id/worktreePath/branch/baseBranch readable)' }
    );
    const { id: sessionId, worktreePath, branch: sessionBranch, baseBranch } = sessionInfo;
    assertEqual(baseBranch, 'main', 'Session baseBranch', findings, failures);
    findings.push(`Session created: id=${sessionId}, branch=${sessionBranch}, worktreePath=${worktreePath} (a real \`git worktree add\` checkout, distinct from repoDir -- confirmed non-equal: ${worktreePath !== repoDir}).`);

    // ---- Build the realistic, mixed working tree in the SESSION'S OWN worktree. ----
    buildScratchWorkingTree(worktreePath);
    findings.push('Scratch working tree built: a real failed merge (Conflicts), a git-add-staged new file (Staged), a modified tracked file + a deleted tracked file (Changes), and an untracked file (Untracked).');

    // ---- Open the Git changes panel. ----
    await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
    await cdp.waitFor(`!!(${CONFLICTS_TRIGGER_FINDER})`, { timeoutMs: 20_000, label: 'Git changes panel loaded (Conflicts group rendered)' });

    // ---- Check 1: all four groups render with correct counts and the right files. ----
    const summaries0 = await readGroupSummaries(cdp);
    assertArrayEqual(
      summaries0,
      [
        { name: 'Conflicts', count: 1 },
        { name: 'Staged', count: 1 },
        { name: 'Changes', count: 2 },
        { name: 'Untracked', count: 1 }
      ],
      'Initial group summaries (FR-002 order, counts)',
      findings,
      failures
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Conflicts'), [FIXTURE.conflict], 'Conflicts files', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.stagedNew], 'Staged files', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Changes'), [FIXTURE.readme, FIXTURE.deletedTracked], 'Changes files', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.untracked], 'Untracked files', findings, failures);
    await shot('01-initial-groups.png');

    // ---- Check 2 (FR-014 header): branch/base render; ahead/behind correctly OMITTED (no
    // upstream exists for a freshly created local Session branch -- see this file's own header
    // comment). Grounded against the real IPC response, not just the DOM. ----
    const listResult = await cdp.evaluate(`window.refract.gitChanges.list(${JSON.stringify(sessionId)})`);
    if (!listResult.ok || !listResult.value.snapshot) {
      failures.push(`gitChanges.list(${sessionId}) did not return a snapshot: ${JSON.stringify(listResult)}`);
    } else {
      assertEqual(listResult.value.snapshot.header.branch, sessionBranch, 'Header branch (IPC)', findings, failures);
      assertEqual(listResult.value.snapshot.header.baseBranch, 'main', 'Header baseBranch (IPC)', findings, failures);
      assertEqual(listResult.value.snapshot.header.aheadBehind, null, 'Header aheadBehind (IPC, no upstream on a fresh local branch)', findings, failures);
    }
    const headerText = await cdp.evaluate(`document.querySelector('span[title=${JSON.stringify(sessionBranch)}]')?.closest('div')?.textContent ?? null`);
    if (!headerText || !headerText.includes(sessionBranch) || !headerText.includes('from main')) {
      failures.push(`Header text did not render branch "${sessionBranch}" and "from main": ${JSON.stringify(headerText)}`);
    } else if (headerText.includes(' ahead, ')) {
      failures.push(`Header text rendered an ahead/behind figure despite no upstream existing: ${JSON.stringify(headerText)}`);
    } else {
      findings.push(`Header renders "${headerText}" -- branch + base shown, ahead/behind correctly omitted.`);
    }

    // ---- Check 3: Open diff on an UNSTAGED modified file (README.md, staged=false) via a real
    // row click -- real added line content from a real file, never simulated. ----
    await cdp.click(fileRowOpenButtonFinder(FIXTURE.readme));
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for README.md' });
    const readmeDiffText = await diffViewText(cdp);
    if (!readmeDiffText || !readmeDiffText.includes(FIXTURE.readmeEditedLine)) {
      failures.push(`Diff view for README.md did not show the real added line "${FIXTURE.readmeEditedLine}": ${JSON.stringify(readmeDiffText)}`);
    } else {
      findings.push('Diff view for README.md (unstaged, staged=false branch) shows the real added line.');
    }
    await shot('02-diff-readme-unstaged.png');
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes returned to the groups list' });

    // ---- Check 4: Open diff on a STAGED file (staged-new-file.txt, staged=true) via the
    // explicit "Open diff" menu item -- `git diff --cached` branch: a plain unstaged `git diff`
    // on a newly-added, never-before-committed path shows NOTHING, so real content here proves
    // the `staged` flag genuinely reached `diff_text`, not just that SOME diff rendered. ----
    await clickRowMenuItem(cdp, FIXTURE.stagedNew, 'Open diff');
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for staged-new-file.txt' });
    const stagedDiffText = await diffViewText(cdp);
    if (!stagedDiffText || !stagedDiffText.includes(FIXTURE.stagedNewContentLine) || stagedDiffText.includes('No changes')) {
      failures.push(`Diff view for staged-new-file.txt (staged=true) did not show its real added content: ${JSON.stringify(stagedDiffText)}`);
    } else {
      findings.push('Diff view for staged-new-file.txt (staged, staged=true branch via "Open diff" menu item) shows its real added content -- confirms --cached was really used.');
    }
    await shot('03-diff-staged-new-file.png');
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes (2nd time)' });

    // ---- Check 5: per-file Stage then Unstage round trip (untracked-file.txt), ends back at
    // the original grouping. ----
    await clickRowMenuItem(cdp, FIXTURE.untracked, 'Stage');
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 2'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Untracked -> Staged (Staged, 2)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.stagedNew, FIXTURE.untracked], 'Staged files after per-file stage', findings, failures);
    const untrackedGoneAfterStage = await cdp.evaluate(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`);
    assertEqual(untrackedGoneAfterStage, true, 'Untracked group gone after staging its only file', findings, failures);
    await clickRowMenuItem(cdp, FIXTURE.untracked, 'Unstage');
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Staged -> Untracked (Staged, 1)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.untracked], 'Untracked files after per-file unstage round trip', findings, failures);
    findings.push('Per-file Stage then Unstage round trip on untracked-file.txt returned the panel to its original grouping.');

    // ---- Check 6: bulk Stage all (Untracked, then Changes) -- every eligible file moves,
    // Conflicts untouched and offers NO bulk action at all. ----
    const conflictsHasNoBulk = await cdp.evaluate(`!document.querySelector('[aria-label="Stage all in Conflicts"]') && !document.querySelector('[aria-label="Unstage all in Conflicts"]')`);
    assertEqual(conflictsHasNoBulk, true, 'Conflicts group offers no bulk action at all', findings, failures);
    await clickBulkAction(cdp, 'Stage all in Untracked');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`, { timeoutMs: 15_000, label: 'Untracked group gone after Stage all' });
    await clickBulkAction(cdp, 'Stage all in Changes');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Changes, '))`, { timeoutMs: 15_000, label: 'Changes group gone after Stage all' });
    assertArrayEqual(
      await readGroupFileTitles(cdp, 'Staged'),
      [FIXTURE.readme, FIXTURE.deletedTracked, FIXTURE.stagedNew, FIXTURE.untracked],
      'Staged files after both bulk Stage-all actions (alphabetical across the whole group)',
      findings,
      failures
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Conflicts'), [FIXTURE.conflict], 'Conflicts untouched by either bulk Stage-all', findings, failures);
    await shot('04-after-stage-all.png');

    // ---- Check 7: bulk Unstage all -- Staged group gone; files redistribute by real git
    // semantics (a never-committed path returns to Untracked, a tracked path returns to
    // Changes), Conflicts still untouched. ----
    await clickBulkAction(cdp, 'Unstage all in Staged');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after Unstage all' });
    assertArrayEqual(await readGroupFileTitles(cdp, 'Changes'), [FIXTURE.readme, FIXTURE.deletedTracked], 'Changes files after Unstage all (tracked paths return here)', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.stagedNew, FIXTURE.untracked], 'Untracked files after Unstage all (never-committed paths return here)', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Conflicts'), [FIXTURE.conflict], 'Conflicts untouched by Unstage all', findings, failures);
    await shot('05-after-unstage-all.png');

    // ---- Check 8: Commit button disabled-with-reason states, read via real CDP DOM reads. ----
    let commitState = await readCommitButtonState(cdp);
    assertEqual(commitState?.disabled, true, 'Commit disabled with 0 staged (no message yet)', findings, failures);
    assertEqual(commitState?.reasonText, 'Nothing staged', 'Commit disabled reason with 0 staged (no message yet)', findings, failures);
    assertEqual(commitState?.title, 'Nothing staged', 'Commit title attribute with 0 staged (no message yet)', findings, failures);
    await typeIntoField(cdp, SUBJECT_FINDER, 'A message that should not matter yet');
    commitState = await readCommitButtonState(cdp);
    assertEqual(commitState?.reasonText, 'Nothing staged', '"Nothing staged" still wins over a typed message when 0 staged (priority order)', findings, failures);
    await clearField(cdp, SUBJECT_FINDER);
    await shot('06-commit-box-disabled-nothing-staged.png');

    await clickBulkAction(cdp, 'Stage all in Changes');
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 2'; })()`, { timeoutMs: 15_000, label: 'Staged, 2 after re-staging Changes' });
    commitState = await readCommitButtonState(cdp);
    assertEqual(commitState?.disabled, true, 'Commit disabled with staged files but no message', findings, failures);
    assertEqual(commitState?.reasonText, 'Write a message', 'Commit disabled reason with staged files but no message', findings, failures);
    await shot('07-commit-box-disabled-write-message.png');

    const ctrlEnterSubject = 'Commit via Ctrl+Enter (verify-464)';
    const ctrlEnterBody = 'Body composed for the Ctrl+Enter commit path.';
    await typeIntoField(cdp, SUBJECT_FINDER, ctrlEnterSubject);
    await typeIntoField(cdp, BODY_FINDER, ctrlEnterBody);
    commitState = await readCommitButtonState(cdp);
    assertEqual(commitState?.disabled, false, 'Commit enabled once staged AND message are both true', findings, failures);
    assertEqual(commitState?.title, null, 'Commit title attribute absent once enabled', findings, failures);
    await shot('08-commit-box-enabled.png');

    // ---- Check 9: keyboard Tab order reaches every interactive element (group headers, bulk
    // actions, file rows via their kebab, commit box), in the correct relative order; a bulk
    // action's real computed accessible name includes its group's name. State here: Conflicts=1,
    // Staged=2 (README.md, src/example.txt), Untracked=2 (staged-new-file.txt, untracked-file.txt). ----
    const tabTrail = await collectTabTrail(cdp, CONFLICTS_TRIGGER_FINDER, 'Commit');
    assertTabSubsequence(
      tabTrail,
      [
        'Staged, 2',
        'Unstage all in Staged',
        `More actions for ${FIXTURE.readme}`,
        `More actions for ${FIXTURE.deletedTracked}`,
        'Untracked, 2',
        'Stage all in Untracked',
        `More actions for ${FIXTURE.stagedNew}`,
        `More actions for ${FIXTURE.untracked}`,
        'Commit subject',
        'Commit description',
        'Commit'
      ],
      'Tab order (group headers / bulk actions, named with their group / file rows via kebab / commit box)',
      findings,
      failures
    );

    // Script fixture fix (falsified against a real throwaway repo before changing anything:
    // `git commit` genuinely refuses ANY commit -- even of unrelated already-staged files --
    // while an unmerged path exists anywhere in the index; "error: Committing is not possible
    // because you have unmerged files" is git's own message, not a Refract bug). The Conflicts-
    // group assertions (checks 6/7/9 above) are already done with `conflict.txt` by this point,
    // so it is resolved here -- keeping the worktree's own side (`FIXTURE`'s own "worktree
    // change" content) and staging it -- the same way a developer would actually finish this
    // merge, so the commit checks below can exercise a REAL commit instead of a precondition
    // `git` itself would always refuse regardless of anything this panel does.
    writeFileSync(path.join(worktreePath, FIXTURE.conflict), 'worktree change\n');
    runGit(worktreePath, ['add', '--', FIXTURE.conflict]);

    // ---- Check 10: commit via a REAL Ctrl+Enter keypress (not a button click) -- verified via
    // `git log` against the scratch worktree, not just a UI state change. ----
    await pressCtrlEnter(cdp);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after Ctrl+Enter commit' });
    assertEqual(gitLogField(worktreePath, '%s'), ctrlEnterSubject, 'git log subject after Ctrl+Enter commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), ctrlEnterBody, 'git log body after Ctrl+Enter commit', findings, failures);
    const subjectClearedAfterCommit = await cdp.evaluate(`${SUBJECT_FINDER}?.value ?? null`);
    assertEqual(subjectClearedAfterCommit, '', 'Subject field cleared after a successful commit', findings, failures);
    await shot('09-post-ctrl-enter-commit.png');

    // ---- Check 11: commit via the REAL Commit button click (confirming the button path
    // separately from the keyboard path) -- second real `git log` entry, subject+body format. ----
    await clickRowMenuItem(cdp, FIXTURE.stagedNew, 'Stage');
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`, { timeoutMs: 15_000, label: 'staged-new-file.txt staged for the button-commit check' });
    const buttonCommitSubject = 'Commit via the real button (verify-464)';
    const buttonCommitBody = 'Body composed for the button-click commit path.';
    await typeIntoField(cdp, SUBJECT_FINDER, buttonCommitSubject);
    await typeIntoField(cdp, BODY_FINDER, buttonCommitBody);
    await cdp.click(COMMIT_BUTTON_FINDER);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after button-click commit' });
    assertEqual(gitLogField(worktreePath, '%s'), buttonCommitSubject, 'git log subject after button-click commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), buttonCommitBody, 'git log body after button-click commit', findings, failures);
    await shot('10-post-button-commit.png');

    // ---- Check 12 (FR-015b): an external file-system change (written from Node, outside any UI
    // action) triggers the panel to refresh, within a reasonable wait -- polled via `cdp.waitFor`,
    // never a fixed sleep. `fs/watch.rs`'s own debounce is 200ms (`WATCH_DEBOUNCE_MS`); this
    // polls up to 10s. ----
    writeFileSync(path.join(worktreePath, FIXTURE.externalChange), 'added from outside the UI\n');
    await cdp.waitFor(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; return Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.externalChange)}); })()`,
      { timeoutMs: 10_000, label: 'External fs-watcher-driven refresh showed the new untracked file (FR-015b, past the 200ms debounce)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.externalChange, FIXTURE.untracked], 'Untracked files after an external fs change', findings, failures);
    await shot('11-external-change-refresh.png');

    // ---- Check 13: containment refusal, via the real IPC bridge directly (no UI path exists --
    // see this file's own header comment). 2026-10-20 update: a Rust-side `validate_pathspec`
    // gate (`src-tauri/src/git/pathspec.rs`) now refuses an absolute/outside-worktree path
    // BEFORE it ever reaches a `git` subprocess, wire code `outside-worktree` -- stronger than
    // relying on git's own "is outside repository" pathspec refusal (`git-failed`), which this
    // check used to expect. ----
    const outsideMarkerFile = path.join(outsideDir, 'outside-worktree-marker.txt');
    writeFileSync(outsideMarkerFile, 'this must never be reachable from inside the worktree\n');
    const diffAttempt = await cdp.evaluate(
      `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(outsideMarkerFile)}, false).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message }))`
    );
    if (diffAttempt.ok) failures.push(`Containment refusal: gitChanges.diff against an absolute path outside the worktree (${outsideMarkerFile}) SUCCEEDED -- must always be refused.`);
    else if (diffAttempt.code !== 'outside-worktree') failures.push(`Containment refusal: gitChanges.diff refused the outside-worktree path, but with code "${diffAttempt.code}" (expected "outside-worktree", the Rust-side validate_pathspec gate) -- message: ${diffAttempt.message}`);
    else findings.push(`Containment refusal (gitChanges.diff): refused with code "outside-worktree" (${diffAttempt.message}).`);
    const stageAttempt = await cdp.evaluate(
      `window.refract.gitChanges.stage(${JSON.stringify(sessionId)}, [${JSON.stringify(outsideMarkerFile)}]).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message }))`
    );
    if (stageAttempt.ok) failures.push(`Containment refusal: gitChanges.stage against an absolute path outside the worktree (${outsideMarkerFile}) SUCCEEDED -- must always be refused.`);
    else if (stageAttempt.code !== 'outside-worktree') failures.push(`Containment refusal: gitChanges.stage refused the outside-worktree path, but with code "${stageAttempt.code}" -- message: ${stageAttempt.message}`);
    else findings.push(`Containment refusal (gitChanges.stage): refused with code "outside-worktree" (${stageAttempt.message}).`);
    const outsideMarkerUnchanged = readFileSync(outsideMarkerFile, 'utf8') === 'this must never be reachable from inside the worktree\n';
    assertEqual(outsideMarkerUnchanged, true, 'Outside-worktree marker file untouched after both refused attempts', findings, failures);

    notExercised.push('FR-012 "Agent is working -- review before committing" inline banner: not exercised -- reaching a real `working` Session status needs a real prompt sent to the real agent, which this script deliberately never does.');

    // ---- Check 14: all 5 themes render the panel with no obvious broken state. Expected
    // summaries here: Conflicts (and every other group) is gone -- conflict.txt was resolved and
    // committed along with everything else by checks 10/11's own two real commits -- only
    // Untracked remains (external-change.txt from check 12, untracked-file.txt never re-staged
    // since check 7's Unstage all). ----
    const expectedSummariesAfterCommits = [{ name: 'Untracked', count: 2 }];
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const summaries = await readGroupSummaries(cdp);
      if (JSON.stringify(summaries) !== JSON.stringify(expectedSummariesAfterCommits)) {
        failures.push(`Theme ${theme.name}: group summaries changed unexpectedly: ${JSON.stringify(summaries)}`);
      }
      const subjectPresent = await cdp.evaluate(`!!${SUBJECT_FINDER}`);
      if (!subjectPresent) failures.push(`Theme ${theme.name}: Commit subject input missing -- panel appears broken under this theme.`);
      const shotName = `12-theme-${theme.id}.png`;
      await shot(shotName);
      findings.push(`Theme ${theme.name}: panel rendered with groups and commit box intact.`);
    }

    const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      sessionId,
      worktreePath,
      findings,
      failures,
      notExercised,
      screenshots: citeScreenshots(SHOTS_DIR, screenshotNames),
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-464: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-464: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-464: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-464: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-464: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
    await safeRmSync(outsideDir);
  }
}

main().catch((err) => {
  console.error('verify-464: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
