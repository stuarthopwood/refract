// Helpers for `verify-464-git-changes.mjs`, split out to stay under the 600-line file cap:
// real `git` plumbing for a realistic scratch tree, and CDP helpers specific to the Git changes panel.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { getAccessibleNameAndRole } from './verify-tauri-scratch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';

const GIT_AUTHOR_ARGS = ['-c', 'user.name=verify-464', '-c', 'user.email=verify-464@example.invalid'];

export function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).toString();
}

/** Never throws: the merge step needs a non-zero exit (a real conflict) as the wanted outcome. */
export function runGitAllowFailure(cwd, args) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

export function commitPaths(cwd, paths, message) {
  runGit(cwd, ['add', '--', ...paths]);
  runGit(cwd, [...GIT_AUTHOR_ARGS, 'commit', '-q', '-m', message]);
}

export const FIXTURE = {
  readme: 'README.md',
  deletedTracked: 'src/example.txt',
  stagedNew: 'staged-new-file.txt',
  untracked: 'untracked-file.txt',
  conflict: 'conflict.txt',
  externalChange: 'external-change.txt',
  readmeBaseline: 'Hello scratch repo\n',
  readmeEdited: 'Hello scratch repo\nAn unstaged edit for verify-464.\n',
  readmeEditedLine: 'An unstaged edit for verify-464.',
  stagedNewContent: 'staged content for verify-464\n',
  stagedNewContentLine: 'staged content for verify-464',
  partialStaged: 'partial-staged.txt',
  partialStagedBaseline: 'partial baseline line\n',
  partialStagedFirstEdit: 'partial baseline line\nfirst edit appended\n',
  partialStagedSecondEdit: 'partial baseline line\nfirst edit appended\nsecond edit appended\n',
  // The sibling must be `i.txt`: as a glob, `[id].txt` matches `i.txt`, so only that name proves
  // `--literal-pathspecs` is in effect.
  bracketFile: '[id].txt',
  bracketSibling: 'i.txt',
  bracketFileContent: 'literal bracket file content for verify-464\n',
  bracketSiblingContent: 'sibling must remain untouched for verify-464\n'
};

/** Run before the session worktree is created so it inherits a real, non-empty HEAD. */
export function commitRepoBaseline(repoDir) {
  writeFileSync(path.join(repoDir, FIXTURE.readme), FIXTURE.readmeBaseline);
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, FIXTURE.deletedTracked), 'original content\n');
  commitPaths(repoDir, [FIXTURE.readme, FIXTURE.deletedTracked], 'Add baseline files');
}

/** Populates all four groups in the SESSION's worktree (a separate checkout, so changes made in
 * `repoDir` would never appear). The conflict comes from a real, deliberately unresolved merge;
 * a throw means the fixture is broken, not the app. */
export function buildScratchWorkingTree(worktreePath) {
  // Conflicts first, before anything else touches this worktree.
  writeFileSync(path.join(worktreePath, FIXTURE.conflict), 'shared\n');
  commitPaths(worktreePath, [FIXTURE.conflict], 'Add conflict.txt baseline'); // commit B
  writeFileSync(path.join(worktreePath, FIXTURE.conflict), 'worktree change\n');
  commitPaths(worktreePath, [FIXTURE.conflict], 'worktree-side edit'); // commit W, HEAD~1 = B

  const conflictSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-464-conflict-source-'));
  runGit(worktreePath, ['worktree', 'add', conflictSourceDir, '-b', 'conflict-source', 'HEAD~1']);
  writeFileSync(path.join(conflictSourceDir, FIXTURE.conflict), 'source-branch change\n');
  commitPaths(conflictSourceDir, [FIXTURE.conflict], 'source-branch edit'); // commit S
  runGit(worktreePath, ['worktree', 'remove', '--force', conflictSourceDir]);

  const mergeResult = runGitAllowFailure(worktreePath, ['merge', '--no-edit', 'conflict-source']);
  if (mergeResult.status === 0) {
    throw new Error('buildScratchWorkingTree: expected `git merge conflict-source` to conflict on conflict.txt, but it completed cleanly -- the fixture is not set up correctly.');
  }
  const workingTreeConflictText = readFileSync(path.join(worktreePath, FIXTURE.conflict), 'utf8');
  if (!workingTreeConflictText.includes('<<<<<<<')) {
    throw new Error('buildScratchWorkingTree: conflict.txt has no real conflict markers after the merge attempt -- the fixture is not genuinely conflicted.');
  }

  writeFileSync(path.join(worktreePath, FIXTURE.stagedNew), FIXTURE.stagedNewContent);
  runGit(worktreePath, ['add', '--', FIXTURE.stagedNew]);

  writeFileSync(path.join(worktreePath, FIXTURE.readme), FIXTURE.readmeEdited);

  writeFileSync(path.join(worktreePath, FIXTURE.untracked), 'untracked content for verify-464\n');

  rmSync(path.join(worktreePath, FIXTURE.deletedTracked));
}

