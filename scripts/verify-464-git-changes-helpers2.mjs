// Shared helpers for `verify-464-git-changes.mjs` (second split file).

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
  activeElementAriaLabel,
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

/** Check 7b: an external write to an unrelated file while a diff is open must not tear the diff
 * down or steal focus. README.md is committed by Check 12, so later it has no row to click.
 * Back fires no load, so a single un-retried read after it proves the refresh landed while open.
 * `window.__refractStores` and the tab badge are unusable (production build, multi-panel only). */
export async function runDiffStabilityDuringExternalWriteCheck(cdp, worktreePath, sessionId, untrackedBaseline, shot, findings, failures) {
  const unrelatedFileName = 'an-unrelated-external-change-for-verify-464.txt';
  await cdp.click(fileRowOpenButtonFinder(FIXTURE.readme));
  await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view reopened for README.md (item 2 stability check)' });
  const diffTextBefore = await diffViewText(cdp);
  if (!diffTextBefore || !diffTextBefore.includes(FIXTURE.readmeEditedLine)) {
    failures.push(`Item 2 setup: README.md's own reopened diff did not show its real added line before the external write: ${JSON.stringify(diffTextBefore)}`);
  }
  assertEqual(await activeElementAriaLabel(cdp), 'Back to changes from README.md', 'Item 2 setup: focus is on Back to changes before an unrelated external write', findings, failures);

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
  // Direct IPC call bypassing the DOM and store: the backend already sees the file.
  const backendResult = await cdp.evaluate(`window.refract.gitChanges.list(${JSON.stringify(sessionId)})`);
  const backendSeesItWhileOpen =
    backendResult.ok && backendResult.value.snapshot
      ? backendResult.value.snapshot.groups.untracked.some((f) => f.path === unrelatedFileName)
      : false;
  assertEqual(backendSeesItWhileOpen, true, 'Item 2: a direct gitChanges.list IPC call (bypassing the renderer) already sees the unrelated file while the diff pane is still open', findings, failures);
  assertEqual(await cdp.evaluate(`!!document.querySelector('.diff-view')`), true, 'Item 2: the diff view is still mounted immediately after that direct backend check', findings, failures);
  const diffTextAfter = await diffViewText(cdp);
  assertEqual(diffTextAfter, diffTextBefore, "Item 2: README.md's own diff text is still mounted, byte-identical, after the unrelated external write", findings, failures);
  assertEqual(await activeElementAriaLabel(cdp), 'Back to changes from README.md', 'Item 2: focus is still on Back to changes after the unrelated external write (never stolen by the background refresh)', findings, failures);

  await cdp.click(BACK_TO_CHANGES_FINDER);
  await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes after the item-2 stability check' });
  // Back fires no fetch, so a single un-retried read is correct only if the store already held it.
  assertArrayEqual(
    await readGroupFileTitles(cdp, 'Untracked'),
    [...untrackedBaseline, unrelatedFileName].sort(),
    'Item 2: the unrelated external file genuinely was picked up by the refresh once back at the list (Back itself fetches nothing, so this proves the refresh landed no later than while the diff was open)',
    findings,
    failures
  );
  await shot('07b-diff-stability-external-write.png');

  // Fully torn down so it cannot perturb later checks' Untracked expectations.
  rmSync(path.join(worktreePath, unrelatedFileName));
  await cdp.waitFor(
    `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return false; return !Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(unrelatedFileName)}); })()`,
    { timeoutMs: 15_000, label: 'Item 2 fixture torn down: unrelated file gone from Untracked' }
  );
}

/** Check: a literal bracket filename stages only itself, proving `--literal-pathspecs` works
 * end-to-end. Tears down its own fixture. */
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

/** Check: containment refusal via the IPC bridge directly (no UI path exists). Rust's
 * `validate_pathspec` refuses an outside-worktree path with wire code `outside-worktree`.
 * `outsideMarkerFile` must already exist on disk with `markerContent`. */
