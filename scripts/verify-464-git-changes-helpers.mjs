// Shared helpers for `verify-464-git-changes.mjs` (issue #464, spec 018 slice 1), split into its
// own file so the orchestrating script stays under `check-file-size.mjs`'s 600-line soft cap
// (#806) -- the same "god file" convention this repo already applies to its own `verify-941-*`/
// `verify-926-*` scripts. Two kinds of helper live here: (1) plain Node `git` plumbing used to
// build a REALISTIC scratch working tree (never faked DOM state), and (2) CDP driving/reading
// helpers specific to this panel's own DOM shape (`GitChangesGroup.tsx`/`GitChangesFileRow.tsx`/
// `GitCommitBox.tsx`), not generic enough to belong in `verify-tauri-scratch-helpers.mjs`.

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

/** Never throws: returns `{ status, stdout, stderr }` even on a non-zero exit -- used only for
 * the merge step below, where a non-zero exit (a real conflict) is the EXPECTED, wanted outcome,
 * not a failure to propagate. */
export function runGitAllowFailure(cwd, args) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function commitPaths(cwd, paths, message) {
  runGit(cwd, ['add', '--', ...paths]);
  runGit(cwd, [...GIT_AUTHOR_ARGS, 'commit', '-q', '-m', message]);
}

// Literal filenames the whole fixture is built from -- exported so the orchestrating script
// never re-types (and risks typo-drifting from) the exact same strings used to build the tree.
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
  stagedNewContentLine: 'staged content for verify-464'
};

/** Commits a real baseline (README.md + src/example.txt) onto `repoDir`'s own default branch --
 * run BEFORE the repo is added as a Project/a Session's worktree is created off it, so the new
 * worktree inherits a real, non-empty HEAD (a real branch/base to show in the panel's header,
 * FR-014) rather than `makeScratchRepo`'s own bare `--allow-empty` init commit. */
export function commitRepoBaseline(repoDir) {
  writeFileSync(path.join(repoDir, FIXTURE.readme), FIXTURE.readmeBaseline);
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, FIXTURE.deletedTracked), 'original content\n');
  commitPaths(repoDir, [FIXTURE.readme, FIXTURE.deletedTracked], 'Add baseline files');
}

/** Builds the realistic, mixed working tree this live check needs -- all four FR-002 groups
 * populated at once -- directly in the SESSION'S OWN worktree (never `repoDir`: a Session's
 * worktree is a separate `git worktree add` checkout, so anything staged/modified/untracked in
 * `repoDir` itself would never appear in it; only committed history on `repoDir` propagates).
 *
 * Conflicts (optional stretch, done anyway since it was straightforward): built from a REAL
 * failed merge, never faked. Two divergent commits touching the same line of `conflict.txt` --
 * one on the Session's own branch (commit W), one on a throwaway `conflict-source` branch
 * created via a SECOND, temporary `git worktree add` off the common ancestor (so the Session's
 * own worktree is never checked out onto a different branch mid-build) -- then
 * `git merge conflict-source` inside the Session's worktree, left deliberately unresolved
 * (never committed/aborted away). Asserts real `<<<<<<<` conflict markers landed afterward: a
 * hard throw here (not a pushed `failures[]` entry) means the fixture itself is broken, not a
 * behaviour this script is trying to observe. */
export function buildScratchWorkingTree(worktreePath) {
  // --- Conflicts: a real failed merge, first (before anything else touches this worktree). ---
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

  // --- Staged: a brand-new file, `git add`ed, never committed. ---
  writeFileSync(path.join(worktreePath, FIXTURE.stagedNew), FIXTURE.stagedNewContent);
  runGit(worktreePath, ['add', '--', FIXTURE.stagedNew]);

  // --- Changes (modified, unstaged): edits the baseline README.md, never staged. ---
  writeFileSync(path.join(worktreePath, FIXTURE.readme), FIXTURE.readmeEdited);

  // --- Untracked: a brand-new file, never `git add`ed at all. ---
  writeFileSync(path.join(worktreePath, FIXTURE.untracked), 'untracked content for verify-464\n');

  // --- Changes (deleted, unstaged): removes a tracked file from disk, never `git rm`. ---
  rmSync(path.join(worktreePath, FIXTURE.deletedTracked));
}

// ---------------------------------------------------------------------------
// CDP driving/reading helpers specific to this panel's own DOM shape.
// ---------------------------------------------------------------------------

/** A real `mouseMoved` hover before the click -- `GitChangesFileRow.tsx`'s kebab and
 * `GitChangesGroup.tsx`'s bulk-action button are both `opacity-0 group-hover:opacity-100`
 * (revealed on hover/focus-within), the same `:hover`/`group-hover` CSS-reveal pattern
 * `verify-tauri-session-list-helpers.mjs`'s own `hoverRow` documents needing a real pointer
 * move for, not just a synthetic click landing at the right coordinates. */
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

