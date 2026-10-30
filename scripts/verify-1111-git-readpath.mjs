#!/usr/bin/env node
// Live CDP check for #1111: Git panel read-path hardening (junction/symlink containment, binary/image/non-ASCII
// diffs, diff scroll containment, focus after a failed stage, 8.3 `.git` alias). Scratch data dir, repo and exe only.
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node scripts/verify-1111-git-readpath.mjs
// (requires a prior `pnpm tauri build --debug --no-bundle`).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  citeScreenshots,
  computeDirty
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository, pressTab } from './verify-tauri-session-list-helpers.mjs';
import { commitRepoBaseline, SUBJECT_FINDER, assertEqual, fileRowActionsFinder, readRowDiffStatAccessibleText } from './verify-464-git-changes-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_1111_SHOTS_DIR || path.join(tmpdir(), 'refract-1111-git-readpath-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const BINARY_FILE = 'untracked-binary-for-verify-1111.bin';
const LONG_DIFF_FILE = 'untracked-long-diff-for-verify-1111.txt';
const FAIL_STAGE_FILE = 'untracked-fail-stage-for-verify-1111.txt';
const SYMLINK_TARGET_FILE = 'untracked-symlink-target-for-verify-1111.txt';
const SYMLINK_TARGET_CONTENT = 'target file content -- must NEVER appear in the symlink row\'s own diff, verify-1111\n';
const SYMLINK_NAME = 'untracked-symlink-for-verify-1111.txt';
const NON_ASCII_FILE = 'caf\u00e9-for-verify-1111.txt';
const NON_ASCII_CONTENT = 'content for the non-ASCII-named untracked file, verify-1111\n';
const PNG_FILE = 'untracked-image-for-verify-1111.png';
const UNTRACKED_FIXTURE_COUNT = 7; // binary, long-diff, fail-stage, symlink target, symlink, non-ASCII, PNG
const LONG_DIFF_LINE_COUNT = 400;
const JUNCTION_NAME = 'escaping-junction-for-verify-1111';
const JUNCTION_SECRET_FILE = 'secret.txt';
const JUNCTION_SECRET_MARKER = 'OUTSIDE-WORKTREE-JUNCTION-SECRET-MUST-NEVER-LEAK-1111';
const GIT_SHORT_NAME_SECRET_MARKER = 'GIT-SHORT-NAME-SECRET-MUST-NEVER-LEAK-1111';

/** Blurs focus and waits out any stray tooltip/menu before a screenshot. */
async function settleForScreenshot(cdp) {
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.waitFor(`document.querySelectorAll('[role="tooltip"]').length === 0`, { timeoutMs: 5_000, label: 'No stray tooltip before screenshot' });
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'No stray open menu before screenshot' });
}

/** Opens the diff for one untracked row via a real click, returning its `.diff-view` textContent. */
async function openUntrackedDiff(cdp, fileName) {
  await cdp.click(`Array.from(document.querySelectorAll('span[title=${JSON.stringify(fileName)}]')).map((el) => el.closest('button')).find(Boolean)`);
  await cdp.waitFor(`!!document.querySelector('.diff-view')`, { timeoutMs: 15_000, label: `Diff view rendered for ${fileName}` });
  return cdp.evaluate(`document.querySelector('.diff-view')?.textContent ?? null`);
}

