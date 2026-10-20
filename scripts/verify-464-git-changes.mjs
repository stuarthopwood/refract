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
//     `None`/omitted, not a figure this script could honestly produce without fabricating an
//     upstream. Checked as "correctly absent", via the real IPC response and the DOM.
//   - Containment refusal: NOT independently reachable via the real UI (paths only ever come
//     from the panel's own already-validated snapshot) -- exercised by calling
//     `window.refract.gitChanges.*` directly via CDP `Runtime.evaluate` instead, the same
//     real-IPC-bridge-bypassing-the-UI precedent `verify-926-attach-any-file.mjs` already
//     established. A Rust-side `validate_pathspec` gate (`src-tauri/src/git/pathspec.rs`) now
//     refuses an absolute/outside-worktree path before it ever reaches a `git` subprocess.
//
// Gate round 1 live-check additions (2026-10-20), threaded into the checks above rather than
// bolted on at the end (each proof sits right next to the real user action it proves):
//   - Focus restoration (`focus.ts`): `document.activeElement` read immediately after each real
//     action that should move focus -- open diff / Back / Escape / per-file Stage / per-file
//     Unstage / bulk Stage-all / a successful commit (subject input + its sr-only announcement).
//   - Readout-chip proof: a real `window.refract.onReadoutUpdate` listener, registered before any
//     mutating action, proves a fresh event for THIS Session arrives after a real commit
//     (`schedule_readout_update`, gate round 1 item 13) -- never asserts `readout.changes`
//     ITSELF differs (an ordinary commit of already-tracked content provably does not).
//   - Check 14 (external fs change) tightened to 1.5s: the old ~2.2s liveness-ping fallback no
//     longer exists for this watcher at all -- a pass this tight only happens if fs-watcher fired.
//   - Checks 15/16: a partially-staged (`MM`) fixture and a literal-bracket-filename fixture, each
//     built and FULLY TORN DOWN within their own check so neither perturbs any other check's own
//     group-count expectations (Check 18's theme loop in particular).
//   - Checks 10/11: commit's own "Resolve conflicts first" priority (over staged files AND a
//     typed message) and the Conflicts row's "Mark as resolved" confirm-then-stage dialog, both
//     run BEFORE the conflict is actually resolved (moved earlier than the original fixture-fix
//     step, which now runs after them).

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
import { addRepository, pressEscape } from './verify-tauri-session-list-helpers.mjs';
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
  CONFLICTS_TRIGGER_FINDER,
  pressCtrlEnter,
  typeIntoField,
  SUBJECT_FINDER,
  BODY_FINDER,
  readCommitButtonState,
  COMMIT_BUTTON_FINDER,
  collectTabTrail,
  assertTabSubsequence,
  assertArrayEqual,
  assertEqual,
  activeElementIs,
  activeElementText,
  activeElementRowPath,
  activeElementGroupTrigger,
  readCommitAnnouncementText,
  runCommitDisabledReasonCheck,
  runMarkAsResolvedCheck,
  runPartialStagedDualGroupingCheck,
  runBracketLiteralPathCheck,
  runContainmentRefusalCheck
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

