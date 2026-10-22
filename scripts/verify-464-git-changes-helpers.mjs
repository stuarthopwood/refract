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

/** Exported (gate round 1 live-check addition, item 4): `main()`'s own partial-staged (`MM`)
 * fixture needs the exact same real-baseline-commit idiom `buildScratchWorkingTree` already uses
 * for `conflict.txt`, built INLINE there rather than duplicated. */
export function commitPaths(cwd, paths, message) {
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
  stagedNewContentLine: 'staged content for verify-464',
  // Gate round 1 live-check additions (2026-10-20): item 4 (partial-staged `MM` dual grouping)
  // and item 5 (`--literal-pathspecs` end-to-end proof) each build their own small fixture
  // INLINE in `main()` (never here) -- both are deliberately introduced AFTER the rest of the
  // script's existing checks have already run their own group-count assertions against the
  // original four-group fixture above, then fully cleaned up again before the theme loop's own
  // fixed expectation -- so only their literal filenames/content live here, typo-safety only.
  partialStaged: 'partial-staged.txt',
  partialStagedBaseline: 'partial baseline line\n',
  partialStagedFirstEdit: 'partial baseline line\nfirst edit appended\n',
  partialStagedSecondEdit: 'partial baseline line\nfirst edit appended\nsecond edit appended\n',
  // Gate round 2 fix (item 15, 2026-10-20): the sibling MUST be `i.txt`, not `[id]-other.txt` --
  // `[id].txt` interpreted as a GLOB bracket expression (the exact bug `--literal-pathspecs`
  // exists to prevent) matches a SINGLE character from the set {i, d} followed by literally
  // ".txt", i.e. it matches a file named "i.txt" or "d.txt", but it does NOT match
  // "[id]-other.txt" (the trailing "-other" never matches that pattern at all, glob or
  // literal) -- the old sibling would therefore have passed this check even with
  // `--literal-pathspecs` silently removed, proving nothing. "i.txt" is the one sibling name a
  // broken (non-literal) pathspec interpretation would actually sweep up alongside the real
  // target, so it is the only name that genuinely discriminates the two behaviours.
  bracketFile: '[id].txt',
  bracketSibling: 'i.txt',
  bracketFileContent: 'literal bracket file content for verify-464\n',
  bracketSiblingContent: 'sibling must remain untouched for verify-464\n'
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

// Also used by `runMarkAsResolvedCheck` below (Check 9's own `collectTabTrail` seed-click on
// this SAME trigger toggles the Conflicts group closed -- see that function's own comment).
export const CONFLICTS_TRIGGER_FINDER = `Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Conflicts, '))`;

export async function diffViewRendered(cdp) {
  return cdp.evaluate(`!!document.querySelector('.diff-view')`);
}

export async function diffViewText(cdp) {
  return cdp.evaluate(`document.querySelector('.diff-view')?.textContent ?? null`);
}

// #1101 item 6: the Back button is now a ghost icon-only control (`ArrowLeftIcon`, no visible
// text) with its own file-naming `aria-label` ("Back to changes from <file>") instead of a
// literal "Back to changes" text node -- matched by that label's stable prefix so this finder
// still works regardless of which file is currently open.
export const BACK_TO_CHANGES_FINDER = `Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Back to changes from '))`;

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
 * sibling whenever one is shown). Gate round 1 fix (2026-10-20): the button moved from native
 * `disabled` to `aria-disabled` (so it stays focusable/tabbable while "disabled" -- the same
 * `aria-disabled`-not-`disabled` convention this whole app's own other busy/blocked controls
 * use) -- `btn.disabled` is now ALWAYS `false` regardless of state; read the attribute instead. */
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

// ---------------------------------------------------------------------------
// Gate round 1 live-check additions (2026-10-20): focus-restoration (`focus.ts`) and readout-chip
// (`session::readout::schedule_readout_update`) proofs, plus the small per-row/git-status reads
// item 4 (partial-staged `MM` dual grouping) and item 7 ("Mark as resolved" confirmation) need.
// ---------------------------------------------------------------------------

/** Whether `document.activeElement` is literally the element `finderExpr` evaluates to right
 * now -- used for the "Back to changes"/Commit-subject focus-restoration targets, which have no
 * `data-*` marker of their own (unlike a row or a group trigger, below). */
export async function activeElementIs(cdp, finderExpr) {
  return cdp.evaluate(`document.activeElement === (${finderExpr})`);
}

/** `document.activeElement`'s own trimmed visible text. */
export async function activeElementText(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.textContent.trim() : null`);
}

/** `document.activeElement`'s own `aria-label` (#1101 item 6: the Back button is now icon-only,
 * so its accessible name lives in this attribute, not in `textContent`). */
export async function activeElementAriaLabel(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('aria-label') : null`);
}

/** `document.activeElement`'s own `data-git-row-path` (`focus.ts`'s `focusGitRow` target) --
 * read via the attribute rather than an element reference, since a stage/unstage re-renders the
 * row into a DIFFERENT DOM node in its new group; the attribute value survives that, the node
 * identity does not. */
