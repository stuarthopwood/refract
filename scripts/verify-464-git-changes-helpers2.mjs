// Shared helpers for `verify-464-git-changes.mjs` (issue #464, spec 018 slice 1), SECOND split
// file -- `verify-464-git-changes-helpers.mjs` itself crossed `check-file-size.mjs`'s 600-line
// soft cap (#806) once gate round 2's own new live-check functions landed; these three move here
// unchanged (behaviour-preserving split, not a rewrite) to bring both files back under the cap.

import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import {
  FIXTURE,
  runGit,
  clickRowMenuItem,
  fileRowOpenButtonFinder,
  readGroupFileTitles,
  diffViewText,
  BACK_TO_CHANGES_FINDER,
  activeElementText,
  assertArrayEqual,
  assertEqual,
  gitStatusPorcelain,
  typeIntoField,
  clearField,
  SUBJECT_FINDER,
  BODY_FINDER,
  COMMIT_BUTTON_FINDER,
  readCommitAnnouncementText
} from './verify-464-git-changes-helpers.mjs';

/** Check (item 2, gate round 2): an external write to a DIFFERENT, unrelated file while a diff
 * is open must not tear the open diff down or steal focus -- `GitChangesDiffPane`'s own
 * background-refetch (gate round 2 item 2 fix) only shows `'loading'` for a genuinely NEW diff
 * (a different path or staged side); an unrelated snapshot refresh keeps the current patch
 * mounted (so scroll/focus survive) and swaps it only if the new text actually differs. Opens
 * README.md's own real unstaged diff, writes an entirely unrelated new untracked file, and
 * polls for `.diff-view` to confirm it never once disappears (the `'loading'`/error swap)
 * across that window -- then returns to the list and confirms the unrelated file really was
 * picked up, proving the refresh genuinely happened rather than merely having nothing to
 * observe. Assumes the panel is currently showing the groups list (not already in a diff).
 *
 * Runs as Check 7b, between Check 7 (bulk Unstage all) and Check 8 -- NOT after Check 14 as
 * gate round 2 first placed it: README.md is staged and committed for real by Check 12's
 * Ctrl+Enter commit, so by Check 14 it has dropped out of every group entirely and
 * `fileRowOpenButtonFinder(FIXTURE.readme)` has no row left to click (a real bug in this
 * check's own placement, not a product bug -- falsified against the exact Check 7-14 state
 * trace before moving it). `untrackedBaseline` is whatever Untracked already holds at the
 * call site (Check 7 leaves it as `[FIXTURE.stagedNew, FIXTURE.untracked]`), so the expected
 * post-write array is computed rather than hardcoded to a later check's own fixture state.
 *
 * Gate round 3 fix (#1076 MEDIUM, Gate1076Test3): the Untracked-array assertion used to run
 * only AFTER clicking Back, so a refresh that landed late -- even one Back itself re-triggered
 * -- still passed vacuously; nothing proved the refresh happened WHILE the diff was open at
 * all. Two false starts, both falsified live before being reported rather than after: (1)
 * `window.__refractStores` -- absent from this build (`import.meta.env.DEV` is false; a `tauri
 * build --debug` still runs `vite build` in PRODUCTION mode per `tauri.conf.json`'s own
 * `beforeBuildCommand`, the same fact `verify-tauri-569.mjs`/`verify-tauri-560-gate2.mjs`/
 * `verify-672-start-message.mjs` already each independently document); (2) `#panel-tab-git-
 * changes`'s own additions badge -- `PanelTabBar.tsx` only renders a count in its MULTI-panel
 * branch, and this script only ever opens the one `git-changes` panel, so the single-panel
 * title-row branch renders instead, with no count at all (a "null to null" vacuous pass caught
 * before reporting, not after).
 *
 * Proven for real with two independent, genuinely external checks: (a) a direct
 * `gitChanges.list` IPC call (bypassing BOTH the DOM and the renderer's own store entirely)
 * confirms the BACKEND already sees the unrelated file while the diff pane is still open; (b)
 * `onBack` (`GitChangesPanel.tsx`) is a PURE local-state toggle (`setSelected(null)`) -- it
 * fires no `load()` of its own, confirmed against every effect in that file -- so the single,
 * un-retried `readGroupFileTitles` read immediately after Back can only be correct if the
 * RENDERER's own store already held the unrelated file beforehand, i.e. no later than while the
 * diff pane was still the active view. */