/** The kebab and bulk-action buttons are `group-hover:opacity-100`, so a real pointer move must precede the click. */
export async function clickWithHover(cdp, finderExpr, { timeoutMs = 15_000, label } = {}) {
  const rect = await cdp.waitFor(
    `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs, label: label ?? `hover target: ${finderExpr}` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(150);
  await cdp.click(finderExpr, { timeoutMs });
}

export function fileRowActionsFinder(filePath) {
  return `document.querySelector('[aria-label=${JSON.stringify(`More actions for ${filePath}`)}]')`;
}

/** Located via the exact `title` span, never from truncated visible text. */
export function fileRowOpenButtonFinder(filePath) {
  return `Array.from(document.querySelectorAll('span[title=${JSON.stringify(filePath)}]')).map((el) => el.closest('button')).find(Boolean)`;
}

export async function clickRowActions(cdp, filePath) {
  await clickWithHover(cdp, fileRowActionsFinder(filePath), { label: `row actions trigger for ${filePath}` });
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: `row actions menu open for ${filePath}` });
}

export async function clickRowMenuItem(cdp, filePath, itemText) {
  await clickRowActions(cdp, filePath);
  const itemFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === ${JSON.stringify(itemText)})`;
  await cdp.waitFor(`!!(${itemFinder})`, { timeoutMs: 10_000, label: `"${itemText}" menu item present for ${filePath}` });
  await cdp.click(itemFinder);
}

export async function clickBulkAction(cdp, ariaLabel) {
  await clickWithHover(cdp, `document.querySelector('[aria-label=${JSON.stringify(ariaLabel)}]')`, { label: `bulk action: ${ariaLabel}` });
}

/** `{ name, count }` per rendered group, in DOM order (fixed Conflicts/Staged/Changes/Untracked). */
export async function readGroupSummaries(cdp) {
  return cdp.evaluate(`(() => {
    const names = ['Conflicts', 'Staged', 'Changes', 'Untracked'];
    return Array.from(document.querySelectorAll('button[aria-expanded]'))
      .map((el) => el.getAttribute('aria-label'))
      .filter((label) => !!label && names.some((n) => label.startsWith(n + ', ')))
      .map((label) => { const idx = label.indexOf(', '); return { name: label.slice(0, idx), count: Number(label.slice(idx + 2)) }; });
  })()`);
}

/** Paths in one group's list, already sorted server-side. */
export async function readGroupFileTitles(cdp, groupLabel) {
  return cdp.evaluate(`(() => {
    const ul = document.querySelector('[aria-label=${JSON.stringify(`${groupLabel} files`)}]');
    if (!ul) return null;
    return Array.from(ul.querySelectorAll('li span[title]')).map((el) => el.getAttribute('title'));
  })()`);
}

export const CONFLICTS_TRIGGER_FINDER = `Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Conflicts, '))`;

export async function diffViewRendered(cdp) {
  return cdp.evaluate(`!!document.querySelector('.diff-view')`);
}

export async function diffViewText(cdp) {
  return cdp.evaluate(`document.querySelector('.diff-view')?.textContent ?? null`);
}

// Icon-only button with no text; match the stable aria-label prefix, not the file name.
export const BACK_TO_CHANGES_FINDER = `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Back to changes from '))`;

/** Real Ctrl+Enter; the modifier bit is needed for `event.ctrlKey` to read true. */
export async function pressCtrlEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
}