export async function runContainmentRefusalCheck(cdp, sessionId, outsideMarkerFile, markerContent, findings, failures) {
  const diffAttempt = await cdp.evaluate(
    `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(outsideMarkerFile)}, false).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message }))`
  );
  if (diffAttempt.ok) failures.push(`Containment refusal: gitChanges.diff against an absolute path outside the worktree (${outsideMarkerFile}) SUCCEEDED -- must always be refused.`);
  else if (diffAttempt.code !== 'outside-worktree') failures.push(`Containment refusal: gitChanges.diff refused the outside-worktree path, but with code "${diffAttempt.code}" (expected "outside-worktree", the Rust-side validate_pathspec gate) -- message: ${diffAttempt.message}`);
  else findings.push(`Containment refusal (gitChanges.diff): refused with code "outside-worktree" (${diffAttempt.message}).`);
  // The absolute path is refused by the lexical `validate_pathspec` gate before
  // `untracked_file_patch` is consulted, so this only proves call order. The refusal message must
  // be `validate_pathspec`'s wording (`refused unsafe path: ...`); if it flips, that claim is false.
  const untrackedDiffAttempt = await cdp.evaluate(
    `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(outsideMarkerFile)}, false, true).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message }))`
  );
  if (untrackedDiffAttempt.ok) failures.push(`Containment refusal: gitChanges.diff(untracked=true) against an absolute path outside the worktree (${outsideMarkerFile}) SUCCEEDED -- must always be refused.`);
  else if (untrackedDiffAttempt.code !== 'outside-worktree') failures.push(`Containment refusal: gitChanges.diff(untracked=true) refused the outside-worktree path, but with code "${untrackedDiffAttempt.code}" (expected "outside-worktree") -- message: ${untrackedDiffAttempt.message}`);
  else findings.push(`Containment refusal (gitChanges.diff, untracked=true): refused with code "outside-worktree" (${untrackedDiffAttempt.message}).`);
  const refusedByValidatePathspec = untrackedDiffAttempt.message === `refused unsafe path: ${outsideMarkerFile}`;
  assertEqual(refusedByValidatePathspec, true, `gitChanges.diff(untracked=true) against an absolute outside-worktree path was refused by validate_pathspec's own call-order gate specifically (message=${JSON.stringify(untrackedDiffAttempt.message)}), not a different guard`, findings, failures);
  const stageAttempt = await cdp.evaluate(
    `window.refract.gitChanges.stage(${JSON.stringify(sessionId)}, [${JSON.stringify(outsideMarkerFile)}]).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message }))`
  );
  if (stageAttempt.ok) failures.push(`Containment refusal: gitChanges.stage against an absolute path outside the worktree (${outsideMarkerFile}) SUCCEEDED -- must always be refused.`);
  else if (stageAttempt.code !== 'outside-worktree') failures.push(`Containment refusal: gitChanges.stage refused the outside-worktree path, but with code "${stageAttempt.code}" -- message: ${stageAttempt.message}`);
  else findings.push(`Containment refusal (gitChanges.stage): refused with code "outside-worktree" (${stageAttempt.message}).`);
  const outsideMarkerUnchanged = readFileSync(outsideMarkerFile, 'utf8') === markerContent;
  assertEqual(outsideMarkerUnchanged, true, 'Outside-worktree marker file untouched after both refused attempts', findings, failures);
}

/** Check: a half-typed commit draft survives switching to another panel tab and back. The panel
 * fully unmounts on tab change, so the draft must live in `commitDraftsBySession`, which
 * `forgetSession` leaves alone. Goes through the real tab-switch UI; clears the draft after. */
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

/** Check: commit success feedback (subject clears, Commit re-enables) must land as soon as the
 * commit IPC succeeds, not wait on watcher-triggered refreshes that keep re-queuing. Writes a new
 * external file every 150ms through the 2-second window and asserts the subject empties anyway. */
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