export async function runDiffStabilityDuringExternalWriteCheck(cdp, worktreePath, sessionId, untrackedBaseline, shot, findings, failures) {
  const unrelatedFileName = 'an-unrelated-external-change-for-verify-464.txt';
  await cdp.click(fileRowOpenButtonFinder(FIXTURE.readme));
  await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view reopened for README.md (item 2 stability check)' });
  const diffTextBefore = await diffViewText(cdp);
  if (!diffTextBefore || !diffTextBefore.includes(FIXTURE.readmeEditedLine)) {
    failures.push(`Item 2 setup: README.md's own reopened diff did not show its real added line before the external write: ${JSON.stringify(diffTextBefore)}`);
  }
  assertEqual(await activeElementText(cdp), 'Back to changes', 'Item 2 setup: focus is on Back to changes before an unrelated external write', findings, failures);

  writeFileSync(path.join(worktreePath, unrelatedFileName), "an unrelated change while README.md's own diff is open, for verify-464\n");

  let diffViewDisappeared = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(100);
    const stillThere = await cdp.evaluate(`!!document.querySelector('.diff-view')`);
    if (!stillThere) {
      diffViewDisappeared = true;
      break;
    }
  }
  assertEqual(diffViewDisappeared, false, 'Item 2: the open README.md diff never disappeared (no "Loading diff…"/error swap) while an unrelated external file changed', findings, failures);
  // Gate round 3 fix (#1076 MEDIUM, Gate1076Test3): a direct IPC call, bypassing the DOM and the
  // renderer's own store entirely -- proves the BACKEND genuinely already sees the unrelated
  // file, while the diff pane is still open.
  const backendResult = await cdp.evaluate(`window.refract.gitChanges.list(${JSON.stringify(sessionId)})`);
  const backendSeesItWhileOpen =
    backendResult.ok && backendResult.value.snapshot
      ? backendResult.value.snapshot.groups.untracked.some((f) => f.path === unrelatedFileName)
      : false;
  assertEqual(backendSeesItWhileOpen, true, 'Item 2: a direct gitChanges.list IPC call (bypassing the renderer) already sees the unrelated file while the diff pane is still open', findings, failures);
  assertEqual(await cdp.evaluate(`!!document.querySelector('.diff-view')`), true, 'Item 2: the diff view is still mounted immediately after that direct backend check', findings, failures);
  const diffTextAfter = await diffViewText(cdp);
  assertEqual(diffTextAfter, diffTextBefore, "Item 2: README.md's own diff text is still mounted, byte-identical, after the unrelated external write", findings, failures);
  assertEqual(await activeElementText(cdp), 'Back to changes', 'Item 2: focus is still on Back to changes after the unrelated external write (never stolen by the background refresh)', findings, failures);

  await cdp.click(BACK_TO_CHANGES_FINDER);
  await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes after the item-2 stability check' });
  // Back fires no fetch of its own (a pure `setSelected(null)`, see the doc comment) -- a single,
  // un-retried read here can only be correct if the renderer's own store already held this
  // before Back was clicked, i.e. no later than while the diff pane was still showing.
  assertArrayEqual(
    await readGroupFileTitles(cdp, 'Untracked'),
    [...untrackedBaseline, unrelatedFileName].sort(),
    'Item 2: the unrelated external file genuinely was picked up by the refresh once back at the list (Back itself fetches nothing, so this proves the refresh landed no later than while the diff was open)',
    findings,
    failures
  );
  await shot('07b-diff-stability-external-write.png');

  // Fully torn down before returning, same posture as Checks 15/16 -- this fixture must never
  // perturb any later check's own fixed Untracked expectations (Check 14's, Check 18's).
  rmSync(path.join(worktreePath, unrelatedFileName));
  await cdp.waitFor(
    `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; return !Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(unrelatedFileName)}); })()`,
    { timeoutMs: 15_000, label: 'Item 2 fixture torn down: unrelated file gone from Untracked' }
  );
}

/** Check (item 5): a literal bracket filename stages ONLY itself -- proves `--literal-pathspecs`
 * (gate round 1 items 9/10) protects it end-to-end, not merely that the Rust code compiles. Two
 * untracked siblings differing only by a bracket vs. a plain `-other` suffix; staging the
 * bracketed one via its OWN kebab "Stage" item must never touch the other. Builds, asserts, and
 * FULLY TEARS DOWN its own fixture before returning. */