export async function activeElementRowPath(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('data-git-row-path') : null`);
}

/** `document.activeElement`'s own `data-git-group-trigger` (`focus.ts`'s `focusGitGroupTrigger`
 * target). */
export async function activeElementGroupTrigger(cdp) {
  return cdp.evaluate(`document.activeElement ? document.activeElement.getAttribute('data-git-group-trigger') : null`);
}

/** `GitCommitBox.tsx`'s own `sr-only role="status"` commit-success announcement, scoped via
 * `.closest('.no-drag-region')` from the Commit subject input (that class is the commit box's
 * own root, so this is unambiguous regardless of how many OTHER `.no-drag-region` elements the
 * rest of the app happens to use elsewhere). */
export async function readCommitAnnouncementText(cdp) {
  return cdp.evaluate(`(() => {
    const subj = ${SUBJECT_FINDER};
    const box = subj ? subj.closest('.no-drag-region') : null;
    const p = box ? box.querySelector('p[role="status"].sr-only') : null;
    return p ? p.textContent : null;
  })()`);
}

/** One row's own `DiffStatCounts` sr-only accessible text ("N addition(s), M deletion(s)"),
 * scoped to one named group's own `<ul>` -- needed for item 4's partially-staged (`MM`) fixture,
 * which renders the SAME path as two separate rows (one per group), each with its own
 * independently-scored badge. Matched by content (`/addition/`), never by position: the row's
 * OTHER `sr-only` span (its status-icon label, "`<mark> — Open diff for <path>`") would
 * otherwise be picked up first. */
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

/** `git status --porcelain` for exactly one path, trimmed -- the same real-git-status-not-just-
 * DOM grounding `buildScratchWorkingTree`'s own conflict self-check already uses, reused here for
 * item 4's `MM` self-check and item 7's "the dialog opening alone must not touch git state" /
 * "the confirm action must genuinely re-stage it" proofs. Empty string means "clean" (no
 * difference from HEAD on either side). */
export function gitStatusPorcelain(worktreePath, filePath) {
  return runGit(worktreePath, ['status', '--porcelain', '--', filePath]).trim();
}

// ---------------------------------------------------------------------------
// Gate round 1 live-check additions, continued: whole self-contained check RUNNERS (never just
// reads/finders) for items 4/5/7 -- each is built, asserted, and (items 4/5) fully torn down in
// one call, moved here (rather than inlined in `main()`) purely to keep the orchestrating
// script under `check-file-size.mjs`'s own 600-line soft cap (#806), the same reason this whole
// file exists in the first place (see this file's own header comment).
// ---------------------------------------------------------------------------

const PLAUSIBLE_DIFF_STAT_BADGE = /^\d+ additions?, \d+ deletions?$/;

/** Check (item 7): the Conflicts row's own "Mark as resolved" kebab item confirms first --
 * clicking it only OPENS a confirmation dialog (Radix `role="alertdialog"`); the real `stage()`
 * call (a real `git add`, genuinely resolving the conflict at the git level) happens only once
 * the dialog's own "Mark as resolved" action is clicked. Both halves grounded in real
 * `git status --porcelain`, not just the DOM. Leaves `conflictPath` staged for real on return --
 * the caller's own "script fixture fix" step still needs to run afterward to clean the literal
 * conflict markers out of its content before committing. */
export async function runMarkAsResolvedCheck(cdp, worktreePath, conflictPath, shot, findings, failures) {
  // Check 9's own `collectTabTrail` seeds its own tab order with a click on this SAME trigger --
  // which, since the Conflicts group defaults OPEN, TOGGLES it closed (Radix `CollapsibleContent`
  // without `forceMount` does not render its children in the DOM at all while closed, so the
  // row this check needs next would not exist). Reopen it before anything else.
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

/** Check (item 4): a partially staged (`MM`) file renders as TWO separate rows for the SAME path
 * -- one in Staged (scored against the index, `git diff --cached`), one in Changes (scored
 * against the worktree, plain `git diff`) -- `changes_status.rs`'s own gate round 1 item 5
 * dual-row fix. Builds its own tiny baseline-commit-then-partially-edit fixture, asserts both
 * rows and their own independently-scored diff-stat badges, then FULLY TEARS IT DOWN again
 * before returning, so it never perturbs any other check's own group-count expectations. */
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

  // Item 3 (gate round 2): opening the diff from the CHANGES-half row specifically (scoped via
  // `data-git-group-list="changes"`, since both halves share the identical `data-git-row-path`),
  // then returning, must land focus on that SAME half's row -- never the Staged-half row
  // sharing its path (`focus.ts`'s own group-scoped `focusGitRowInGroup`, `GitChangesPanel.tsx`'s
  // `lastSelectionRef.current.group`).
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

/** Check (pre-existing, moved here purely for the 600-line soft cap, #806; expectations fixed
 * 2026-10-20): the Commit button's own disabled-with-reason states, read via a real CDP DOM read
 * (`readCommitButtonState`). conflict.txt is NOT resolved until much later (the caller's own
 * Check 11), so `conflictCount > 0` wins `GitCommitBox.tsx`'s own `disabledReason` priority
 * throughout this whole function regardless of staged count or typed message -- every
 * expectation below is "Resolve conflicts first", never "Nothing staged"/"Write a message"/
 * enabled (the ORIGINAL pre-existing expectations here assumed the OLD priority order, before
 * gate round 1 item 11 made a conflict block Commit unconditionally; this is a genuine fix, not
 * a rewrite of the check's own intent). Leaves the panel staged (Staged, 2: the re-staged
 * Changes group) with a real subject/body typed in, the state the caller's own next checks
 * (conflict-priority, Ctrl+Enter commit) rely on. Returns the same subject/body strings the
 * caller needs later for its own `git log` assertions. Gate round 2 fix (item 15): every state
 * this function exercises shows "Resolve conflicts first" (the conflict fixture is still
 * unresolved throughout) -- its own screenshots are named for that REAL displayed reason, not
 * the misleading "nothing-staged"/"write-message" names a round-1 pass gave them (the conflict
 * always wins here, so neither of those two reasons is ever genuinely ON SCREEN in this
 * function; `main()`'s own post-resolution flow never re-derives them live either, so this
 * rename -- not fabricating a new, unverified check sequencing -- is this round's own fix). */
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