/** Ctrl+A then Backspace: `Input.insertText` only inserts at the caret, never replaces. */
export async function clearField(cdp, finderExpr) {
  await cdp.click(finderExpr);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
}

export async function typeIntoField(cdp, finderExpr, text) {
  await cdp.click(finderExpr);
  await cdp.send('Input.insertText', { text });
}

export const SUBJECT_FINDER = `document.querySelector('input[placeholder="Commit subject"]')`;
export const BODY_FINDER = `document.querySelector('textarea[placeholder="Description (optional)"]')`;

/** One atomic snapshot of the Commit button. It uses `aria-disabled` (stays tabbable), so
 * `btn.disabled` is always false; read the attribute. */
export async function readCommitButtonState(cdp) {
  return cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((el) => { const t = el.textContent.trim(); return t === 'Commit' || t === 'Committing…'; });
    if (!btn) return null;
    const reasonSpan = btn.previousElementSibling;
    return {
      disabled: btn.getAttribute('aria-disabled') === 'true',
      title: btn.getAttribute('title'),
      reasonText: reasonSpan && reasonSpan.tagName === 'SPAN' ? reasonSpan.textContent.trim() : null,
      label: btn.textContent.trim()
    };
  })()`);
}

export const COMMIT_BUTTON_FINDER = `Array.from(document.querySelectorAll('button')).find((el) => { const t = el.textContent.trim(); return t === 'Commit' || t === 'Committing…'; })`;

/** Seeds focus on the Conflicts trigger, then records each Tab stop's computed accessible name. */
export async function collectTabTrail(cdp, conflictsTriggerFinder, stopWhenName, maxSteps = 25) {
  await cdp.click(conflictsTriggerFinder);
  const trail = [];
  for (let i = 0; i < maxSteps; i++) {
    await pressTab(cdp);
    const { name } = await getAccessibleNameAndRole(cdp, 'document.activeElement');
    trail.push(name);
    if (name === stopWhenName) break;
  }
  return trail;
}

/** Order-preserving subsequence check; tolerates other stops in between. */
export function assertTabSubsequence(trail, expectedNames, label, findings, failures) {
  let searchFrom = 0;
  for (const expected of expectedNames) {
    const foundAt = trail.findIndex((name, i) => i >= searchFrom && name === expected);
    if (foundAt === -1) {
      failures.push(`${label}: expected to Tab onto "${expected}" (after index ${searchFrom}) but never did. Full trail: ${JSON.stringify(trail)}`);
      return;
    }
    searchFrom = foundAt + 1;
  }
  findings.push(`${label}: Tab reached every expected stop in order: ${JSON.stringify(expectedNames)}.`);
}

/** Value equality per element: `readGroupSummaries` returns fresh objects each read, so `===` always fails. */
export function assertArrayEqual(actual, expected, label, findings, failures) {
  const same = Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => JSON.stringify(v) === JSON.stringify(expected[i]));
  if (!same) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else findings.push(`${label}: ${JSON.stringify(actual)}`);
}

export function assertEqual(actual, expected, label, findings, failures) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else findings.push(`${label}: ${JSON.stringify(actual)}`);
}

/** Whether `document.activeElement` is the element `finderExpr` evaluates to (for targets with no `data-*` marker). */
export async function activeElementIs(cdp, finderExpr) {
  return cdp.evaluate(`document.activeElement === (${finderExpr})`);
}

/** `document.activeElement`'s own trimmed visible text. */
export async function activeElementText(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.textContent.trim() : null`);
}

/** Icon-only Back button: its accessible name lives in `aria-label`, not `textContent`. */
export async function activeElementAriaLabel(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('aria-label') : null`);
}

/** Read via the attribute: a stage/unstage re-renders the row as a different DOM node. */
export async function activeElementRowPath(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('data-git-row-path') : null`);
}

