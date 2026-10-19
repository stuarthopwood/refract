// Helper functions for verify-891-delete-leftovers.mjs, split out to keep that file under the
// repo's 600-line soft cap (scripts/check-file-size.mjs). Content-generation (junctions, long
// paths, read-only files, bulk file counts), spawning/driving the exact holder processes the
// live check needs, reading registry.json directly, and driving the real Delete dialog over CDP
// (no existing helper covers this dialog -- #891 is the first live check of it).

import { mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function readRegistry(dataDir) {
  return JSON.parse(readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
}

export function sessionByName(dataDir, name) {
  const registry = readRegistry(dataDir);
  const session = registry.sessions.find((s) => s.name === name);
  assert(session, `registry.json has a session named "${name}"`);
  return session;
}

/** Mirrors `git/worktrees.rs`'s own `add_worktree_with_generated_name`: the worktree folder's
 * own basename is always used as the git admin entry's directory name too, so the admin dir is
 * `<repo>/.git/worktrees/<basename(worktreePath)>`. Used to simulate a leftover UNREGISTERED
 * worktree (scenario b): git already "forgot" the worktree, but the folder and its content are
 * still on disk. */
export function dropAdminEntry(repoDir, worktreePath) {
  const name = path.basename(worktreePath);
  assert(name && name.length > 3, `a real worktree folder name, got ${JSON.stringify(name)}`);
  const adminDir = path.join(repoDir, '.git', 'worktrees', name);
  assert(adminDir.includes('.git') && adminDir.includes('worktrees'), `adminDir looks like a real git admin path: ${adminDir}`);
  rmSync(adminDir, { recursive: true, force: true });
  return adminDir;
}

/** Confirms git itself no longer lists `worktreePath` (the post-delete porcelain check the
 * production code itself runs). */
export function isRegisteredWorktree(repoDir, worktreePath) {
  const result = spawnSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  return result.stdout.includes(worktreePath.replace(/\\/g, '/')) || result.stdout.includes(worktreePath);
}

/** Scenario (a): a full, real-world-shaped worktree -- a few thousand files under a generated
 * `node_modules`-named folder, a path over 260 characters, read-only files, and a junction
 * pointing OUTSIDE the worktree to `canaryDir` (the safety property under test: the canary's own
 * files must survive this worktree's deletion completely untouched). */
export function populateFullWorktree(worktreePath, canaryDir) {
  mkdirSync(canaryDir, { recursive: true });
  const canaryFile = path.join(canaryDir, 'canary.txt');
  writeFileSync(canaryFile, 'do not touch -- outside the worktree');

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

  // A junction INSIDE the worktree whose real target is OUTSIDE it entirely -- never followed,
  // never deleted through.
  const junction = path.join(nodeModules, 'linked-store');
  const result = spawnSync('cmd', ['/C', 'mklink', '/J', junction, canaryDir], { encoding: 'utf8', windowsHide: true });
  assert(result.status === 0, `mklink /J created the junction: ${result.stderr || result.stdout}`);

  // A path comfortably over the 260-character MAX_PATH threshold.
  let deep = path.join(worktreePath, 'deep');
  const longName = 'a'.repeat(60);
  for (let i = 0; i < 4; i++) deep = path.join(deep, longName);
  mkdirSync(deep, { recursive: true });
  const longFile = path.join(deep, 'file.txt');
  writeFileSync(longFile, 'x');
  assert(longFile.length > 260, `the deep file path is over 260 characters (${longFile.length})`);
  fileCount++;

  // Read-only files.
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

/** Scenario (b): a plain, unregistered leftover folder full of generated files -- no junctions
 * or long paths needed (the registered path already proves those; this proves the ORPHAN path
 * removes a full folder instead of refusing `NotEmpty`). */
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

/** Spawns a bare, idle `cmd.exe` with its CURRENT DIRECTORY inside `cwd` -- holds no file
 * handle Restart Manager can see, only the directory-as-cwd handle the rename probe exists for.
 * Never passes a `/C <command>`: that would spawn a grandchild process that inherits the SAME
 * cwd and keeps holding it even after this script kills the `cmd.exe` parent it actually spawned
 * (the bug this live check's own unit-test sibling hit and fixed). */
export function spawnCwdHolder(cwd) {
  const child = spawn('cmd.exe', [], { cwd, stdio: 'ignore', windowsHide: true });
  return child;
}

/** Spawns a PowerShell process that opens and holds one specific FILE open inside the worktree
 * (never just a cwd) -- the shape Restart Manager's own file-handle scan is meant to catch and
 * name. */
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

// ---- Delete dialog driving (new: no existing verify-tauri-*.mjs script touches this dialog) ----

function rowActionsFinderByName(name) {
  return `Array.from(document.querySelectorAll('[data-repository-id] li')).find((li) => li.querySelector('[data-session-open]')?.getAttribute('aria-label')?.startsWith(${JSON.stringify(name)}))?.querySelector('button[aria-label$=" actions"]')`;
}

/** Opens a named Session row's own "..." menu and clicks "Delete", waiting for the real
 * AlertDialog to mount. Mirrors `openRowActionsMenu`'s hover-then-click pattern (the trigger is
 * revealed by `group-hover`, a bare click can race the reveal). */
export async function openDeleteDialogFor(cdp, name) {
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
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Delete\u2026')`, {
    timeoutMs: 10_000,
    label: 'row menu open with Delete\u2026 item'
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Delete\u2026')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Delete dialog opened' });
}

/** Waits for the leftover-summary walk to finish ("Checking files…" gone) and returns its own
 * rendered text (the generated-folder/other-file list, or '' if nothing was found). */
export async function waitForLeftoverSummary(cdp, { timeoutMs = 20_000 } = {}) {
  await cdp.waitFor(
    `!Array.from(document.querySelectorAll('[role="dialog"] p')).some((p) => p.textContent === 'Checking files…')`,
    { timeoutMs, label: 'leftover summary walk finished' }
  );
  return cdp.evaluate(
    `Array.from(document.querySelectorAll('[role="dialog"] ul')).map((ul) => ul.textContent).join(' | ')`
  );
}

export async function clickDeleteButton(cdp) {
  await cdp.clickByText('Delete', { inDialog: true });
}

/** The dialog's own `role="alert"` paragraph -- '' while no error (it stays mounted, `sr-only`,
 * per `DeleteDialog.tsx`'s own convention). */
export async function readDialogError(cdp, { timeoutMs = 15_000 } = {}) {
  return cdp.waitFor(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent || null`, { timeoutMs, label: 'dialog error text' });
}

export async function isDialogOpen(cdp) {
  return cdp.evaluate(`!!document.querySelector('[role="dialog"]')`);
}

export async function isSessionListed(cdp, name) {
  return cdp.evaluate(
    `!!Array.from(document.querySelectorAll('[data-session-open]')).find((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(name)}))`
  );
}