/** The row's own name/folder button (the one `onOpenDiff` is bound to) -- located via the
 * `title={entry.path}` span `GitChangesFileRow.tsx` renders inside it (exact, certain), never
 * guessed from visible truncated text. */
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

/** Every rendered group's own trigger button, read generically (never assuming which groups are
 * non-empty right now) -- `{ name, count }` pairs in DOM order, which is always FR-002's fixed
 * Conflicts/Staged/Changes/Untracked order since `GitChangesPanel.tsx` filters `GROUP_ORDER`
 * rather than reordering it. */
export async function readGroupSummaries(cdp) {
  return cdp.evaluate(`(() => {
    const names = ['Conflicts', 'Staged', 'Changes', 'Untracked'];
    return Array.from(document.querySelectorAll('button[aria-expanded]'))
      .map((el) => el.getAttribute('aria-label'))
      .filter((label) => !!label && names.some((n) => label.startsWith(n + ', ')))
      .map((label) => { const idx = label.indexOf(', '); return { name: label.slice(0, idx), count: Number(label.slice(idx + 2)) }; });
  })()`);
}

/** The exact (already alphabetically sorted server-side) file paths rendered inside one named
 * group's own `<ul aria-label="<Label> files">`, via each row's `title={entry.path}` span. */
export async function readGroupFileTitles(cdp, groupLabel) {
  return cdp.evaluate(`(() => {
    const ul = document.querySelector('[aria-label=${JSON.stringify(`${groupLabel} files`)}]');
    if (!ul) return null;
    return Array.from(ul.querySelectorAll('li span[title]')).map((el) => el.getAttribute('title'));
  })()`);
}

export async function diffViewRendered(cdp) {
  return cdp.evaluate(`!!document.querySelector('.diff-view')`);
}

export async function diffViewText(cdp) {
  return cdp.evaluate(`document.querySelector('.diff-view')?.textContent ?? null`);
}

export const BACK_TO_CHANGES_FINDER = `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Back to changes')`;

/** Real Ctrl+Enter: a `rawKeyDown` for Control (carrying the Ctrl bit in its own `modifiers`,
 * the exact technique `verify-980-toast-send.mjs`'s own `ctrlClickSessionRow` already
 * established for a real `event.ctrlKey` reading true downstream), then Enter with the same
 * bit set, then both key-ups. */
export async function pressCtrlEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
}

/** Clears an already-focused, already-clicked text field via real Ctrl+A then Backspace --
 * `Input.insertText` only ever inserts at the caret, never replaces, the same reasoning
 * `verify-tauri-session-list-helpers.mjs`'s own `renameSessionViaF2` documents for its rename
 * input. */
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

/** The Commit button's own disabled/title/visible-reason state, read as one atomic snapshot
 * (`GitCommitBox.tsx`'s own `disabledReason` span is the button's immediately preceding
 * sibling whenever one is shown). */
export async function readCommitButtonState(cdp) {
  return cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((el) => { const t = el.textContent.trim(); return t === 'Commit' || t === 'Committing…'; });
    if (!btn) return null;
    const reasonSpan = btn.previousElementSibling;
    return {
      disabled: btn.disabled,
      title: btn.getAttribute('title'),
      reasonText: reasonSpan && reasonSpan.tagName === 'SPAN' ? reasonSpan.textContent.trim() : null,
      label: btn.textContent.trim()
    };
  })()`);
}

export const COMMIT_BUTTON_FINDER = `Array.from(document.querySelectorAll('button')).find((el) => { const t = el.textContent.trim(); return t === 'Commit' || t === 'Committing…'; })`;

/** Clicks the Conflicts group trigger (always present, always first) to seed a known starting
 * focus point, then presses Tab up to `maxSteps` times, recording each stop's real computed
 * accessible name (CDP Accessibility domain, never textContent) until `stopWhenName` is reached
 * or the budget runs out. */
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

/** Asserts `expectedNames` appear in `trail` as a (not necessarily contiguous) subsequence, in
 * order -- proves Tab reaches every named stop without over-specifying exactly how many other
 * rows/buttons sit between them. */
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

/** Value equality per element (never `===`, which only works for the string-array call sites --
 * `readGroupSummaries`'s own `{name, count}` objects are a NEW object literal every read, so
 * reference equality always fails even when the content genuinely matches -- a real bug this
 * script's own "Initial group summaries" check hit, confirmed by the failure message printing
 * byte-identical `expected`/`got` JSON). */
export function assertArrayEqual(actual, expected, label, findings, failures) {
  const same = Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => JSON.stringify(v) === JSON.stringify(expected[i]));
  if (!same) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else findings.push(`${label}: ${JSON.stringify(actual)}`);
}

export function assertEqual(actual, expected, label, findings, failures) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else findings.push(`${label}: ${JSON.stringify(actual)}`);
}