// Ties the exe under test to the actual commit (never a reused, possibly sibling-lane-clobbered
// exe) -- a string present only because this story's own `GitCommitBox.tsx` exists. Pre-existing
// bug fixed (2026-10-20, unrelated to the 7 new assertion groups): this used a plain ASCII
// double-hyphen, but the real JSX text renders an em dash (U+2014, confirmed byte-for-byte
// against the built `main-*.js` chunk) -- the old marker could never match any real build.
function assertBundleContainsIssue464Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsIssue464Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const marker = 'Agent is working \u2014 review before committing';
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

    // ---- Readout-chip listener (item 2): registered before ANY mutating action, so every
    // commit below (Checks 12/13) can prove a fresh `readout:update` event arrives for THIS
    // Session (`session::readout::schedule_readout_update`'s gate round 1 item 13 wiring,
    // `ipc/git_changes.rs`) -- independent of whether `readout.changes` itself differs (it
    // provably does not for an ordinary commit of already-tracked content, see this file's own
    // header comment). `readout:update` only ever reaches a VISIBLE Session (`agent.is_visible()`,
    // `App.tsx`'s own `paneSessionIds`-driven `sessions.setVisible` call) -- set explicitly here,
    // not trusting this never-clicked-into Session to already be front-of-pane. ----
    await cdp.evaluate(`window.refract.sessions.setVisible([${JSON.stringify(sessionId)}])`);
    await cdp.evaluate(
      `(() => { window.__verify464ReadoutEvents = []; window.refract.onReadoutUpdate((payload) => { window.__verify464ReadoutEvents.push(payload); }); return true; })()`
    );

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
    // Item 7 focus restoration: opening a diff focuses the "Back to changes" button.
    assertEqual(await activeElementText(cdp), 'Back to changes', 'Focus after opening README.md diff: the "Back to changes" button', findings, failures);
    const readmeDiffText = await diffViewText(cdp);
    if (!readmeDiffText || !readmeDiffText.includes(FIXTURE.readmeEditedLine)) {
      failures.push(`Diff view for README.md did not show the real added line "${FIXTURE.readmeEditedLine}": ${JSON.stringify(readmeDiffText)}`);
    } else {
      findings.push('Diff view for README.md (unstaged, staged=false branch) shows the real added line.');
    }
    await shot('02-diff-readme-unstaged.png');
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes returned to the groups list' });
    // Item 7 focus restoration: clicking "Back to changes" focuses the SAME row that opened it.
    assertEqual(await activeElementRowPath(cdp), FIXTURE.readme, 'Focus after clicking "Back to changes": returns to the row that opened it (README.md)', findings, failures);

    // ---- Check 4: Open diff on a STAGED file (staged-new-file.txt, staged=true) via the
    // explicit "Open diff" menu item -- `git diff --cached` branch: a plain unstaged `git diff`
    // on a newly-added, never-before-committed path shows NOTHING, so real content here proves
    // the `staged` flag genuinely reached `diff_text`, not just that SOME diff rendered. ----
    await clickRowMenuItem(cdp, FIXTURE.stagedNew, `Open diff for ${FIXTURE.stagedNew}`);
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for staged-new-file.txt' });
    assertEqual(await activeElementText(cdp), 'Back to changes', 'Focus after opening staged-new-file.txt diff: the "Back to changes" button', findings, failures);
    const stagedDiffText = await diffViewText(cdp);
    if (!stagedDiffText || !stagedDiffText.includes(FIXTURE.stagedNewContentLine) || stagedDiffText.includes('No changes')) {
      failures.push(`Diff view for staged-new-file.txt (staged=true) did not show its real added content: ${JSON.stringify(stagedDiffText)}`);
    } else {
      findings.push('Diff view for staged-new-file.txt (staged, staged=true branch via "Open diff" menu item) shows its real added content -- confirms --cached was really used.');
    }
    await shot('03-diff-staged-new-file.png');
    // Item 7 focus restoration, the OTHER return path: a real Escape keypress (never a click)
    // while the diff pane's own "Back to changes" button is focused closes it exactly like the
    // explicit button -- `GitChangesDiffPane`'s own `onKeyDown` handler.
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes (2nd time, via Escape)' });
    assertEqual(await activeElementRowPath(cdp), FIXTURE.stagedNew, 'Focus after Escape: returns to the row that opened it (staged-new-file.txt)', findings, failures);

    // ---- Check 5: per-file Stage then Unstage round trip (untracked-file.txt), ends back at
    // the original grouping. ----
    await clickRowMenuItem(cdp, FIXTURE.untracked, `Stage ${FIXTURE.untracked}`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 2'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Untracked -> Staged (Staged, 2)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.stagedNew, FIXTURE.untracked], 'Staged files after per-file stage', findings, failures);
    // Item 7 focus restoration: staging via the kebab's "Stage" item focuses the SAME row again,
    // now rendered under its new group.
    assertEqual(await activeElementRowPath(cdp), FIXTURE.untracked, 'Focus after per-file Stage: the same row, now in Staged', findings, failures);
    const untrackedGoneAfterStage = await cdp.evaluate(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`);
    assertEqual(untrackedGoneAfterStage, true, 'Untracked group gone after staging its only file', findings, failures);
    await clickRowMenuItem(cdp, FIXTURE.untracked, `Unstage ${FIXTURE.untracked}`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Staged -> Untracked (Staged, 1)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.untracked], 'Untracked files after per-file unstage round trip', findings, failures);
    // Item 7 focus restoration, the other direction: unstaging focuses the same row again too.
    assertEqual(await activeElementRowPath(cdp), FIXTURE.untracked, 'Focus after per-file Unstage: the same row, back in Untracked', findings, failures);
    findings.push('Per-file Stage then Unstage round trip on untracked-file.txt returned the panel to its original grouping.');

    // ---- Check 6: bulk Stage all (Untracked, then Changes) -- every eligible file moves,
    // Conflicts untouched and offers NO bulk action at all. ----
    const conflictsHasNoBulk = await cdp.evaluate(`!document.querySelector('[aria-label="Stage all in Conflicts"]') && !document.querySelector('[aria-label="Unstage all in Conflicts"]')`);
    assertEqual(conflictsHasNoBulk, true, 'Conflicts group offers no bulk action at all', findings, failures);
    await clickBulkAction(cdp, 'Stage all in Untracked');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`, { timeoutMs: 15_000, label: 'Untracked group gone after Stage all' });
    // Item 7 focus restoration: a bulk "Stage all" focuses the NEXT group's own trigger (walking
    // Conflicts/Staged/Changes/Untracked forward from 'untracked', wrapping) -- deterministically
    // Conflicts here, the only other group currently rendered (and it still has its own entry).
    assertEqual(await activeElementGroupTrigger(cdp), 'conflicts', 'Focus after "Stage all in Untracked": the next rendered group\'s own trigger (Conflicts)', findings, failures);
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

    // ---- Check 8: Commit button disabled-with-reason states, read via real CDP DOM reads (full
    // detail in the helper's own doc comment -- moved out of this file to stay under the
    // 600-line soft cap, #806). Leaves the panel staged with a typed message, enabled. ----
    const { ctrlEnterSubject, ctrlEnterBody } = await runCommitDisabledReasonCheck(cdp, shot, findings, failures);

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

    // ---- Check 10 (item 6): commit is blocked with "Resolve conflicts first" while conflict.txt
    // is still genuinely unresolved -- even with files already staged (Staged, 2: README.md,
    // src/example.txt) and a message already typed (ctrlEnterSubject/ctrlEnterBody, both set by
    // Check 8 above) -- proves the priority order `GitCommitBox.tsx`'s own `disabledReason`
    // documents: a conflict beats BOTH "Nothing staged" and "Write a message". ----
    const conflictBlockedState = await readCommitButtonState(cdp);
    assertEqual(conflictBlockedState?.disabled, true, 'Commit disabled while conflict.txt is still unresolved (staged files + a message both already present)', findings, failures);
    assertEqual(conflictBlockedState?.reasonText, 'Resolve conflicts first', 'Commit disabled reason while a conflict is unresolved (priority over "Nothing staged"/"Write a message")', findings, failures);
    assertEqual(conflictBlockedState?.title, 'Resolve conflicts first', 'Commit title attribute while a conflict is unresolved', findings, failures);
    await shot('09-commit-box-disabled-resolve-conflicts.png');

    // ---- Check 11 (item 7): the Conflicts row's own "Mark as resolved" kebab item confirms
    // first -- clicking it only OPENS a confirmation dialog; the real `stage()` call happens
    // only once the dialog's own "Mark as resolved" action is clicked. Both halves grounded in
    // REAL `git status --porcelain`, not just the DOM (full detail in the helper's own doc
    // comment -- moved out of this file to stay under the 600-line soft cap, #806). ----
    await runMarkAsResolvedCheck(cdp, worktreePath, FIXTURE.conflict, shot, findings, failures);

    // Script fixture fix (falsified against a real throwaway repo before changing anything:
    // `git commit` genuinely refuses ANY commit -- even of unrelated already-staged files --
    // while an unmerged path exists anywhere in the index; "error: Committing is not possible
    // because you have unmerged files" is git's own message, not a Refract bug). Check 11 above
    // already resolved conflict.txt for real via the panel's own "Mark as resolved" UI flow (a
    // real `git add`, confirmed via `git status --porcelain`) -- but its staged content still
    // carries the literal conflict markers the dialog warned about (the worktree never actually
    // finished the merge). Overwritten here with the fixture's own clean "worktree change"
    // content and re-added, the same way a developer would actually finish this merge, so the
    // commit checks below produce a REAL, clean commit rather than one literally containing
    // `<<<<<<<`/`=======`/`>>>>>>>` text (this also happens to make conflict.txt's own staged
    // diff empty again, since its content now matches HEAD exactly -- harmless: it simply drops
    // back out of the Staged group, and Check 12 below only ever relied on "Staged, 2").
    writeFileSync(path.join(worktreePath, FIXTURE.conflict), 'worktree change\n');
    runGit(worktreePath, ['add', '--', FIXTURE.conflict]);

    // ---- Check 12: commit via a REAL Ctrl+Enter keypress (not a button click) -- verified via
    // `git log` against the scratch worktree. A real click into the subject field first:
    // `handleKeyDown` is per-field, not wherever Check 11's dialog last left focus -- the real
    // shortcut only fires from inside a composer field, same as a real user. ----
    await cdp.click(SUBJECT_FINDER);
    const readoutEventsBeforeCtrlEnterCommit = await cdp.evaluate(`window.__verify464ReadoutEvents.filter((e) => e.sessionId === ${JSON.stringify(sessionId)}).length`);
    await pressCtrlEnter(cdp);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after Ctrl+Enter commit' });
    assertEqual(gitLogField(worktreePath, '%s'), ctrlEnterSubject, 'git log subject after Ctrl+Enter commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), ctrlEnterBody, 'git log body after Ctrl+Enter commit', findings, failures);
    const subjectClearedAfterCommit = await cdp.evaluate(`${SUBJECT_FINDER}?.value ?? null`);
    assertEqual(subjectClearedAfterCommit, '', 'Subject field cleared after a successful commit', findings, failures);
    // Item 7 focus restoration: a successful commit focuses the Commit subject input and
    // announces it once via a (visually `sr-only`) `role="status"` element.
    assertEqual(await activeElementIs(cdp, SUBJECT_FINDER), true, 'Focus after Ctrl+Enter commit: the Commit subject input', findings, failures);
    assertEqual(await readCommitAnnouncementText(cdp), `Committed: ${ctrlEnterSubject}`, 'Commit announcement text after Ctrl+Enter commit', findings, failures);
    // Item 2: the readout chip's own `changes` figure is recomputed and re-pushed specifically
    // BECAUSE of this commit (`schedule_readout_update`, gate round 1 item 13) -- a fresh event
    // for THIS Session arrives, regardless of whether `readout.changes` itself happens to differ
    // (it provably does not for an ordinary commit of already-tracked content, see this file's
    // own header comment).
    await cdp.waitFor(
      `window.__verify464ReadoutEvents.filter((e) => e.sessionId === ${JSON.stringify(sessionId)}).length > ${readoutEventsBeforeCtrlEnterCommit}`,
      { timeoutMs: 15_000, label: 'A fresh readout:update event arrived for this Session after the Ctrl+Enter commit' }
    );
    findings.push('Readout chip: a fresh `readout:update` event for this Session arrived after the Ctrl+Enter commit (schedule_readout_update wiring, item 13).');
    await shot('12-post-ctrl-enter-commit.png');

    // ---- Check 13: commit via the REAL Commit button click (confirming the button path
    // separately from the keyboard path) -- second real `git log` entry, subject+body format. ----
    await clickRowMenuItem(cdp, FIXTURE.stagedNew, `Stage ${FIXTURE.stagedNew}`);
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`, { timeoutMs: 15_000, label: 'staged-new-file.txt staged for the button-commit check' });
    const buttonCommitSubject = 'Commit via the real button (verify-464)';
    const buttonCommitBody = 'Body composed for the button-click commit path.';
    await typeIntoField(cdp, SUBJECT_FINDER, buttonCommitSubject);
    await typeIntoField(cdp, BODY_FINDER, buttonCommitBody);
    await cdp.click(COMMIT_BUTTON_FINDER);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after button-click commit' });
    assertEqual(gitLogField(worktreePath, '%s'), buttonCommitSubject, 'git log subject after button-click commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), buttonCommitBody, 'git log body after button-click commit', findings, failures);
    assertEqual(await activeElementIs(cdp, SUBJECT_FINDER), true, 'Focus after button-click commit: the Commit subject input', findings, failures);
    assertEqual(await readCommitAnnouncementText(cdp), `Committed: ${buttonCommitSubject}`, 'Commit announcement text after button-click commit', findings, failures);
    await shot('13-post-button-commit.png');

    // ---- Check 14 (FR-015b, item 3): an external file-system change (written from Node, outside
    // any UI action) triggers the panel to refresh. Deliberately TIGHT (well under 2s): the gate
    // round 1 fix to this watcher (`watch_directory_without_liveness_requeue`,
    // `git_changes_watch_state.rs`) means the OLD ~2.2s periodic liveness-ping fallback no longer
    // exists for this watcher AT ALL -- only a real fs-watcher-detected change (200ms debounce,
    // `WATCH_DEBOUNCE_MS`), FR-015a's own status-transition trigger, or an explicit post-action
    // refetch can ever refresh this panel now. A pass against a timeout this tight is only
    // possible because the real fs-watcher path genuinely fired -- there is no slower fallback
    // left for this check to be silently passing against. ----
    writeFileSync(path.join(worktreePath, FIXTURE.externalChange), 'added from outside the UI\n');
    await cdp.waitFor(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; return Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.externalChange)}); })()`,
      { timeoutMs: 1_500, intervalMs: 100, label: 'External fs-watcher-driven refresh showed the new untracked file, within 1.5s (past the 200ms debounce, no slower fallback left to rely on)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.externalChange, FIXTURE.untracked], 'Untracked files after an external fs change', findings, failures);
    await shot('14-external-change-refresh.png');

    // ---- Check 15 (item 4): a partially staged (`MM`) file renders as TWO separate rows for the
    // SAME path -- one in Staged (scored against the index, `git diff --cached`), one in Changes
    // (scored against the worktree, plain `git diff`) -- `changes_status.rs`'s own gate round 1
    // item 5 dual-row fix. Built and torn down entirely within this one check so it never
    // perturbs any other check's own group-count expectations (Check 18's theme loop in
    // particular, which asserts a FIXED `Untracked, 2` and nothing else). ----
    // Full fixture build/assert/teardown lives in the helper (moved out of this file to stay
    // under the 600-line soft cap, #806) -- see its own doc comment for the exact fixture shape.
    await runPartialStagedDualGroupingCheck(cdp, worktreePath, shot, findings, failures);

    // ---- Check 16 (item 5): a literal bracket filename stages ONLY itself -- proves
    // `--literal-pathspecs` (gate round 1 items 9/10) protects it end-to-end, not merely that the
    // Rust code compiles. Built and torn down entirely within the helper, same posture as
    // Check 15 (moved out of this file to stay under the 600-line soft cap, #806). ----
    await runBracketLiteralPathCheck(cdp, worktreePath, shot, findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.externalChange, FIXTURE.untracked], 'Untracked back to its Check 14 state after fixture teardown', findings, failures);

    // ---- Check 17: containment refusal, via the real IPC bridge directly (no UI path exists --
    // see this file's own header comment). 2026-10-20 update: a Rust-side `validate_pathspec`
    // gate (`src-tauri/src/git/pathspec.rs`) now refuses an absolute/outside-worktree path
    // BEFORE it ever reaches a `git` subprocess, wire code `outside-worktree` -- stronger than
    // relying on git's own "is outside repository" pathspec refusal (`git-failed`), which this
    // check used to expect. ----
    const outsideMarkerFile = path.join(outsideDir, 'outside-worktree-marker.txt');
    const outsideMarkerContent = 'this must never be reachable from inside the worktree\n';
    writeFileSync(outsideMarkerFile, outsideMarkerContent);
    await runContainmentRefusalCheck(cdp, sessionId, outsideMarkerFile, outsideMarkerContent, findings, failures);

    notExercised.push('FR-012 "Agent is working -- review before committing" inline banner: not exercised -- reaching a real `working` Session status needs a real prompt sent to the real agent, which this script deliberately never does.');

    // ---- Check 18: all 5 themes render the panel with no obvious broken state. Expected
    // summaries here: Conflicts (and every other group) is gone -- conflict.txt was resolved and
    // committed along with everything else by Checks 11/12/13's own real actions -- only
    // Untracked remains (external-change.txt from Check 14, untracked-file.txt never re-staged
    // since Check 7's Unstage all); Checks 15/16's own fixtures were fully torn down above, so
    // neither perturbs this fixed expectation. ----
    const expectedSummariesAfterCommits = [{ name: 'Untracked', count: 2 }];
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const summaries = await readGroupSummaries(cdp);
      if (JSON.stringify(summaries) !== JSON.stringify(expectedSummariesAfterCommits)) {
        failures.push(`Theme ${theme.name}: group summaries changed unexpectedly: ${JSON.stringify(summaries)}`);
      }
      const subjectPresent = await cdp.evaluate(`!!${SUBJECT_FINDER}`);
      if (!subjectPresent) failures.push(`Theme ${theme.name}: Commit subject input missing -- panel appears broken under this theme.`);
      const shotName = `17-theme-${theme.id}.png`;
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
