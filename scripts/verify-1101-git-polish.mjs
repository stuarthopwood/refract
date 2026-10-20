#!/usr/bin/env node
// Live CDP check for issue #1101 (spec 018, Convergence Phase 7: Git changes panel UI polish --
// Stuart's 2026-10-20 screenshot feedback on the shipped #464 slice 1 panel, PR #1076). Reuses
// `verify-464-git-changes.mjs`'s own scratch-repo/launch infrastructure and panel-specific
// finders/helpers (`verify-tauri-scratch-helpers.mjs`, `verify-tauri-session-list-helpers.mjs`,
// `verify-464-git-changes-helpers.mjs`) rather than re-deriving them -- a NEW file, not an
// extension of `verify-464-git-changes.mjs` itself, which already sits at `check-file-size.mjs`'s
// 600-line soft cap (#806).
//
// Isolation posture: its own scratch `REFRACT_DATA_DIR`/worktree/repo/exe, same as every
// `verify-tauri-5xx+`/`verify-464` script -- never touches Stuart's real Session list.
//
// AGENTS.md destructive-ops rule, honoured throughout (also followed by every helper this script
// calls): every deleted path is either a literal, freshly-`mkdtempSync`'d directory under the OS
// temp dir, or routed through `safeRmSync`'s own guard (realpath-checked against the temp dir).
// Never a bare drive letter, `.`, `..`, `~`, or a path built from an unset/default-valued variable.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-1101-git-polish.mjs (requires a prior `pnpm tauri build --debug --no-bundle`).
//
// Checks (the issue's own six items):
//   1. Subject counter (item 1): hidden at 0 chars, `n/72` once typing starts, muted -> warning
//      (>50) -> error (>72) colour tiers, each measured via a REAL computed-style comparison
//      against a freshly-created reference element carrying only that one utility class (never
//      just a className-string match) -- plus the `sr-only` "Subject length" accessible prefix.
//   2. Composer-style inputs (item 2): the commit Subject/Body fields' resting AND real
//      `:focus-visible` computed border-colour/background-colour/box-shadow(ring) measured
//      against the real composer wrapper's own computed styles in the SAME two states.
//   3. Stage/unstage in-progress state (item 3): a large (100 MB) untracked file's real `git add`
//      round trip is slow enough to observe `aria-busy="true"` + a spinner + a disabled kebab
//      trigger mid-flight (per-row), and the same for a bulk "Stage all" (per-group), each caught
//      via a tight `waitFor` poll, not a fixed sleep.
//   4. Untracked file diff content (item 4): a multi-line untracked file's diff shows every line
//      verbatim as a real `.diff-code-insert` row, zero `.diff-code-delete` rows, never "No
//      changes".
//   5. Back button (item 5) + sticky (item 6): the icon-only Back button's `aria-label` names the
//      real file; after a real wheel-scroll of a long diff, its own bounding rect is unchanged
//      (still pinned at the scroll region's own top) and nothing else covers it.
//
// Honestly-flagged gaps: the composer's own `:focus-visible` CSS heuristic for a real pointer
// click on a text field is trusted per documented Chromium behaviour (unlike a button, a text
// field shows its focus ring on a mouse click too) -- if that assumption is ever wrong on the
// exact Chromium build this app ships, the explicit `matches(':focus-visible')` assertion below
// fails loudly rather than silently comparing a meaningless unfocused style.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget,
  citeScreenshots
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import {
  commitPaths,
  commitRepoBaseline,
  fileRowOpenButtonFinder,
  readGroupFileTitles,
  diffViewText,
  BACK_TO_CHANGES_FINDER,
  clickRowMenuItem,
  clickBulkAction,
  typeIntoField,
  clearField,
  SUBJECT_FINDER,
  BODY_FINDER,
  activeElementAriaLabel,
  assertEqual,
  assertArrayEqual
} from './verify-464-git-changes-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_1101_SHOTS_DIR || path.join(tmpdir(), 'refract-1101-git-polish-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// This story's own fixture -- deliberately separate from `verify-464-git-changes-helpers.mjs`'s
// own `FIXTURE` (different scope: no conflicts/staged-new fixture needed here at all).
const FIXTURE = {
  multiline: 'untracked-multiline.txt',
  multilineLines: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
  longTracked: 'long-tracked.txt',
  longTrackedBaseline: 'short baseline content\n',
  bigUntracked: 'big-untracked-for-busy.bin'
};
const MULTILINE_CONTENT = `${FIXTURE.multilineLines.join('\n')}\n`;
const LONG_TRACKED_LINE_COUNT = 150;
const LONG_TRACKED_EDITED = `${Array.from({ length: LONG_TRACKED_LINE_COUNT }, (_, i) => `line ${i + 1} of long-tracked.txt for verify-1101`).join('\n')}\n`;
// 100 MB: large enough that a real `git add` (hash + zlib-deflate + object write) reliably takes
// long enough (hundreds of ms on any real disk/CPU) for a tight CDP poll to observe the busy
// window mid-flight -- never a fixed sleep standing in for the real timing.
const BIG_UNTRACKED_BYTES = 100 * 1024 * 1024;

