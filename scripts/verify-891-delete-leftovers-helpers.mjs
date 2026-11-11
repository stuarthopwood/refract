// Helpers for verify-891-delete-leftovers.mjs (split for the file-size cap): fixture generation,
// holder processes, registry reads, and driving the real Delete dialog over CDP.

import { mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile, statfs } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function readRegistry(dataDir) {
  return JSON.parse(readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
}

/** Counts every real file under `dir` recursively; never follows a symlink, matching the production remover. */
export function countFilesRecursive(dir) {
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) count += countFilesRecursive(full);
    else count++;
  }
  return count;
}

export function sessionByName(dataDir, name) {
  const registry = readRegistry(dataDir);
  const session = registry.sessions.find((s) => s.name === name);
  assert(session, `registry.json has a session named "${name}"`);
  return session;
}

/** Mirrors `git/worktrees.rs`: git's admin dir is `<repo>/.git/worktrees/<basename(worktreePath)>`.
 * Dropping it simulates a leftover UNREGISTERED worktree (scenario b). */
export function dropAdminEntry(repoDir, worktreePath) {
  const name = path.basename(worktreePath);
  assert(name && name.length > 3, `a real worktree folder name, got ${JSON.stringify(name)}`);
  const adminDir = path.join(repoDir, '.git', 'worktrees', name);
  assert(adminDir.includes('.git') && adminDir.includes('worktrees'), `adminDir looks like a real git admin path: ${adminDir}`);
  rmSync(adminDir, { recursive: true, force: true });
  return adminDir;
}

/** Confirms git no longer lists `worktreePath`. Compares normalised per-line porcelain entries, not substrings,
 * so a lookalike sibling path cannot false-positive and a case/alias difference cannot false-negative. */
export function isRegisteredWorktree(repoDir, worktreePath) {
  const result = spawnSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const normalize = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const wanted = normalize(worktreePath);
  const registered = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalize(line.slice('worktree '.length).trim()));
  return registered.includes(wanted);
}

/** Scenario (a): a real-world-shaped worktree (thousands of files under `node_modules`, a >260-char path, read-only files)
 * with a junction OUTSIDE the worktree to `canaryDir`; the canary's files must survive deletion untouched. */