/** The group-trigger marker on the focused element. */
export async function activeElementGroupTrigger(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('data-git-group-trigger') : null`);
}

/** Scoped via the commit box's own `.no-drag-region` root so other uses of that class don't collide. */
export async function readCommitAnnouncementText(cdp) {
  return cdp.evaluate(`(() => {
    const subj = ${SUBJECT_FINDER};
    const box = subj ? subj.closest('.no-drag-region') : null;
    const p = box ? box.querySelector('p[role="status"].sr-only') : null;
    return p ? p.textContent : null;
  })()`);
}

/** One row's diff-stat sr-only text within a group's `<ul>`. An `MM` file renders the same path
 * in two groups; match by `/addition/`, since the row's other sr-only span would be found first. */
export async function readRowDiffStatAccessibleText(cdp, groupLabel, filePath) {
  return cdp.evaluate(`(() => {
    const ul = document.querySelector('[aria-label=${JSON.stringify(`${groupLabel} files`)}]');
    if (!ul) return null;
    const row = Array.from(ul.querySelectorAll('li')).find((li) => li.querySelector('span[title=${JSON.stringify(filePath)}]'));
    if (!row) return null;
    const span = Array.from(row.querySelectorAll('span.sr-only')).find((s) => /addition/.test(s.textContent));
    return span ? span.textContent.trim() : null;
  })()`);
}

/** `git status --porcelain` for one path, trimmed; empty means clean. Grounds checks in real git state, not the DOM. */
export function gitStatusPorcelain(worktreePath, filePath) {
  return runGit(worktreePath, ['status', '--porcelain', '--', filePath]).trim();
}

const PLAUSIBLE_DIFF_STAT_BADGE = /^\d+ additions?, \d+ deletions?$/;

/** The kebab item only opens a confirmation dialog; the real `git add` happens on confirm.
 * Both halves are asserted against `git status --porcelain`. Leaves `conflictPath` staged. */
export async function runMarkAsResolvedCheck(cdp, worktreePath, conflictPath, shot, findings, failures) {
  // The tab-trail seed click toggled the Conflicts group closed, and closed content is not
  // rendered, so reopen it first.
  await cdp.click(CONFLICTS_TRIGGER_FINDER);
  await cdp.waitFor(`!!document.querySelector('[aria-label=${JSON.stringify(`More actions for ${conflictPath}`)}]')`, { timeoutMs: 10_000, label: 'Conflicts group reopened, its row rendered again' });
  const statusBeforeMenu = gitStatusPorcelain(worktreePath, conflictPath);
  await clickRowMenuItem(cdp, conflictPath, `Mark ${conflictPath} as resolved`);
  await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: '"Mark as resolved" confirmation dialog open' });
  const titleText = await cdp.evaluate(`document.querySelector('[data-slot="alert-dialog-title"]')?.textContent ?? null`);
  assertEqual(titleText, `Mark ${conflictPath} as resolved?`, 'Confirmation dialog title names the real file', findings, failures);
  const bodyMentionsMarkers = await cdp.evaluate(`/conflict marker/i.test(document.querySelector('[data-slot="alert-dialog-description"]')?.textContent ?? '')`);
  assertEqual(bodyMentionsMarkers, true, 'Confirmation dialog body warns about conflict markers', findings, failures);
  const statusWhileDialogOpen = gitStatusPorcelain(worktreePath, conflictPath);
  assertEqual(statusWhileDialogOpen, statusBeforeMenu, 'Opening the confirmation dialog alone does not touch git state (still exactly as conflicted as before)', findings, failures);
  assertArrayEqual(await readGroupFileTitles(cdp, 'Conflicts'), [conflictPath], `${conflictPath} has NOT moved to Staged yet -- the dialog is still only a confirmation`, findings, failures);
  await shot('10-mark-resolved-confirm-dialog.png');
  await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((el) => el.textContent.trim() === 'Mark as resolved')`);
  await cdp.waitFor(`!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Confirmation dialog closed after confirming' });
  await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Conflicts, '))`, { timeoutMs: 15_000, label: 'Conflicts group gone after confirming "Mark as resolved"' });
  const stagedTitles = await readGroupFileTitles(cdp, 'Staged');
  assertEqual(Array.isArray(stagedTitles) && stagedTitles.includes(conflictPath), true, `${conflictPath} appears in Staged after confirming "Mark as resolved"`, findings, failures);
  const statusAfterConfirm = gitStatusPorcelain(worktreePath, conflictPath);
  if (statusAfterConfirm === statusBeforeMenu || !/^M /.test(statusAfterConfirm)) {
    failures.push(`"Mark as resolved" confirm: real git status for ${conflictPath} did not become a plain staged-modified entry -- before: ${JSON.stringify(statusBeforeMenu)}, after: ${JSON.stringify(statusAfterConfirm)}`);
  } else {
    findings.push(`"Mark as resolved" confirm: real git status for ${conflictPath} changed from ${JSON.stringify(statusBeforeMenu)} (unmerged) to ${JSON.stringify(statusAfterConfirm)} (staged) -- a genuine \`git add\` happened, not just a DOM update.`);
  }
  await shot('11-mark-resolved-staged.png');
}