/** A real computed-style reading for one element's resting (unfocused) box appearance. */
async function readSurfaceStyle(cdp, finderExpr) {
  return cdp.evaluate(
    `(() => { const el = ${finderExpr}; if (!el) return null; const s = getComputedStyle(el); return { borderTopColor: s.borderTopColor, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius }; })()`
  );
}

/** Focuses `clickExpr` with a real CDP click (never a DOM `.focus()` call -- a genuine pointer
 * interaction, matching how a developer actually reaches these fields), asserts the resulting
 * `:focus-visible` state is genuinely true on that same element (Chromium shows a focus ring on
 * a pointer click for a text field, unlike a button), then reads `measureExpr`'s own computed
 * box-shadow/border colour -- a SEPARATE element for the composer, whose visual border/ring
 * lives on the wrapping `has-[textarea:focus-visible]:` div, never on the textarea itself (which
 * is never the thing `document.activeElement` can equal is a plain, unfocusable `<div>`). */
async function readFocusVisibleStyle(cdp, clickExpr, measureExpr, label, findings, failures) {
  await cdp.click(clickExpr);
  const isFocusVisible = await cdp.evaluate(`(() => { const el = ${clickExpr}; return document.activeElement === el && el.matches(':focus-visible'); })()`);
  assertEqual(isFocusVisible, true, `${label}: a real click left it genuinely :focus-visible`, findings, failures);
  return cdp.evaluate(
    `(() => { const el = ${measureExpr}; if (!el) return null; const s = getComputedStyle(el); return { borderTopColor: s.borderTopColor, boxShadow: s.boxShadow }; })()`
  );
}

/** Reads one of the subject counter's three colour tiers via a REAL computed-style comparison:
 * a throwaway reference `<span>` carrying ONLY the expected utility class, appended/measured/
 * removed in the same call, so this proves the counter's OWN resolved colour genuinely equals
 * what that one class resolves to right now -- never just a `classList.contains` string check. */
async function counterMatchesClass(cdp, expectedClass) {
  return cdp.evaluate(`(() => {
    const counter = document.querySelector('input[placeholder="Commit subject"]').nextElementSibling;
    if (!counter) return { matches: false, reason: 'no counter element' };
    const ref = document.createElement('span');
    ref.className = ${JSON.stringify(expectedClass)};
    document.body.appendChild(ref);
    const counterColor = getComputedStyle(counter).color;
    const refColor = getComputedStyle(ref).color;
    ref.remove();
    return { matches: counterColor === refColor, counterColor, refColor };
  })()`);
}

/** The counter's own VISIBLE text only ("10/72"), excluding the `sr-only` "Subject length "
 * prefix span that shares the same parent (`GitCommitBox.tsx`: the prefix is a sibling element,
 * the count itself is plain text node children) -- `textContent` on the whole parent would
 * otherwise read "Subject length 10/72". */
async function readCounterVisibleText(cdp) {
  return cdp.evaluate(`(() => {
    const counter = document.querySelector('input[placeholder="Commit subject"]').nextElementSibling;
    if (!counter) return null;
    return Array.from(counter.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  })()`);
}

/** Gate round 1 (Main E7, `verify-700-todo-pin-helpers.mjs` precedent): moves the pointer INSIDE
 * the viewport (two distinct real moves, a corner then an interior point, so Chromium genuinely
 * fires `pointerleave` on whatever was last hovered), blurs, presses Escape, then FAILS loudly
 * (never just a silent `waitFor` timeout) if a tooltip or hover card is still open. */