export function populateFullWorktree(worktreePath, canaryDir) {
  mkdirSync(canaryDir, { recursive: true });
  const canaryFile = path.join(canaryDir, 'canary.txt');
  writeFileSync(canaryFile, 'do not touch -- outside the worktree');
  // Read-only: a removal that escaped containment would also have to clear this attribute.
  chmodSync(canaryFile, 0o444);

  const nodeModules = path.join(worktreePath, 'patient', 'client', 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  let fileCount = 0;
  for (let pkg = 0; pkg < 20; pkg++) {
    const pkgDir = path.join(nodeModules, `pkg-${pkg}`);
    mkdirSync(pkgDir, { recursive: true });
    for (let f = 0; f < 120; f++) {
      writeFileSync(path.join(pkgDir, `file-${f}.js`), `// generated ${pkg}-${f}\n`);
      fileCount++;
    }
  }

  // Junction whose target is outside the worktree: must never be followed or deleted through.
  const junction = path.join(nodeModules, 'linked-store');
  const result = spawnSync('cmd', ['/C', 'mklink', '/J', junction, canaryDir], { encoding: 'utf8', windowsHide: true });
  assert(result.status === 0, `mklink /J created the junction: ${result.stderr || result.stdout}`);

  // Over the 260-character MAX_PATH limit.
  let deep = path.join(worktreePath, 'deep');
  const longName = 'a'.repeat(60);
  for (let i = 0; i < 4; i++) deep = path.join(deep, longName);
  mkdirSync(deep, { recursive: true });
  const longFile = path.join(deep, 'file.txt');
  writeFileSync(longFile, 'x');
  assert(longFile.length > 260, `the deep file path is over 260 characters (${longFile.length})`);
  fileCount++;

  const readonlyDir = path.join(worktreePath, 'dist');
  mkdirSync(readonlyDir, { recursive: true });
  for (let f = 0; f < 5; f++) {
    const p = path.join(readonlyDir, `locked-${f}.txt`);
    writeFileSync(p, 'locked');
    chmodSync(p, 0o444);
    fileCount++;
  }

  return { canaryFile, fileCount };
}

/** Scenario (b): a plain unregistered leftover folder; proves the ORPHAN path removes it instead of refusing `NotEmpty`. */
export function populateOrphanWorktree(worktreePath) {
  const nodeModules = path.join(worktreePath, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  for (let pkg = 0; pkg < 10; pkg++) {
    const pkgDir = path.join(nodeModules, `pkg-${pkg}`);
    mkdirSync(pkgDir, { recursive: true });
    for (let f = 0; f < 50; f++) {
      writeFileSync(path.join(pkgDir, `file-${f}.js`), 'x');
    }
  }
}

/** Scenario (f): a generated tree large enough that the leftover-summary walk is still running ("Checking files…") when
 * Delete is clicked; `main()` also asserts the status line right before the click. Written asynchronously in bounded
 * chunks: a synchronous 400,000-file write blocked the event loop for ~30 min and killed the CDP socket. The walk only
 * has to outlive the fast git-only `deleteCheck` (~1-2 s on NTFS), so the count is modest and env-overridable. */
export const LARGE_TREE_FILE_COUNT = Number(process.env.VERIFY_891_LARGE_TREE_FILES) || 30_000;
export const LARGE_TREE_MIN_FREE_BYTES = 3 * 1024 ** 3;
const WRITE_CHUNK = 500;

/** Free bytes on the drive holding `dir` (Node 18.15+ statfs). */
export async function freeBytesOn(dir) {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export async function populateLargeGeneratedTree(worktreePath, fileCount = LARGE_TREE_FILE_COUNT) {
  const nodeModules = path.join(worktreePath, 'node_modules');
  await mkdir(nodeModules, { recursive: true });
  const perPkg = 100;
  const pkgCount = Math.ceil(fileCount / perPkg);
  let written = 0;
  let batch = [];
  for (let pkg = 0; pkg < pkgCount && written < fileCount; pkg++) {
    // Nested two levels (group/pkg) so directory count is realistic and no single directory is huge.
    const pkgDir = path.join(nodeModules, `group-${pkg % 50}`, `pkg-${pkg}`, 'lib');
    await mkdir(pkgDir, { recursive: true });
    for (let f = 0; f < perPkg && written < fileCount; f++) {
      batch.push(writeFile(path.join(pkgDir, `file-${f}.js`), 'x'));
      written++;
      if (batch.length >= WRITE_CHUNK) {
        await Promise.all(batch);
        batch = [];
      }
    }
  }
  await Promise.all(batch);
  return { fileCount: written };
}

/** Spawns a bare idle `cmd.exe` whose CURRENT DIRECTORY is inside `cwd` (a handle Restart Manager cannot see).
 * No `/C <command>`: a grandchild would inherit the cwd and outlive the kill. stdin must be an open, never-EOF'd pipe
 * (not 'ignore'/NUL): EOF makes the interactive cmd.exe exit almost at once, so the holder would vanish before the probe. */
export function spawnCwdHolder(cwd) {
  const child = spawn('cmd.exe', [], { cwd, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  return child;
}

/** Spawns a PowerShell process holding one FILE open inside the worktree (the shape Restart Manager's file scan catches). */
export function spawnFileHolder(filePath) {
  const script = `$f = [System.IO.File]::Open('${filePath}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 600`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  return child;
}

export async function killSpawned(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}


function rowActionsFinderByName(name) {
  return `Array.from(document.querySelectorAll('[data-repository-id] li')).find((li) => li.querySelector('[data-session-open]')?.getAttribute('aria-label')?.startsWith(${JSON.stringify(name)}))?.querySelector('button[aria-label^="More actions for "]')`;
}

/** Opens a named Session row's "..." menu and clicks "Delete", waiting for the AlertDialog to mount.
 * Hovers first: the trigger is revealed by `group-hover`, so a bare click can race the reveal. */
export async function openDeleteDialogFor(cdp, name, shotDir) {
  const triggerFinder = rowActionsFinderByName(name);
  const rowFinder = `(${triggerFinder})?.closest('li')`;
  const rowRect = await cdp.waitFor(
    `(() => { const el = ${rowFinder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 15_000, label: `row to hover for "${name}"` }
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
  await cdp.waitFor(
    `(() => { const el = ${triggerFinder}; if (!el) return false; return parseFloat(getComputedStyle(el).opacity) > 0.5; })()`,
    { timeoutMs: 10_000, label: `row actions trigger revealed for "${name}"` }
  );
  await cdp.click(triggerFinder);
  const menuItemFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Delete\u2026')`;
  const itemRect = await cdp.waitFor(
    `(() => { const el = ${menuItemFinder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    { timeoutMs: 10_000, label: 'row menu open with Delete\u2026 item' }
  );
  await cdp.click(menuItemFinder);
  try {
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Delete dialog opened' });
  } catch (err) {
    const diag = await cdp.evaluate(
      `(() => ({ elementAtClickPoint: document.elementFromPoint(${itemRect.x}, ${itemRect.y})?.outerHTML?.slice(0, 300) ?? null, menuStillOpen: !!document.querySelector('[role="menu"]'), menuItemCount: document.querySelectorAll('[role="menuitem"]').length, dialogCount: document.querySelectorAll('[role="alertdialog"]').length, activeElementTag: document.activeElement?.tagName, activeElementLabel: document.activeElement?.getAttribute?.('aria-label') ?? null }))()`
    );
    if (shotDir) await cdp.screenshot(path.join(shotDir, '99-diag-delete-dialog-failure.png'));
    throw new Error(`openDeleteDialogFor("${name}") failed: Delete dialog never opened -- diagnostics: ${JSON.stringify(diag)}. Original: ${err.message}`);
  }
}

/** Waits for BOTH the leftover-summary walk and `deleteCheck` to settle and returns the leftover list text ('' if none).
 * The status line shows only one "Checking…" at a time (`deleteCheck` first), so waiting on the walk's text alone
 * resolved prematurely with an empty list. */
export async function waitForLeftoverSummary(cdp, { timeoutMs = 20_000 } = {}) {
  await waitForDialogSettled(cdp, { timeoutMs });
  return cdp.evaluate(
    `Array.from(document.querySelectorAll('[role="alertdialog"] ul')).map((ul) => ul.textContent).join(' | ')`
  );
}

/** Clicks the AlertDialog's "Delete"/"Retry" button directly: `clickByText({ inDialog })` scopes to `[role="dialog"]`,
 * which a Radix AlertDialog lacks. Waits for `aria-disabled` to clear first: it stays `true` (pointer-events: none)
 * until `deleteCheck` resolves, and a click on it is silently swallowed so the dialog hangs forever.
 * `onReadyToClick` runs after that wait, immediately before the click. */
export async function clickDeleteButton(cdp, { onReadyToClick } = {}) {
  const findButton = `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((el) => el.textContent.trim() === 'Delete' || el.textContent.trim() === 'Retry')`;
  await cdp.waitFor(`(() => { const b = ${findButton}; return !!b && b.getAttribute('aria-disabled') !== 'true'; })()`, {
    timeoutMs: 30_000,
    label: 'Delete/Retry button enabled (deleteCheck resolved)'
  });
  if (onReadyToClick) await onReadyToClick();
  await cdp.click(findButton);
}

/** The dialog's unified `role="status"` line text ('' if missing). Unlike `waitForLeftoverSummary`, this can still be
 * `deleteCheck`'s "Checking for uncommitted or unpushed work…". */
export async function readLeftoverStatusText(cdp) {
  return cdp.evaluate(`document.querySelector('[role="alertdialog"] [role="status"]')?.textContent || ''`);
}

/** Waits until BOTH on-open checks settle: the leftover-summary walk and `deleteCheck`'s git-status read (button
 * `aria-disabled` clears). The single status line shows only whichever is pending, so both must be awaited. */
export async function waitForDialogSettled(cdp, { timeoutMs = 30_000 } = {}) {
  const findButton = `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((el) => el.textContent.trim() === 'Delete' || el.textContent.trim() === 'Retry')`;
  await cdp.waitFor(
    `(() => {
      const statusEl = document.querySelector('[role="alertdialog"] [role="status"]');
      const stillChecking = !!statusEl && statusEl.textContent === 'Checking files…';
      const b = ${findButton};
      const buttonReady = !!b && b.getAttribute('aria-disabled') !== 'true';
      return !stillChecking && buttonReady;
    })()`,
    { timeoutMs, label: 'both deleteCheck and the leftover-summary walk settled' }
  );
}

/** The dialog's own `role="alert"` paragraph -- '' while no error (it stays mounted, `sr-only`,
 * per `DeleteDialog.tsx`'s own convention). */
export async function readDialogError(cdp, { timeoutMs = 15_000 } = {}) {
  return cdp.waitFor(`document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent || null`, { timeoutMs, label: 'dialog error text' });
}

/** Polls until `sessions.list()` reports the Session `name` as anything but `'stopped'`/`null`, resolving to that status.
 * Uses Rust's `SessionAgent::status()`, not a DOM/CSS guess: a refused Delete must leave the agent running. */

export async function waitForSessionAgentRunning(cdp, name, { timeoutMs = 20_000 } = {}) {
  return cdp.waitFor(
    `window.refract.sessions.list().then((r) => { if (!r.ok) return false; const s = r.value.find((s) => s.name === ${JSON.stringify(name)}); return !!s && s.status !== 'stopped' && s.status; })`,
    { timeoutMs, label: `${name} agent running again after refusal` }
  );
}

/** Polls for the dialog closing (success) or a non-empty `role="alert"` error (a failed delete leaves the dialog open
 * by design, so waiting only for "closed" would spin to timeout). Returns `{ closed: true }` or
 * `{ closed: false, error }`; throws only if neither happens within `timeoutMs`. */
export async function waitForDeleteOutcome(cdp, { timeoutMs = 60_000 } = {}) {
  return cdp.waitFor(
    `(() => { if (!document.querySelector('[role="alertdialog"]')) return { closed: true }; const err = document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent; return err ? { closed: false, error: err } : false; })()`,
    { timeoutMs, label: 'delete outcome (closed or errored)' }
  );
}

export async function isSessionListed(cdp, name) {
  return cdp.evaluate(
    `!!Array.from(document.querySelectorAll('[data-session-open]')).find((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(name)}))`
  );
}

/** `sessions.delete` acks once its checks pass and removal finishes afterwards, so a closed dialog is not proof the
 * Session is gone: poll the row and the folder before reading either. */
export async function waitForSessionRemoved(cdp, name, worktreePath, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ((await isSessionListed(cdp, name)) || existsSync(worktreePath))) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Clicks Retry until the Session is gone, logging every attempt's start (ms since the holder exited) and refusal text.
 * A refusal on an attempt that STARTED more than `lagMs` after the exit is a product bug, not Windows handle lag. */
export async function retryDeleteLogged(cdp, { label, name, worktreePath, exitedAt, maxAttempts = 8, lagMs = 3000 }) {
  const attempts = [];
  for (let n = 1; n <= maxAttempts; n++) {
    let startMs = 0;
    // The button is aria-disabled while the post-refusal recheck runs; time the attempt from the click, not the wait.
    await clickDeleteButton(cdp, { onReadyToClick: () => { startMs = Date.now() - exitedAt; } });
    const outcome = await waitForDeleteOutcome(cdp, { timeoutMs: 180_000 });
    if (outcome.closed) {
      await waitForSessionRemoved(cdp, name, worktreePath);
      const gone = !(await isSessionListed(cdp, name)) && !existsSync(worktreePath);
      attempts.push({ n, startMs, endMs: Date.now() - exitedAt, result: gone ? 'removed' : 'acked-but-present' });
      console.log(`${label} Retry attempt ${n}: start +${startMs}ms after holder exit, ${gone ? 'REMOVED' : 'ACKED BUT STILL PRESENT'}`);
      return { attempts, gone, lagBug: attempts.some((a) => a.refusal && a.startMs > lagMs) };
    }
    attempts.push({ n, startMs, endMs: Date.now() - exitedAt, refusal: outcome.error });
    console.log(`${label} Retry attempt ${n}: start +${startMs}ms after holder exit, REFUSED: ${outcome.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { attempts, gone: false, lagBug: attempts.some((a) => a.refusal && a.startMs > lagMs) };
}
