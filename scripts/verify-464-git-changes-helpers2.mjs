// Shared helpers for `verify-464-git-changes.mjs` (issue #464, spec 018 slice 1), SECOND split
// file -- `verify-464-git-changes-helpers.mjs` itself crossed `check-file-size.mjs`'s 600-line
// soft cap (#806) once gate round 2's own new live-check functions landed; these three move here
// unchanged (behaviour-preserving split, not a rewrite) to bring both files back under the cap.

import { writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  gitStatusPorcelain
} from './verify-464-git-changes-helpers.mjs';

/** Check (item 2, gate round 2): an external write to a DIFFERENT, unrelated file while a diff
 * is open must not tear the open diff down or steal focus -- `GitChangesDiffPane`'s own
 * background-refetch (gate round 2 item 2 fix) only shows `'loading'` for a genuinely NEW diff
 * (a different path or staged side); an unrelated snapshot refresh keeps the current patch
 * mounted (so scroll/focus survive) and swaps it only if the new text actually differs. Opens
 * README.md's own real unstaged diff again, writes an entirely unrelated new untracked file,
 * and polls for `.diff-view` to confirm it never once disappears (the `'loading'`/error swap)
 * across that window -- then returns to the list and confirms the unrelated file really was
 * picked up, proving the refresh genuinely happened rather than merely having nothing to
 * observe. Assumes the panel is currently showing the groups list (not already in a diff). */
export async function runDiffStabilityDuringExternalWriteCheck(cdp, worktreePath, shot, findings, failures) {
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
  const diffTextAfter = await diffViewText(cdp);
  assertEqual(diffTextAfter, diffTextBefore, "Item 2: README.md's own diff text is still mounted, byte-identical, after the unrelated external write", findings, failures);
  assertEqual(await activeElementText(cdp), 'Back to changes', 'Item 2: focus is still on Back to changes after the unrelated external write (never stolen by the background refresh)', findings, failures);

  await cdp.click(BACK_TO_CHANGES_FINDER);
  await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes after the item-2 stability check' });
  assertArrayEqual(
    await readGroupFileTitles(cdp, 'Untracked'),
    [unrelatedFileName, FIXTURE.externalChange, FIXTURE.untracked],
    'Item 2: the unrelated external file genuinely was picked up by the refresh once back at the list (proves the refresh happened at all, not just "nothing to observe")',
    findings,
    failures
  );
  await shot('14b-diff-stability-external-write.png');

  // Fully torn down before returning, same posture as Checks 15/16 -- this fixture must never
  // perturb Check 18's own fixed `Untracked, 2` expectation.
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