export async function runBracketLiteralPathCheck(cdp, worktreePath, shot, findings, failures) {
  writeFileSync(path.join(worktreePath, FIXTURE.bracketFile), FIXTURE.bracketFileContent);
  writeFileSync(path.join(worktreePath, FIXTURE.bracketSibling), FIXTURE.bracketSiblingContent);
  await cdp.waitFor(
    `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; const titles = Array.from(ul.querySelectorAll('li span[title]')).map((el) => el.getAttribute('title')); return titles.includes(${JSON.stringify(FIXTURE.bracketFile)}) && titles.includes(${JSON.stringify(FIXTURE.bracketSibling)}); })()`,
    { timeoutMs: 1_500, intervalMs: 100, label: 'Both bracket-named fixture files rendered as Untracked, within 1.5s' }
  );
  const untrackedBefore = await readGroupFileTitles(cdp, 'Untracked');
  assertEqual(Array.isArray(untrackedBefore) && untrackedBefore.includes(FIXTURE.bracketFile) && untrackedBefore.includes(FIXTURE.bracketSibling), true, 'Untracked files include both bracket-named fixtures', findings, failures);
  await clickRowMenuItem(cdp, FIXTURE.bracketFile, `Stage ${FIXTURE.bracketFile}`);
  await cdp.waitFor(
    `(() => { const staged = document.querySelector('[aria-label="Staged files"]'); if (!staged) return false; return Array.from(staged.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.bracketFile)}); })()`,
    { timeoutMs: 15_000, label: `${FIXTURE.bracketFile} moved to Staged` }
  );
  assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.bracketFile], `Staged holds ONLY ${FIXTURE.bracketFile} -- its sibling was never touched`, findings, failures);
  const untrackedAfter = await readGroupFileTitles(cdp, 'Untracked');
  assertEqual(
    Array.isArray(untrackedAfter) && !untrackedAfter.includes(FIXTURE.bracketFile) && untrackedAfter.includes(FIXTURE.bracketSibling),
    true,
    `Untracked no longer includes ${FIXTURE.bracketFile}, but ${FIXTURE.bracketSibling} is still exactly where it was`,
    findings,
    failures
  );
  const siblingContentUnchanged = readFileSync(path.join(worktreePath, FIXTURE.bracketSibling), 'utf8') === FIXTURE.bracketSiblingContent;
  assertEqual(siblingContentUnchanged, true, `${FIXTURE.bracketSibling}'s own real file content untouched on disk`, findings, failures);
  const siblingStatus = gitStatusPorcelain(worktreePath, FIXTURE.bracketSibling);
  assertEqual(siblingStatus, `?? ${FIXTURE.bracketSibling}`, `${FIXTURE.bracketSibling}'s real git status is still plain untracked (never staged)`, findings, failures);
  await shot('16-bracket-literal-path-stage.png');

  runGit(worktreePath, ['reset', '--', FIXTURE.bracketFile]);
  rmSync(path.join(worktreePath, FIXTURE.bracketFile));
  rmSync(path.join(worktreePath, FIXTURE.bracketSibling));
  await cdp.waitFor(
    `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; const titles = Array.from(ul.querySelectorAll('li span[title]')).map((el) => el.getAttribute('title')); return !titles.includes(${JSON.stringify(FIXTURE.bracketFile)}) && !titles.includes(${JSON.stringify(FIXTURE.bracketSibling)}); })()`,
    { timeoutMs: 1_500, intervalMs: 100, label: 'Both bracket-named fixture files torn down, gone from Untracked' }
  );
}

/** Check (pre-existing, moved here purely for the 600-line soft cap, #806): containment refusal,
 * via the real IPC bridge directly (no UI path exists -- `window.refract.gitChanges.*` is called
 * directly, the same real-IPC-bridge-bypassing-the-UI precedent `verify-926-attach-any-file.mjs`
 * already established). A Rust-side `validate_pathspec` gate (`src-tauri/src/git/pathspec.rs`)
 * refuses an absolute/outside-worktree path before it ever reaches a `git` subprocess, wire code
 * `outside-worktree`. `outsideMarkerFile` must already exist on disk with `markerContent`. */
export async function runContainmentRefusalCheck(cdp, sessionId, outsideMarkerFile, markerContent, findings, failures) {
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
  const outsideMarkerUnchanged = readFileSync(outsideMarkerFile, 'utf8') === markerContent;
  assertEqual(outsideMarkerUnchanged, true, 'Outside-worktree marker file untouched after both refused attempts', findings, failures);
}

/** Check (#1076 MEDIUM 4, gate round 3): a half-typed commit draft survives switching to a
 * DIFFERENT hosted panel tab and back -- `RightPaneShell.tsx` renders only the active
 * `activePanelId`'s panel (`FileExplorerPanel.tsx`'s own doc comment: "switching to a different
 * tab... genuinely unmounts it"), so `GitChangesPanel`/`GitCommitBox` fully unmount the instant
 * the tab changes. Gate round 2 item 6 claimed the draft survives exactly this, but
 * `forgetSession` dropped it right along with the rest of that Session's `bySession` entry on
 * every such switch (Gate1076Test3, MEDIUM) -- gate round 3 moved it into its own
 * `commitDraftsBySession` map, untouched by `forgetSession`. Proves it through the real tab-
 * switch UI path, not just a store read. Fully clears the draft before returning. */