/** A partially staged (`MM`) file must render as two rows for one path (Staged scored against the
 * index, Changes against the worktree). The fixture is fully torn down so other group counts are unaffected. */
export async function runPartialStagedDualGroupingCheck(cdp, worktreePath, shot, findings, failures) {
  writeFileSync(path.join(worktreePath, FIXTURE.partialStaged), FIXTURE.partialStagedBaseline);
  commitPaths(worktreePath, [FIXTURE.partialStaged], 'Add partial-staged.txt baseline');
  writeFileSync(path.join(worktreePath, FIXTURE.partialStaged), FIXTURE.partialStagedFirstEdit);
  runGit(worktreePath, ['add', '--', FIXTURE.partialStaged]); // first edit: staged
  writeFileSync(path.join(worktreePath, FIXTURE.partialStaged), FIXTURE.partialStagedSecondEdit); // second edit: left unstaged
  const status = gitStatusPorcelain(worktreePath, FIXTURE.partialStaged);
  if (!status.startsWith('MM ')) {
    throw new Error(`runPartialStagedDualGroupingCheck: expected a real "MM " porcelain status for ${FIXTURE.partialStaged} (staged AND unstaged edits both present), got ${JSON.stringify(status)} -- the fixture is not genuinely partially-staged.`);
  }
  const bothRowsPresent = `(() => { const staged = document.querySelector('[aria-label="Staged files"]'); const changes = document.querySelector('[aria-label="Changes files"]'); const inStaged = !!staged && Array.from(staged.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.partialStaged)}); const inChanges = !!changes && Array.from(changes.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.partialStaged)}); return inStaged && inChanges; })()`;
  await cdp.waitFor(bothRowsPresent, { timeoutMs: 1_500, intervalMs: 100, label: 'partial-staged.txt rendered as two rows, Staged AND Changes, within 1.5s of the real MM status existing' });
  assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.partialStaged], "Staged holds only partial-staged.txt's own staged-half row while MM", findings, failures);
  assertArrayEqual(await readGroupFileTitles(cdp, 'Changes'), [FIXTURE.partialStaged], "Changes holds only partial-staged.txt's own worktree-half row while MM", findings, failures);
  const badgeInStaged = await readRowDiffStatAccessibleText(cdp, 'Staged', FIXTURE.partialStaged);
  const badgeInChanges = await readRowDiffStatAccessibleText(cdp, 'Changes', FIXTURE.partialStaged);
  if (!badgeInStaged || !PLAUSIBLE_DIFF_STAT_BADGE.test(badgeInStaged)) failures.push(`partial-staged.txt's own Staged-row diff-stat badge is not a plausible figure: ${JSON.stringify(badgeInStaged)}`);
  else findings.push(`partial-staged.txt's own Staged-row diff-stat badge: "${badgeInStaged}".`);
  if (!badgeInChanges || !PLAUSIBLE_DIFF_STAT_BADGE.test(badgeInChanges)) failures.push(`partial-staged.txt's own Changes-row diff-stat badge is not a plausible figure: ${JSON.stringify(badgeInChanges)}`);
  else findings.push(`partial-staged.txt's own Changes-row diff-stat badge: "${badgeInChanges}".`);
  await shot('15-partial-staged-dual-rows.png');

  // Opening the diff from the Changes-half row and going back must restore focus to that same
  // half's row, not the Staged row sharing its path.
  await cdp.click(`document.querySelector('[data-git-group-list="changes"] span[title=${JSON.stringify(FIXTURE.partialStaged)}]')?.closest('button')`);
  await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: "Diff view opened from partial-staged.txt's own Changes-half row" });
  await cdp.click(BACK_TO_CHANGES_FINDER);
  await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: "Back to changes from partial-staged.txt's own Changes-half diff" });
  const focusedRowIsInChangesGroup = await cdp.evaluate(`!!document.activeElement?.closest('[data-git-group-list="changes"]')`);
  assertEqual(
    focusedRowIsInChangesGroup,
    true,
    "Item 3: Back from partial-staged.txt's own Changes-half diff lands focus on that SAME half's row (group-scoped), not the Staged-half row sharing its path",
    findings,
    failures
  );

  runGit(worktreePath, ['reset', '--', FIXTURE.partialStaged]);
  writeFileSync(path.join(worktreePath, FIXTURE.partialStaged), FIXTURE.partialStagedBaseline);
  const neitherRowPresent = `(() => { const staged = document.querySelector('[aria-label="Staged files"]'); const changes = document.querySelector('[aria-label="Changes files"]'); const inStaged = !!staged && Array.from(staged.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.partialStaged)}); const inChanges = !!changes && Array.from(changes.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FIXTURE.partialStaged)}); return !inStaged && !inChanges; })()`;
  await cdp.waitFor(neitherRowPresent, { timeoutMs: 1_500, intervalMs: 100, label: 'partial-staged.txt fixture torn down: gone from both Staged and Changes' });
}

