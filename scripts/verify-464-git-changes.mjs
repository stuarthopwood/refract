#!/usr/bin/env node
// Live CDP check for the Git changes panel (#464); scratch REFRACT_DATA_DIR/repo, never the real Session list.
// Not exercised: the "Agent is working" banner (needs a real prompt, which costs model tokens).

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
  switchTheme, computeDirty
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
  activeElementAriaLabel,
  activeElementRowPath,
  activeElementGroupTrigger,
  readCommitAnnouncementText,
  runCommitDisabledReasonCheck,
  runMarkAsResolvedCheck,
  runPartialStagedDualGroupingCheck
} from './verify-464-git-changes-helpers.mjs';
import {
  runDiffStabilityDuringExternalWriteCheck,
  runBracketLiteralPathCheck,
  runContainmentRefusalCheck,
  runDraftPersistsAcrossTabSwitchCheck,
  runCommitClearsDuringExternalChurnCheck
} from './verify-464-git-changes-helpers2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_464_SHOTS_DIR || path.join(tmpdir(), 'refract-464-git-changes-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

// Ties the exe under test to this commit, not a reused or clobbered build. The marker uses an em dash (U+2014) as rendered.
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

    // `readout:update` only reaches a visible Session, so set visibility explicitly before listening.
    await cdp.evaluate(`window.refract.sessions.setVisible([${JSON.stringify(sessionId)}])`);
    await cdp.evaluate(
      `(() => { window.__verify464ReadoutEvents = []; window.refract.onReadoutUpdate((payload) => { window.__verify464ReadoutEvents.push(payload); }); return true; })()`
    );

    buildScratchWorkingTree(worktreePath);
    findings.push('Scratch working tree built: a real failed merge (Conflicts), a git-add-staged new file (Staged), a modified tracked file + a deleted tracked file (Changes), and an untracked file (Untracked).');

    await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
    await cdp.waitFor(`!!(${CONFLICTS_TRIGGER_FINDER})`, { timeoutMs: 20_000, label: 'Git changes panel loaded (Conflicts group rendered)' });

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

    await cdp.click(fileRowOpenButtonFinder(FIXTURE.readme));
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for README.md' });
    assertEqual(await activeElementAriaLabel(cdp), 'Back to changes from README.md', 'Focus after opening README.md diff: the Back button', findings, failures);
    const readmeDiffText = await diffViewText(cdp);
    if (!readmeDiffText || !readmeDiffText.includes(FIXTURE.readmeEditedLine)) {
      failures.push(`Diff view for README.md did not show the real added line "${FIXTURE.readmeEditedLine}": ${JSON.stringify(readmeDiffText)}`);
    } else {
      findings.push('Diff view for README.md (unstaged, staged=false branch) shows the real added line.');
    }
    await shot('02-diff-readme-unstaged.png');
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes returned to the groups list' });
    assertEqual(await activeElementRowPath(cdp), FIXTURE.readme, 'Focus after clicking "Back to changes": returns to the row that opened it (README.md)', findings, failures);

    // A plain `git diff` on a never-committed path is empty, so real content proves `staged` reached `diff_text`.
    await clickRowMenuItem(cdp, FIXTURE.stagedNew, `Open diff for ${FIXTURE.stagedNew}`);
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for staged-new-file.txt' });
    assertEqual(await activeElementAriaLabel(cdp), 'Back to changes from staged-new-file.txt', 'Focus after opening staged-new-file.txt diff: the Back button', findings, failures);
    const stagedDiffText = await diffViewText(cdp);
    if (!stagedDiffText || !stagedDiffText.includes(FIXTURE.stagedNewContentLine) || stagedDiffText.includes('No changes')) {
      failures.push(`Diff view for staged-new-file.txt (staged=true) did not show its real added content: ${JSON.stringify(stagedDiffText)}`);
    } else {
      findings.push('Diff view for staged-new-file.txt (staged, staged=true branch via "Open diff" menu item) shows its real added content -- confirms --cached was really used.');
    }
    await shot('03-diff-staged-new-file.png');
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes (2nd time, via Escape)' });
    assertEqual(await activeElementRowPath(cdp), FIXTURE.stagedNew, 'Focus after Escape: returns to the row that opened it (staged-new-file.txt)', findings, failures);

    await clickRowMenuItem(cdp, FIXTURE.untracked, `Stage ${FIXTURE.untracked}`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 2'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Untracked -> Staged (Staged, 2)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.stagedNew, FIXTURE.untracked], 'Staged files after per-file stage', findings, failures);
    assertEqual(await activeElementRowPath(cdp), FIXTURE.untracked, 'Focus after per-file Stage: the same row, now in Staged', findings, failures);
    const untrackedGoneAfterStage = await cdp.evaluate(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`);
    assertEqual(untrackedGoneAfterStage, true, 'Untracked group gone after staging its only file', findings, failures);
    await clickRowMenuItem(cdp, FIXTURE.untracked, `Unstage ${FIXTURE.untracked}`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`,
      { timeoutMs: 15_000, label: 'untracked-file.txt moved Staged -> Untracked (Staged, 1)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.untracked], 'Untracked files after per-file unstage round trip', findings, failures);
    assertEqual(await activeElementRowPath(cdp), FIXTURE.untracked, 'Focus after per-file Unstage: the same row, back in Untracked', findings, failures);
    findings.push('Per-file Stage then Unstage round trip on untracked-file.txt returned the panel to its original grouping.');

    const conflictsHasNoBulk = await cdp.evaluate(`!document.querySelector('[aria-label="Stage all in Conflicts"]') && !document.querySelector('[aria-label="Unstage all in Conflicts"]')`);
    assertEqual(conflictsHasNoBulk, true, 'Conflicts group offers no bulk action at all', findings, failures);
    await clickBulkAction(cdp, 'Stage all in Untracked');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`, { timeoutMs: 15_000, label: 'Untracked group gone after Stage all' });
    // A bulk "Stage all" focuses the next rendered group's trigger; only Conflicts remains here.
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

    await clickBulkAction(cdp, 'Unstage all in Staged');
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, '))`, { timeoutMs: 15_000, label: 'Staged group gone after Unstage all' });
    assertArrayEqual(await readGroupFileTitles(cdp, 'Changes'), [FIXTURE.readme, FIXTURE.deletedTracked], 'Changes files after Unstage all (tracked paths return here)', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.stagedNew, FIXTURE.untracked], 'Untracked files after Unstage all (never-committed paths return here)', findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Conflicts'), [FIXTURE.conflict], 'Conflicts untouched by Unstage all', findings, failures);
    await shot('05-after-unstage-all.png');

    await runDiffStabilityDuringExternalWriteCheck(cdp, worktreePath, sessionId, [FIXTURE.stagedNew, FIXTURE.untracked], shot, findings, failures);

    const { ctrlEnterSubject, ctrlEnterBody } = await runCommitDisabledReasonCheck(cdp, shot, findings, failures);

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

    const conflictBlockedState = await readCommitButtonState(cdp);
    assertEqual(conflictBlockedState?.disabled, true, 'Commit disabled while conflict.txt is still unresolved (staged files + a message both already present)', findings, failures);
    assertEqual(conflictBlockedState?.reasonText, 'Resolve conflicts first', 'Commit disabled reason while a conflict is unresolved (priority over "Nothing staged"/"Write a message")', findings, failures);
    assertEqual(conflictBlockedState?.title, 'Resolve conflicts first', 'Commit title attribute while a conflict is unresolved', findings, failures);
    await shot('09-commit-box-disabled-resolve-conflicts.png');

    await runMarkAsResolvedCheck(cdp, worktreePath, FIXTURE.conflict, shot, findings, failures);

    // git refuses any commit while an unmerged path exists, and the resolved file still holds conflict markers; rewrite it clean.
    writeFileSync(path.join(worktreePath, FIXTURE.conflict), 'worktree change\n');
    runGit(worktreePath, ['add', '--', FIXTURE.conflict]);

    // Press from BODY so the "focus moves to subject" assertion can fail; wait on the subject clearing, not "Staged gone" (a refresh can land first).
    await cdp.click(BODY_FINDER);
    const readoutEventsBeforeCtrlEnterCommit = await cdp.evaluate(`window.__verify464ReadoutEvents.filter((e) => e.sessionId === ${JSON.stringify(sessionId)}).length`);
    await pressCtrlEnter(cdp);
    await cdp.waitFor(`(() => { const subj = ${SUBJECT_FINDER}; return !!subj && subj.value === ''; })()`, { timeoutMs: 15_000, label: 'Commit subject genuinely cleared after Ctrl+Enter commit' });
    assertEqual(gitLogField(worktreePath, '%s'), ctrlEnterSubject, 'git log subject after Ctrl+Enter commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), ctrlEnterBody, 'git log body after Ctrl+Enter commit', findings, failures);
    assertEqual(await activeElementIs(cdp, SUBJECT_FINDER), true, 'Focus after Ctrl+Enter commit: the Commit subject input', findings, failures);
    assertEqual(await readCommitAnnouncementText(cdp), `Committed: ${ctrlEnterSubject}`, 'Commit announcement text after Ctrl+Enter commit', findings, failures);
    // A fresh event arrives even though `readout.changes` itself does not differ for a commit of tracked content.
    await cdp.waitFor(
      `window.__verify464ReadoutEvents.filter((e) => e.sessionId === ${JSON.stringify(sessionId)}).length > ${readoutEventsBeforeCtrlEnterCommit}`,
      { timeoutMs: 15_000, label: 'A fresh readout:update event arrived for this Session after the Ctrl+Enter commit' }
    );
    findings.push('Readout chip: a fresh `readout:update` event for this Session arrived after the Ctrl+Enter commit (schedule_readout_update wiring, item 13).');
    await shot('12-post-ctrl-enter-commit.png');

    await clickRowMenuItem(cdp, FIXTURE.stagedNew, `Stage ${FIXTURE.stagedNew}`);
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`, { timeoutMs: 15_000, label: 'staged-new-file.txt staged for the button-commit check' });
    const buttonCommitSubject = 'Commit via the real button (verify-464)';
    const buttonCommitBody = 'Body composed for the button-click commit path.';
    await typeIntoField(cdp, SUBJECT_FINDER, buttonCommitSubject);
    await typeIntoField(cdp, BODY_FINDER, buttonCommitBody);
    await cdp.click(COMMIT_BUTTON_FINDER);
    await cdp.waitFor(`(() => { const subj = ${SUBJECT_FINDER}; return !!subj && subj.value === ''; })()`, { timeoutMs: 15_000, label: 'Commit subject genuinely cleared after button-click commit (gate round 3, #1076: never "Staged gone")' });
    assertEqual(gitLogField(worktreePath, '%s'), buttonCommitSubject, 'git log subject after button-click commit', findings, failures);
    assertEqual(gitLogField(worktreePath, '%b'), buttonCommitBody, 'git log body after button-click commit', findings, failures);
    assertEqual(await activeElementIs(cdp, SUBJECT_FINDER), true, 'Focus after button-click commit: the Commit subject input', findings, failures);
    assertEqual(await readCommitAnnouncementText(cdp), `Committed: ${buttonCommitSubject}`, 'Commit announcement text after button-click commit', findings, failures);
    await shot('13-post-button-commit.png');

    await runDraftPersistsAcrossTabSwitchCheck(cdp, shot, findings, failures);
    await runCommitClearsDuringExternalChurnCheck(cdp, worktreePath, shot, findings, failures);

    // Tight timeout on purpose: the watcher has no periodic liveness fallback, so a pass proves the real fs-watcher fired.
    writeFileSync(path.join(worktreePath, FIXTURE.externalChange), 'added from outside the UI\n');
    await cdp.waitFor(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; return Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.externalChange)}); })()`,
      { timeoutMs: 1_500, intervalMs: 100, label: 'External fs-watcher-driven refresh showed the new untracked file, within 1.5s (past the 200ms debounce, no slower fallback left to rely on)' }
    );
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.externalChange, FIXTURE.untracked], 'Untracked files after an external fs change', findings, failures);
    await shot('14-external-change-refresh.png');

    await runPartialStagedDualGroupingCheck(cdp, worktreePath, shot, findings, failures);

    await runBracketLiteralPathCheck(cdp, worktreePath, shot, findings, failures);
    assertArrayEqual(await readGroupFileTitles(cdp, 'Untracked'), [FIXTURE.externalChange, FIXTURE.untracked], 'Untracked back to its Check 14 state after fixture teardown', findings, failures);

    // No UI path reaches an outside path; `validate_pathspec` must refuse it before git runs (wire code `outside-worktree`).
    const outsideMarkerFile = path.join(outsideDir, 'outside-worktree-marker.txt');
    const outsideMarkerContent = 'this must never be reachable from inside the worktree\n';
    writeFileSync(outsideMarkerFile, outsideMarkerContent);
    await runContainmentRefusalCheck(cdp, sessionId, outsideMarkerFile, outsideMarkerContent, findings, failures);

    notExercised.push('FR-012 "Agent is working -- review before committing" inline banner: not exercised -- reaching a real `working` Session status needs a real prompt sent to the real agent, which this script deliberately never does.');

    // Only Untracked remains: earlier commits took everything else and the fixtures were torn down.
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
      gitHead: gitHeadSha, dirty: computeDirty(REPO_ROOT),
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
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty: computeDirty(REPO_ROOT), exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
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