export async function runDraftPersistsAcrossTabSwitchCheck(cdp, shot, findings, failures) {
  const draftSubject = 'A half-typed draft for verify-464';
  const draftBody = 'Switching tabs must not discard this.';
  await typeIntoField(cdp, SUBJECT_FINDER, draftSubject);
  await typeIntoField(cdp, BODY_FINDER, draftBody);
  await cdp.click(`document.querySelector('[data-rail-button="file-explorer"]')`);
  await cdp.waitFor(`!${SUBJECT_FINDER}`, { timeoutMs: 10_000, label: 'Git changes panel (and its commit box) unmounted after switching to the File explorer tab' });
  await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
  await cdp.waitFor(`!!${SUBJECT_FINDER}`, { timeoutMs: 10_000, label: 'Git changes panel remounted after switching back' });
  assertEqual(await cdp.evaluate(`${SUBJECT_FINDER}?.value ?? null`), draftSubject, 'Commit draft subject survived a tab switch away and back', findings, failures);
  assertEqual(await cdp.evaluate(`${BODY_FINDER}?.value ?? null`), draftBody, 'Commit draft body survived a tab switch away and back', findings, failures);
  await shot('13a-draft-survives-tab-switch.png');
  await clearField(cdp, SUBJECT_FINDER);
  await clearField(cdp, BODY_FINDER);
}

/** Check (#1076 HIGH 1 proof, gate round 3): a commit's own success feedback (the subject
 * clearing, the announcement, Commit re-enabling) must land the instant the commit IPC itself
 * succeeds -- never wait on however many more watcher-triggered refreshes pile up while files
 * keep changing underneath it (Gate1076Test3's own falsification: the pre-fix design awaited the
 * WHOLE coalesced `load()` drain loop, with no upper bound while an agent's own continuous
 * worktree churn kept re-queuing another pass). Starts a real commit, then keeps writing a new
 * external file every 150ms for the FULL 2-second assertion window that follows -- sustained
 * churn throughout, not one write -- and asserts the subject field genuinely empties well inside
 * that window regardless. Builds and fully tears down its own fixture. */
export async function runCommitClearsDuringExternalChurnCheck(cdp, worktreePath, shot, findings, failures) {
  const churnPrefix = 'mid-commit-churn-for-verify-464';
  writeFileSync(path.join(worktreePath, `${churnPrefix}-seed.txt`), 'seed\n');
  runGit(worktreePath, ['add', '--', `${churnPrefix}-seed.txt`]);
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 1'; })()`, { timeoutMs: 15_000, label: 'Churn-check seed file staged' });
  const churnSubject = 'Commit under sustained external churn (verify-464)';
  await typeIntoField(cdp, SUBJECT_FINDER, churnSubject);
  let churnCount = 0;
  const churnTimer = setInterval(() => {
    churnCount += 1;
    writeFileSync(path.join(worktreePath, `${churnPrefix}-${churnCount}.txt`), `churn ${churnCount}\n`);
  }, 150);
  try {
    await cdp.click(COMMIT_BUTTON_FINDER);
    let clearedWithinBudget = true;
    try {
      await cdp.waitFor(`(() => { const subj = ${SUBJECT_FINDER}; return !!subj && subj.value === ''; })()`, { timeoutMs: 2_000, intervalMs: 50, label: 'Commit subject cleared within 2s despite sustained external churn' });
    } catch {
      clearedWithinBudget = false;
    }
    assertEqual(clearedWithinBudget, true, 'Commit success feedback (subject clear) landed within 2s of clicking Commit, despite continuous external file churn the whole time (#1076 HIGH 1)', findings, failures);
    assertEqual(await readCommitAnnouncementText(cdp), `Committed: ${churnSubject}`, 'Commit announcement text after a commit made during sustained external churn', findings, failures);
  } finally {
    clearInterval(churnTimer);
  }
  await shot('13b-commit-during-external-churn.png');
  for (let i = 1; i <= churnCount; i += 1) {
    const churnFile = path.join(worktreePath, `${churnPrefix}-${i}.txt`);
    if (existsSync(churnFile)) rmSync(churnFile);
  }
  await cdp.waitFor(
    `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return true; return !Array.from(ul.querySelectorAll('li span[title]')).some((el) => (el.getAttribute('title')||'').startsWith(${JSON.stringify(churnPrefix)})); })()`,
    { timeoutMs: 15_000, label: 'Churn-check fixture torn down: no churn files left in Untracked' }
  );
}