/** Commit-button disabled reasons. The conflict stays unresolved throughout, so every state
 * must read "Resolve conflicts first". Leaves 2 staged files and a typed subject/body for later
 * checks, and returns that subject/body. */
export async function runCommitDisabledReasonCheck(cdp, shot, findings, failures) {
  let commitState = await readCommitButtonState(cdp);
  assertEqual(commitState?.disabled, true, 'Commit disabled with 0 staged (no message yet)', findings, failures);
  assertEqual(commitState?.reasonText, 'Resolve conflicts first', 'Commit disabled reason with 0 staged (no message yet) -- conflict still wins', findings, failures);
  assertEqual(commitState?.title, 'Resolve conflicts first', 'Commit title attribute with 0 staged (no message yet) -- conflict still wins', findings, failures);
  await typeIntoField(cdp, SUBJECT_FINDER, 'A message that should not matter yet');
  commitState = await readCommitButtonState(cdp);
  assertEqual(commitState?.reasonText, 'Resolve conflicts first', 'Conflict still wins over a typed message when 0 staged (priority order)', findings, failures);
  await clearField(cdp, SUBJECT_FINDER);
  await shot('06-commit-box-disabled-conflict-wins-no-message.png');

  await clickBulkAction(cdp, 'Stage all in Changes');
  await cdp.waitFor(
    `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Staged, ')); return !!b && b.getAttribute('aria-label') === 'Staged, 2'; })()`,
    { timeoutMs: 15_000, label: 'Staged, 2 after re-staging Changes' }
  );
  commitState = await readCommitButtonState(cdp);
  assertEqual(commitState?.disabled, true, 'Commit disabled with staged files but no message (conflict still wins)', findings, failures);
  assertEqual(commitState?.reasonText, 'Resolve conflicts first', 'Commit disabled reason with staged files but no message -- conflict still wins', findings, failures);
  await shot('07-commit-box-disabled-conflict-wins-staged.png');

  const ctrlEnterSubject = 'Commit via Ctrl+Enter (verify-464)';
  const ctrlEnterBody = 'Body composed for the Ctrl+Enter commit path.';
  await typeIntoField(cdp, SUBJECT_FINDER, ctrlEnterSubject);
  await typeIntoField(cdp, BODY_FINDER, ctrlEnterBody);
  commitState = await readCommitButtonState(cdp);
  assertEqual(commitState?.disabled, true, 'Commit still disabled once staged AND message are both true -- the conflict alone still blocks it', findings, failures);
  assertEqual(commitState?.title, 'Resolve conflicts first', 'Commit title attribute still "Resolve conflicts first" with everything else ready', findings, failures);
  await shot('08-commit-box-disabled-conflict-blocks-all.png');

  return { ctrlEnterSubject, ctrlEnterBody };
}