async function backToChanges(cdp, label) {
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Back to changes from '))`);
  await cdp.waitFor(`!document.querySelector('.diff-view')`, { timeoutMs: 10_000, label });
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
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, name));
    screenshotNames.push(name);
  }

  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1111-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1111-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1111-repo-')), 'verify-1111-git-readpath');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1111-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1111-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    console.log(`verify-1111: git HEAD ${gitHeadSha}${computeDirty(REPO_ROOT) ? ' (DIRTY)' : ''}`);

    commitRepoBaseline(repoDir);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1111' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1111: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-1111');

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

    writeFileSync(path.join(worktreePath, BINARY_FILE), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x41, 0x42, 0x43]));
    writeFileSync(
      path.join(worktreePath, LONG_DIFF_FILE),
      `${Array.from({ length: LONG_DIFF_LINE_COUNT }, (_, i) => `line ${i + 1} of a long diff for verify-1111, padded to force real wrapping and scroll height`).join('\n')}\n`
    );
    writeFileSync(path.join(worktreePath, FAIL_STAGE_FILE), 'content for the forced-stage-failure fixture, verify-1111\n');
    writeFileSync(path.join(worktreePath, SYMLINK_TARGET_FILE), SYMLINK_TARGET_CONTENT);
    symlinkSync(path.join(worktreePath, SYMLINK_TARGET_FILE), path.join(worktreePath, SYMLINK_NAME), 'file');
    writeFileSync(path.join(worktreePath, NON_ASCII_FILE), NON_ASCII_CONTENT);
    // PNG detection only sniffs the 8-byte signature, so the fixture need not be decodable.
    writeFileSync(path.join(worktreePath, PNG_FILE), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]));
    findings.push(`Fixtures built: ${BINARY_FILE} (binary), ${LONG_DIFF_FILE} (${LONG_DIFF_LINE_COUNT} lines), ${FAIL_STAGE_FILE}, ${SYMLINK_TARGET_FILE} + ${SYMLINK_NAME} (in-worktree symlink), ${NON_ASCII_FILE} (non-ASCII name), ${PNG_FILE} (PNG).`);

    await cdp.click(`document.querySelector('[data-rail-button="git-changes"]')`);
    await cdp.waitFor(`!!(${SUBJECT_FINDER})`, { timeoutMs: 20_000, label: 'Git changes panel loaded (commit box rendered)' });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((el) => (el.getAttribute('aria-label')||'').startsWith('Untracked, ')); return !!b && b.getAttribute('aria-label') === ${JSON.stringify(`Untracked, ${UNTRACKED_FIXTURE_COUNT}`)}; })()`,
      { timeoutMs: 20_000, label: `Untracked group shows all ${UNTRACKED_FIXTURE_COUNT} fixture entries` }
    );
    await shot('01-initial-panel.png');

    // Git's untracked walk does not treat a junction as a symlink and recurses through it, so the resolver must still refuse the escape.
    const outsideJunctionDir = mkdtempSync(path.join(tmpdir(), 'refract-1111-outside-junction-'));
    writeFileSync(path.join(outsideJunctionDir, JUNCTION_SECRET_FILE), `${JUNCTION_SECRET_MARKER}\n`);
    const junctionPath = path.join(worktreePath, JUNCTION_NAME);
    symlinkSync(outsideJunctionDir, junctionPath, 'junction');
    const junctionRelPath = `${JUNCTION_NAME}/${JUNCTION_SECRET_FILE}`;
    await cdp.waitFor(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); return !!ul && Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(junctionRelPath)}); })()`,
      { timeoutMs: 15_000, label: 'File inside the escaping junction rendered as its own Untracked row (proves git walked straight through the junction)' }
    );
    const junctionBadge = await readRowDiffStatAccessibleText(cdp, 'Untracked', junctionRelPath);
    assertEqual(junctionBadge, '0 additions, 0 deletions', "The escaping junction's own row badge scores 0 additions (never read to produce a real count)", findings, failures);
    const junctionDiffAttempt = await cdp.evaluate(
      `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(junctionRelPath)}, false, true).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message, patch: r.ok ? r.value.patch : null }))`
    );
    if (junctionDiffAttempt.ok) failures.push(`Escaping junction (parent folder): gitChanges.diff SUCCEEDED (patch=${JSON.stringify(junctionDiffAttempt.patch)}) -- must always be refused.`);
    else if (junctionDiffAttempt.code !== 'outside-worktree') failures.push(`Escaping junction (parent folder): refused, but with code "${junctionDiffAttempt.code}" (expected "outside-worktree") -- message: ${junctionDiffAttempt.message}`);
    else findings.push(`Escaping junction (parent folder): refused with code "outside-worktree" (${junctionDiffAttempt.message}).`);
    const junctionLeaked = Boolean(junctionDiffAttempt.message?.includes(JUNCTION_SECRET_MARKER)) || Boolean(junctionDiffAttempt.patch?.includes(JUNCTION_SECRET_MARKER));
    if (junctionLeaked) failures.push('Escaping-junction secret content LEAKED into the diff response (patch or error message) -- must never happen.');
    else findings.push('Escaping-junction secret content never appears in the diff response (patch OR error message): confirmed absent.');
    // Backslash token: the resolver used to see an empty parent and skip the parent containment walk. IPC only, since no UI path produces one.
    const junctionRelPathBackslash = `${JUNCTION_NAME}\\${JUNCTION_SECRET_FILE}`;
    const junctionBackslashDiffAttempt = await cdp.evaluate(
      `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(junctionRelPathBackslash)}, false, true).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message, patch: r.ok ? r.value.patch : null }))`
    );
    if (junctionBackslashDiffAttempt.ok) failures.push(`Escaping junction via a BACKSLASH token (${junctionRelPathBackslash}): gitChanges.diff SUCCEEDED (patch=${JSON.stringify(junctionBackslashDiffAttempt.patch)}) -- must always be refused (gate round 3 CRITICAL: backslash bypass).`);
    else if (junctionBackslashDiffAttempt.code !== 'outside-worktree') failures.push(`Escaping junction via a BACKSLASH token: refused, but with code "${junctionBackslashDiffAttempt.code}" (expected "outside-worktree") -- message: ${junctionBackslashDiffAttempt.message}`);
    else findings.push(`Escaping junction via a BACKSLASH token (${junctionRelPathBackslash}): refused with code "outside-worktree" (${junctionBackslashDiffAttempt.message}).`);
    const junctionBackslashLeaked = Boolean(junctionBackslashDiffAttempt.message?.includes(JUNCTION_SECRET_MARKER)) || Boolean(junctionBackslashDiffAttempt.patch?.includes(JUNCTION_SECRET_MARKER));
    if (junctionBackslashLeaked) failures.push('Escaping-junction secret content LEAKED into the diff response via a BACKSLASH token -- must never happen.');
    else findings.push('Escaping-junction secret content never appears in the diff response via a BACKSLASH token: confirmed absent.');
    rmSync(junctionPath, { force: true });
    await safeRmSync(outsideJunctionDir);
    await cdp.waitFor(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); if (!ul) return true; return !Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(junctionRelPath)}); })()`,
      { timeoutMs: 15_000, label: 'Escaping-junction fixture torn down, gone from Untracked' }
    );

    // A symlink's untracked blob is its target string (one line); the resolver must classify the unresolved leaf, not read through it.
    const symlinkBadge = await readRowDiffStatAccessibleText(cdp, 'Untracked', SYMLINK_NAME);
    assertEqual(symlinkBadge, '1 addition, 0 deletions', "The in-worktree symlink's own row badge scores exactly +1 (git's own view: its target string is one line)", findings, failures);
    const symlinkDiffText = await openUntrackedDiff(cdp, SYMLINK_NAME);
    const symlinkShowsTargetPath = Boolean(symlinkDiffText && symlinkDiffText.replaceAll('\\', '/').includes(SYMLINK_TARGET_FILE));
    assertEqual(symlinkShowsTargetPath, true, `The in-worktree symlink's diff shows its own target path (got ${JSON.stringify(symlinkDiffText)})`, findings, failures);
    const symlinkLeakedTargetContent = Boolean(symlinkDiffText && symlinkDiffText.includes(SYMLINK_TARGET_CONTENT.trim()));
    if (symlinkLeakedTargetContent) failures.push(`The in-worktree symlink's diff read THROUGH to its target file's real content -- must never happen: ${JSON.stringify(symlinkDiffText)}`);
    else findings.push("The in-worktree symlink's diff never reads through to its target file's real content: confirmed absent.");
    await shot('02-in-worktree-symlink-target-text.png');
    await backToChanges(cdp, 'Back to changes after the in-worktree symlink check');

    const binaryDiffText = await openUntrackedDiff(cdp, BINARY_FILE);
    assertEqual(binaryDiffText?.includes('Binary file') ?? false, true, `Binary untracked file's diff shows "Binary file" (got ${JSON.stringify(binaryDiffText)})`, findings, failures);
    const binaryFallsBackToNoChanges = binaryDiffText?.includes('No changes') ?? true;
    if (binaryFallsBackToNoChanges) failures.push(`Binary untracked file's diff fell back to the indistinguishable "No changes" text instead of naming the reason: ${JSON.stringify(binaryDiffText)}`);
    else findings.push('Binary untracked file never falls back to the indistinguishable "No changes" text: confirmed, "Binary file" names the reason instead.');
    await shot('03-binary-untracked-reason.png');
    await backToChanges(cdp, 'Back to changes after the binary-file check');

    const nonAsciiDiffText = await openUntrackedDiff(cdp, NON_ASCII_FILE);
    const nonAsciiShowsContent = Boolean(nonAsciiDiffText && nonAsciiDiffText.includes(NON_ASCII_CONTENT.trim()));
    assertEqual(nonAsciiShowsContent, true, `The non-ASCII-named untracked file's diff shows its real content (got ${JSON.stringify(nonAsciiDiffText)})`, findings, failures);
    await shot('06-non-ascii-content.png');
    await backToChanges(cdp, 'Back to changes after the non-ASCII-name check');

    const pngDiffText = await openUntrackedDiff(cdp, PNG_FILE);
    assertEqual(pngDiffText?.includes('Image file') ?? false, true, `Untracked PNG's diff shows "Image file" (got ${JSON.stringify(pngDiffText)})`, findings, failures);
    await shot('07-png-image-file.png');
    await backToChanges(cdp, 'Back to changes after the PNG check');

    await openUntrackedDiff(cdp, LONG_DIFF_FILE);
    await sleep(300);
    const windowScroll = await cdp.evaluate(
      `({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight })`
    );
    assertEqual(windowScroll.scrollWidth <= windowScroll.innerWidth, true, `No window-level HORIZONTAL scrollbar on a long diff (scrollWidth=${windowScroll.scrollWidth}, innerWidth=${windowScroll.innerWidth})`, findings, failures);
    assertEqual(windowScroll.scrollHeight <= windowScroll.innerHeight, true, `No window-level VERTICAL scrollbar on a long diff (scrollHeight=${windowScroll.scrollHeight}, innerHeight=${windowScroll.innerHeight})`, findings, failures);
    await shot('04-long-diff-no-window-scrollbar.png');
    await backToChanges(cdp, 'Back to changes after the long-diff check');

    // A real index.lock forces the failure (a deleted fixture would race the watcher debounce). Focus return and
    // Tab-away are proven on separate attempts: tabbing elsewhere deliberately stops focus being stolen back.
    const realGitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], { encoding: 'utf8', windowsHide: true }).trim();
    const absoluteGitDir = path.isAbsolute(realGitDir) ? realGitDir : path.join(worktreePath, realGitDir);
    const indexLockPath = path.join(absoluteGitDir, 'index.lock');
    const kebabFinder = fileRowActionsFinder(FAIL_STAGE_FILE);

    async function keyboardTriggerStage() {
      await cdp.evaluate(`(() => { (${kebabFinder}).focus(); })()`);
      await cdp.pressEnter();
      await cdp.waitFor(`!!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 10_000, label: 'Row actions menu opened via keyboard Enter' });
      await sleep(100); // lets Radix settle its own default first-item focus before the next Enter
      await cdp.pressEnter();
      await cdp.waitFor(`!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 10_000, label: 'Row actions menu closed after keyboard-selecting Stage' });
    }

    // D1: no Tab-away -- focus naturally lands back on the kebab once the failure settles.
    writeFileSync(indexLockPath, '');
    await keyboardTriggerStage();
    await cdp.waitFor(`(() => { const el = (${kebabFinder}); return !!el && el.getAttribute('aria-disabled') !== 'true'; })()`, {
      timeoutMs: 15_000,
      label: 'D1: forced stage failure settled (kebab no longer aria-disabled)'
    });
    rmSync(indexLockPath, { force: true });
    const focusAfterFailure = await cdp.evaluate(`(() => { const kebab = (${kebabFinder}); return document.activeElement === kebab; })()`);
    assertEqual(focusAfterFailure, true, "D1: focus lands back on the SAME row's kebab trigger after a failed stage (never <body>)", findings, failures);
    await shot('05-focus-after-failed-stage.png');

    // D2: Tab WHILE pending moves focus OFF the kebab -- never a keyboard trap.
    writeFileSync(indexLockPath, '');
    await keyboardTriggerStage();
    const pendingBeforeTab = await cdp.waitFor(
      `(() => { const kebab = (${kebabFinder}); if (!kebab || kebab.getAttribute('aria-disabled') !== 'true') return null; return document.activeElement === kebab; })()`,
      { timeoutMs: 5_000, intervalMs: 15, label: 'D2: kebab aria-disabled="true" and still focused, observed mid-flight' }
    );
    assertEqual(pendingBeforeTab, true, 'D2: the pending kebab still has focus just before pressing Tab', findings, failures);
    await pressTab(cdp);
    await sleep(50);
    const focusAfterTabWhilePending = await cdp.evaluate(`(() => { const kebab = (${kebabFinder}); return document.activeElement === kebab; })()`);
    // Assert the inverted boolean against true so a pass prints "...: true" instead of reading like a failure.
    const focusMovedOffPendingKebab = !focusAfterTabWhilePending;
    assertEqual(focusMovedOffPendingKebab, true, 'D2: Tab moved focus OFF the pending kebab trigger (never a keyboard trap while a stage is in flight)', findings, failures);
    await cdp.waitFor(`(() => { const el = (${kebabFinder}); return !!el && el.getAttribute('aria-disabled') !== 'true'; })()`, {
      timeoutMs: 15_000,
      label: 'D2: forced stage failure settled (kebab no longer aria-disabled)'
    });
    rmSync(indexLockPath, { force: true });
    const stillUntracked = await cdp.evaluate(
      `(() => { const ul = document.querySelector('[aria-label="Untracked files"]'); return !!ul && Array.from(ul.querySelectorAll('li span[title]')).some((el) => el.getAttribute('title') === ${JSON.stringify(FAIL_STAGE_FILE)}); })()`
    );
    assertEqual(stillUntracked, true, 'The forced-failure fixture is still in Untracked after both D1 and D2 (the stage genuinely failed both times, not a flake)', findings, failures);

    // `.git` must be a real directory that still works as a repo (a worktree's gitfile never is), so absorb the worktree's admin dir
    // and make `commondir` absolute. An empty `.git` makes git refuse every command. Skipped if 8.3 name generation is disabled.
    const gitFilePath = path.join(worktreePath, '.git');
    const gitFileContent = readFileSync(gitFilePath, 'utf8');
    const adminDirMatch = gitFileContent.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!adminDirMatch) throw new Error(`verify-1111: worktree's own ".git" file did not have the expected "gitdir: <path>" shape: ${JSON.stringify(gitFileContent)}`);
    const adminDir = path.isAbsolute(adminDirMatch[1]) ? adminDirMatch[1] : path.resolve(worktreePath, adminDirMatch[1]);
    rmSync(gitFilePath, { force: true });
    renameSync(adminDir, gitFilePath);
    writeFileSync(path.join(gitFilePath, 'commondir'), `${path.join(repoDir, '.git')}\n`);
    writeFileSync(path.join(gitFilePath, 'config'), `${GIT_SHORT_NAME_SECRET_MARKER}\n`, { flag: 'a' });
    const postAbsorbStatus = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    findings.push(`Check E setup: ".git" absorbed into a real directory (commondir -> ${repoDir}\\.git); "git status" still runs (${postAbsorbStatus.trim().length} bytes of porcelain output), proving this is a genuinely functioning repo, not a broken one.`);
    const shortNameAlias = path.join(worktreePath, 'GIT~1');
    if (!existsSync(shortNameAlias)) {
      const message = '8.3 short-name alias "GIT~1" does not exist for this worktree\'s ".git" directory (8.3 name generation may be disabled on this volume) -- skipped.';
      if (process.env.CI) failures.push(`Check E: ${message} (expected to exist in CI)`);
      else notExercised.push(`Check E (GIT~1/config refusal): ${message}`);
    } else {
      const shortNameDiffAttempt = await cdp.evaluate(
        `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, 'GIT~1/config', false, true).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message, patch: r.ok ? r.value.patch : null }))`
      );
      // Both outcomes are safe; the invariant is that the secret never leaks (asserted below). Either the post-resolution `.git`
      // refusal fires, or git never surfaces the path and the tracked-file fallback returns an empty patch. Record which fired.
      if (!shortNameDiffAttempt.ok) {
        if (shortNameDiffAttempt.code !== 'outside-worktree') failures.push(`GIT~1/config: refused, but with code "${shortNameDiffAttempt.code}" (expected "outside-worktree") -- message: ${shortNameDiffAttempt.message}`);
        else findings.push(`GIT~1/config: refused by the containment guard with code "outside-worktree" (${shortNameDiffAttempt.message}) -- untracked_file_patch's own post-resolution .git check fired.`);
      } else if (shortNameDiffAttempt.patch === '') {
        findings.push('GIT~1/config: gitChanges.diff succeeded with an EMPTY patch -- confirm_untracked never surfaced this path (git\'s own untracked-walk prunes ".git" by its real name), so it fell through to the harmless tracked-diff path, which found nothing to show.');
      } else {
        failures.push(`GIT~1/config: gitChanges.diff SUCCEEDED with a NON-EMPTY patch (${JSON.stringify(shortNameDiffAttempt.patch)}) -- must never return real content here.`);
      }
      const shortNameLeaked = Boolean(shortNameDiffAttempt.message?.includes(GIT_SHORT_NAME_SECRET_MARKER)) || Boolean(shortNameDiffAttempt.patch?.includes(GIT_SHORT_NAME_SECRET_MARKER));
      if (shortNameLeaked) failures.push('.git/config content (reached via its 8.3 short name) LEAKED into the diff response -- must never happen.');
      else findings.push('.git/config content (reached via its 8.3 short name) never appears in the diff response: confirmed absent.');
      // Same 8.3 name via a backslash token ("GIT~1\config").
      const shortNameBackslashToken = 'GIT~1\\config';
      const shortNameBackslashDiffAttempt = await cdp.evaluate(
        `window.refract.gitChanges.diff(${JSON.stringify(sessionId)}, ${JSON.stringify(shortNameBackslashToken)}, false, true).then((r) => ({ ok: r.ok, code: r.ok ? null : r.error.code, message: r.ok ? null : r.error.message, patch: r.ok ? r.value.patch : null }))`
      );
      if (!shortNameBackslashDiffAttempt.ok) {
        if (shortNameBackslashDiffAttempt.code !== 'outside-worktree') failures.push(`GIT~1\\config: refused, but with code "${shortNameBackslashDiffAttempt.code}" (expected "outside-worktree") -- message: ${shortNameBackslashDiffAttempt.message}`);
        else findings.push(`GIT~1\\config: refused by the containment guard with code "outside-worktree" (${shortNameBackslashDiffAttempt.message}) -- untracked_file_patch's own post-resolution .git check fired via the backslash token.`);
      } else if (shortNameBackslashDiffAttempt.patch === '') {
        findings.push('GIT~1\\config: gitChanges.diff succeeded with an EMPTY patch (backslash token) -- confirm_untracked never surfaced this path, so it fell through to the harmless tracked-diff path.');
      } else {
        failures.push(`GIT~1\\config: gitChanges.diff SUCCEEDED with a NON-EMPTY patch via a BACKSLASH token (${JSON.stringify(shortNameBackslashDiffAttempt.patch)}) -- must never return real content here (gate round 3 CRITICAL: backslash bypass).`);
      }
      const shortNameBackslashLeaked = Boolean(shortNameBackslashDiffAttempt.message?.includes(GIT_SHORT_NAME_SECRET_MARKER)) || Boolean(shortNameBackslashDiffAttempt.patch?.includes(GIT_SHORT_NAME_SECRET_MARKER));
      if (shortNameBackslashLeaked) failures.push('.git/config content (reached via its 8.3 short name, backslash token) LEAKED into the diff response -- must never happen.');
      else findings.push('.git/config content (reached via its 8.3 short name, backslash token) never appears in the diff response: confirmed absent.');
    }

    const report = {
      gitHead: gitHeadSha,
      dirty: computeDirty(REPO_ROOT),
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
    console.log('\n=== verify-1111: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1111: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1111: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1111: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty: computeDirty(REPO_ROOT), exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-1111: FAILED:', err?.stack ?? err);
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
  console.error('verify-1111: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