async function settleForScreenshot(cdp, findings, failures) {
  const { width, height } = await cdp.evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.floor(width / 2), y: Math.floor(height / 2) });
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await sleep(100);
  const overlayOpen = await cdp.evaluate(
    `!!document.querySelector('[role="tooltip"], [data-slot="tooltip-content"], [data-slot="hover-card-content"]')`
  );
  if (overlayOpen) {
    findings.push('settleForScreenshot: an overlay was still present');
    failures.push('A tooltip or hover card was still open immediately before a screenshot');
  }
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  const screenshotNames = [];

  async function shot(name) {
    await settleForScreenshot(cdp, findings, failures);
    await cdp.screenshot(path.join(SHOTS_DIR, name));
    screenshotNames.push(name);
  }

  const dirtyResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const dirtyLines = dirtyResult.status === 0 ? dirtyResult.stdout.split('\n').filter(Boolean) : null;
  const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length > 0;

  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1101-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1101-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1101-repo-')), 'verify-1101-git-polish');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1101-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1101-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    console.log(`verify-1101: git HEAD ${gitHeadSha}${dirty ? ' (DIRTY)' : ''}`);
    console.log(`verify-1101: shots dir ${SHOTS_DIR}`);

    commitRepoBaseline(repoDir);
    // This story's own extra baseline file (the "long diff to scroll" fixture, item 6/sticky
    // back) -- committed into the REPO before the Session's worktree is created, so it inherits
    // real tracked history, then edited (unstaged) once the worktree exists below.
    writeFileSync(path.join(repoDir, FIXTURE.longTracked), FIXTURE.longTrackedBaseline);
    commitPaths(repoDir, [FIXTURE.longTracked], 'Add long-tracked.txt baseline');

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1101' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1101: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-1101');

    // ---- Add the scratch repo, create a Session, read its real worktreePath. ----
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
      `window.refract.sessions.list().then((r) => { if (!r.ok || !r.value[0]) return null; const s = r.value[0]; return { id: s.id, worktreePath: s.worktreePath }; })`,
      { timeoutMs: 15_000, label: 'Session registered (id/worktreePath readable)' }
    );
    const { id: sessionId, worktreePath } = sessionInfo;
    findings.push(`Session created: id=${sessionId}, worktreePath=${worktreePath}.`);

    // ---- Build this story's own fixture directly in the Session's worktree. ----
    writeFileSync(path.join(worktreePath, FIXTURE.multiline), MULTILINE_CONTENT);
    writeFileSync(path.join(worktreePath, FIXTURE.longTracked), LONG_TRACKED_EDITED);
    writeFileSync(path.join(worktreePath, FIXTURE.bigUntracked), Buffer.alloc(BIG_UNTRACKED_BYTES, 'A'));
    findings.push(`Fixture built: ${FIXTURE.multiline} (${FIXTURE.multilineLines.length} lines, untracked), ${FIXTURE.longTracked} (${LONG_TRACKED_LINE_COUNT} lines, unstaged edit of a tracked file), ${FIXTURE.bigUntracked} (${BIG_UNTRACKED_BYTES} bytes, untracked).`);

    // ---- Open the Git changes panel. ----
    await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
    await cdp.waitFor(`!!(${SUBJECT_FINDER})`, { timeoutMs: 20_000, label: 'Git changes panel loaded (commit box rendered)' });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, ')); return !!b && b.getAttribute('aria-label') === 'Untracked, 2'; })()`,
      { timeoutMs: 20_000, label: 'Untracked group shows both untracked fixture files' }
    );
    await shot('01-initial-panel.png');

    // =========================================================================================
    // Check 1 (item 1): subject counter.
    // =========================================================================================
    const counterHiddenAtZero = await cdp.evaluate(`!document.querySelector('input[placeholder="Commit subject"]').nextElementSibling`);
    assertEqual(counterHiddenAtZero, true, 'Counter hidden on an empty subject field (no bare "0")', findings, failures);

    await typeIntoField(cdp, SUBJECT_FINDER, 'A'.repeat(10));
    const counterText10 = await readCounterVisibleText(cdp);
    assertEqual(counterText10, '10/72', 'Counter text at 10 characters', findings, failures);
    const tier10 = await counterMatchesClass(cdp, 'text-muted-foreground');
    assertEqual(tier10.matches, true, `Counter at 10 chars resolves to the muted colour (got ${JSON.stringify(tier10)})`, findings, failures);
    const srLabel = await cdp.evaluate(`document.querySelector('input[placeholder="Commit subject"]').nextElementSibling?.querySelector('span.sr-only')?.textContent.trim() ?? null`);
    assertEqual(srLabel, 'Subject length', 'Counter carries an sr-only "Subject length" accessible prefix', findings, failures);

    await clearField(cdp, SUBJECT_FINDER);
    await typeIntoField(cdp, SUBJECT_FINDER, 'B'.repeat(55));
    const counterText55 = await readCounterVisibleText(cdp);
    assertEqual(counterText55, '55/72', 'Counter text at 55 characters', findings, failures);
    const tier55 = await counterMatchesClass(cdp, 'text-severity-warning');
    assertEqual(tier55.matches, true, `Counter past 50 chars resolves to the warning colour (got ${JSON.stringify(tier55)})`, findings, failures);
    await shot('02-counter-warning.png');

    await clearField(cdp, SUBJECT_FINDER);
    await typeIntoField(cdp, SUBJECT_FINDER, 'C'.repeat(80));
    const counterText80 = await readCounterVisibleText(cdp);
    assertEqual(counterText80, '80/72', 'Counter text at 80 characters', findings, failures);
    const tier80 = await counterMatchesClass(cdp, 'text-severity-error');
    assertEqual(tier80.matches, true, `Counter past 72 chars resolves to the error colour (got ${JSON.stringify(tier80)})`, findings, failures);
    await shot('03-counter-error.png');

    await clearField(cdp, SUBJECT_FINDER);
    const counterGoneAgain = await cdp.evaluate(`!document.querySelector('input[placeholder="Commit subject"]').nextElementSibling`);
    assertEqual(counterGoneAgain, true, 'Counter hides again once the subject is cleared back to empty', findings, failures);

    // =========================================================================================
    // Check 2 (item 2): commit inputs reuse the composer's own surface/border/focus classes.
    // =========================================================================================
    // The previous check's own final `clearField` left the Subject input focused -- blur
    // everything first so these "resting" reads are genuinely unfocused, not a stray leftover
    // focus state from Check 1.
    await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
    const COMPOSER_WRAPPER = `document.querySelector('[aria-label="Message"]')?.closest('.border-composer-border')`;
    const composerRestingBefore = await readSurfaceStyle(cdp, COMPOSER_WRAPPER);
    const subjectResting = await readSurfaceStyle(cdp, SUBJECT_FINDER);
    const bodyResting = await readSurfaceStyle(cdp, BODY_FINDER);
    assertEqual(subjectResting?.borderTopColor, composerRestingBefore?.borderTopColor, `Subject field resting border colour matches the composer's own (composer=${composerRestingBefore?.borderTopColor})`, findings, failures);
    assertEqual(subjectResting?.backgroundColor, composerRestingBefore?.backgroundColor, 'Subject field resting background colour matches the composer', findings, failures);
    assertEqual(bodyResting?.borderTopColor, composerRestingBefore?.borderTopColor, 'Body field resting border colour matches the composer', findings, failures);
    assertEqual(bodyResting?.backgroundColor, composerRestingBefore?.backgroundColor, 'Body field resting background colour matches the composer', findings, failures);

    const MESSAGE_TEXTAREA = `document.querySelector('[aria-label="Message"]')`;
    const composerFocused = await readFocusVisibleStyle(cdp, MESSAGE_TEXTAREA, COMPOSER_WRAPPER, 'Composer textarea', findings, failures);
    const subjectFocused = await readFocusVisibleStyle(cdp, SUBJECT_FINDER, SUBJECT_FINDER, 'Commit subject field', findings, failures);
    assertEqual(subjectFocused?.borderTopColor, composerFocused?.borderTopColor, `Subject field's own :focus-visible border colour matches the composer's (composer=${composerFocused?.borderTopColor})`, findings, failures);
    assertEqual(subjectFocused?.boxShadow, composerFocused?.boxShadow, `Subject field's own :focus-visible ring (box-shadow) matches the composer's`, findings, failures);
    const bodyFocused = await readFocusVisibleStyle(cdp, BODY_FINDER, BODY_FINDER, 'Commit body field', findings, failures);
    assertEqual(bodyFocused?.borderTopColor, composerFocused?.borderTopColor, "Body field's own :focus-visible border colour matches the composer's", findings, failures);
    assertEqual(bodyFocused?.boxShadow, composerFocused?.boxShadow, "Body field's own :focus-visible ring (box-shadow) matches the composer's", findings, failures);
    await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);

    // =========================================================================================
    // Check 3 (item 3): stage/unstage in-progress state -- per-row, then per-group bulk.
    // =========================================================================================
    const rowBusyFinder = `document.querySelector('span[title=${JSON.stringify(FIXTURE.bigUntracked)}]')?.closest('[aria-busy]')`;
    await clickRowMenuItem(cdp, FIXTURE.bigUntracked, `Stage ${FIXTURE.bigUntracked}`);
    const rowBusySnapshot = await cdp.waitFor(
      `(() => { const row = (${rowBusyFinder}); if (!row || row.getAttribute('aria-busy') !== 'true') return null; const kebab = row.querySelector('[aria-label^="More actions for"]'); return { spinner: !!row.querySelector('svg.animate-spin'), kebabDisabled: kebab ? kebab.getAttribute('aria-disabled') === 'true' : null }; })()`,
      { timeoutMs: 5_000, intervalMs: 15, label: 'Row aria-busy="true" observed mid-flight while staging a 100 MB file' }
    );
    assertEqual(rowBusySnapshot?.spinner, true, 'Row shows a spinner icon while its own stage is in flight', findings, failures);
    assertEqual(rowBusySnapshot?.kebabDisabled, true, "Row's own kebab trigger is aria-disabled while its stage is in flight", findings, failures);
    await shot('04-busy-staging-big-file.png');
    await cdp.waitFor(`(() => { const row = (${rowBusyFinder}); return !!row && row.getAttribute('aria-busy') !== 'true'; })()`, {
      timeoutMs: 30_000,
      label: 'Row aria-busy cleared once the big-file stage settles'
    });
    assertArrayEqual(await readGroupFileTitles(cdp, 'Staged'), [FIXTURE.bigUntracked], 'big-untracked-for-busy.bin reaches Staged once its own in-flight stage settles', findings, failures);

    // Bulk "Stage all" (per-group control): unstage the big file back to Untracked (alongside
    // the already-untracked multiline fixture), then stage BOTH via the group's own bulk button.
    await clickRowMenuItem(cdp, FIXTURE.bigUntracked, `Unstage ${FIXTURE.bigUntracked}`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, ')); return !!b && b.getAttribute('aria-label') === 'Untracked, 2'; })()`,
      { timeoutMs: 15_000, label: 'Both untracked fixture files back in Untracked before the bulk check' }
    );
    const bulkButtonFinder = `document.querySelector('[aria-label="Stage all in Untracked"]')`;
    await clickBulkAction(cdp, 'Stage all in Untracked');
    const bulkBusySnapshot = await cdp.waitFor(
      `(() => { const btn = (${bulkButtonFinder}); if (!btn || btn.getAttribute('aria-busy') !== 'true') return null; return { spinner: !!btn.querySelector('svg.animate-spin'), disabled: btn.getAttribute('aria-disabled') === 'true' }; })()`,
      { timeoutMs: 5_000, intervalMs: 15, label: 'Group bulk button aria-busy="true" observed mid-flight while staging both untracked files' }
    );
    assertEqual(bulkBusySnapshot?.spinner, true, 'Bulk "Stage all" button shows a spinner icon while its own call is in flight', findings, failures);
    assertEqual(bulkBusySnapshot?.disabled, true, 'Bulk "Stage all" button is aria-disabled while its own call is in flight', findings, failures);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, '))`, {
      timeoutMs: 30_000,
      label: 'Untracked group gone once the bulk Stage-all settles'
    });
    assertArrayEqual(
      await readGroupFileTitles(cdp, 'Staged'),
      [FIXTURE.bigUntracked, FIXTURE.multiline],
      'Both untracked fixture files reach Staged once the bulk Stage-all settles',
      findings,
      failures
    );
    // Reset: unstage both so the multiline file is back in Untracked for Check 4 below.
    await clickBulkAction(cdp, 'Unstage all in Staged');
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, ')); return !!b && b.getAttribute('aria-label') === 'Untracked, 2'; })()`,
      { timeoutMs: 15_000, label: 'Both fixture files back in Untracked after the reset' }
    );

    // =========================================================================================
    // Check 4 (item 4): an untracked file's diff shows its whole content as additions.
    // =========================================================================================
    await cdp.click(fileRowOpenButtonFinder(FIXTURE.multiline));
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for the untracked multiline file' });
    const multilineDiffText = await diffViewText(cdp);
    for (const line of FIXTURE.multilineLines) {
      if (!multilineDiffText || !multilineDiffText.includes(line)) failures.push(`Untracked file diff did not show its own real line "${line}": ${JSON.stringify(multilineDiffText)}`);
    }
    if (multilineDiffText && !multilineDiffText.includes('No changes')) findings.push('Untracked file diff shows real content, not the "No changes" empty-box fallback.');
    else failures.push(`Untracked file diff rendered as empty/"No changes": ${JSON.stringify(multilineDiffText)}`);
    const diffRowCounts = await cdp.evaluate(
      `({ inserts: document.querySelectorAll('.diff-view .diff-code-insert').length, deletes: document.querySelectorAll('.diff-view .diff-code-delete').length })`
    );
    assertEqual(diffRowCounts.inserts, FIXTURE.multilineLines.length, `Untracked file diff renders exactly ${FIXTURE.multilineLines.length} insertion rows (one per real line)`, findings, failures);
    assertEqual(diffRowCounts.deletes, 0, 'Untracked file diff renders zero deletion rows (the whole file is additions, never a removal)', findings, failures);
    await shot('05-untracked-diff-additions.png');
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes after the untracked-diff check' });

    // =========================================================================================
    // Check 5 (items 5/6): Back button accessible name, and sticky while the diff scrolls.
    // =========================================================================================
    await cdp.click(fileRowOpenButtonFinder(FIXTURE.longTracked));
    await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: 'Diff view rendered for long-tracked.txt' });
    const backAriaLabel = await activeElementAriaLabel(cdp);
    assertEqual(backAriaLabel, `Back to changes from ${FIXTURE.longTracked}`, "Back button's aria-label names the real open file", findings, failures);

    const scrollRegionFinder = `document.querySelector('.diff-view')?.closest('.overflow-auto')`;
    const rectBefore = await cdp.evaluate(`(() => { const btn = (${BACK_TO_CHANGES_FINDER}); const r = btn.getBoundingClientRect(); return { top: r.top, left: r.left }; })()`);
    const scrollPoint = await cdp.evaluate(`(() => { const r = (${scrollRegionFinder}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (let i = 0; i < 6; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollPoint.x, y: scrollPoint.y, deltaX: 0, deltaY: 400 });
      await sleep(80);
    }
    const scrollTopAfter = await cdp.evaluate(`(${scrollRegionFinder}).scrollTop`);
    assertEqual(scrollTopAfter > 0, true, `The long diff's own scroll region genuinely scrolled (scrollTop=${scrollTopAfter})`, findings, failures);
    await shot('06-long-diff-scrolled-sticky-back.png');
    const rectAfter = await cdp.evaluate(`(() => { const btn = (${BACK_TO_CHANGES_FINDER}); const r = btn.getBoundingClientRect(); return { top: r.top, left: r.left }; })()`);
    const stuckInPlace = Math.abs(rectAfter.top - rectBefore.top) < 2 && Math.abs(rectAfter.left - rectBefore.left) < 2;
    assertEqual(stuckInPlace, true, `Back button's own bounding rect is unchanged after scrolling (sticky) -- before=${JSON.stringify(rectBefore)}, after=${JSON.stringify(rectAfter)}`, findings, failures);
    const coveredByOther = await cdp.evaluate(
      `(() => { const btn = (${BACK_TO_CHANGES_FINDER}); const r = btn.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && !btn.contains(hit) && hit !== btn; })()`
    );
    assertEqual(coveredByOther, false, 'Back button is still genuinely hit-testable at its own position after scrolling (nothing scrolled over it)', findings, failures);
    await cdp.click(BACK_TO_CHANGES_FINDER);
    await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label: 'Back to changes after the sticky-back check' });

    const report = {
      gitHead: gitHeadSha,
      dirty,
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
    console.log('\n=== verify-1101: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1101: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1101: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1101: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-1101: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-1101: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
