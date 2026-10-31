// Shared helpers for the `verify-5xx-*.mjs` Tauri debug-build CDP checks: scratch repo, exe
// build/hash/launch with isolated data dirs, safe scratch cleanup, AX-tree names, theme menu.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, createWriteStream, copyFileSync, existsSync, statSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchViaJobObject, sleep } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

export function gitHead(repoRoot) {
  const result = spawnSync_('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : `<git rev-parse failed: ${result.stderr}>`;
}

/** `report.json`'s `dirty` field; `'unknown'` (never a silent `false`) if `git status` is unreadable. */
export function computeDirty(repoRoot) {
  const result = spawnSync_('git', ['-C', repoRoot, 'status', '--porcelain']);
  const lines = result.status === 0 ? result.stdout.split('\n').filter(Boolean) : null;
  return lines === null ? 'unknown' : lines.length > 0;
}

export function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

export function makeScratchRepo(dir, label) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', `user.name=${label}`, '-c', `user.email=${label}@example.invalid`, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

export function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Cites each screenshot by file and sha256 so a reviewer can confirm the viewed file is this run's. */
export function citeScreenshots(dir, names) {
  return names.map((name) => ({ name, sha256: sha256OfFile(path.join(dir, name)) }));
}

/** Deletes only known output files by literal name, never the (env-overridable) folder itself, and
 *  refuses unless `shotDir` is directly under the OS temp dir with `prefix`. Both sides are
 *  `realpathSync.native`'d (8.3 names, case) and a symlink/junction `shotDir` is refused, so
 *  deletes cannot be redirected elsewhere. */
export function clearKnownOutputFiles(shotDir, prefix, fileNames) {
  const resolved = path.resolve(shotDir);
  let realParent, realTmp;
  try {
    realParent = realpathSync.native(path.dirname(resolved)).toLowerCase();
    realTmp = realpathSync.native(tmpdir()).toLowerCase();
  } catch {
    throw new Error(`refusing to clear ${resolved} -- its parent directory does not resolve to a real path`);
  }
  if (realParent !== realTmp || !path.basename(resolved).toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`refusing to clear ${resolved} -- not a recognized ${prefix}* folder directly under the OS temp dir`);
  }
  if (existsSync(resolved)) {
    let stat;
    try {
      stat = lstatSync(resolved);
    } catch {
      throw new Error(`refusing to clear ${resolved} -- could not stat it to confirm it is a real directory, not a symlink/junction`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to clear ${resolved} -- it is itself a symlink/junction, not a real directory (could point anywhere)`);
    }
  }
  for (const name of fileNames) {
    // A non-bare filename (separator, `..`, drive) could escape `resolved` via `path.join`.
    if (path.basename(name) !== name) {
      throw new Error(`refusing to clear ${resolved} -- fileNames entry ${JSON.stringify(name)} is not a bare filename`);
    }
    const filePath = path.join(resolved, name);
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  }
  mkdirSync(resolved, { recursive: true });
}

export function buildAndCopyExeFresh(destDir, buildOutputDir, repoRoot, { maxAttempts = 3, label = 'verify' } = {}) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(buildOutputDir, 'refract-tauri.exe');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`${label}: rebuilding the debug exe fresh (attempt ${attempt}/${maxAttempts})...`);
    const buildStartedMs = Date.now();
    const buildResult = spawnSync('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: repoRoot, stdio: 'inherit', shell: true, windowsHide: true });
    if (buildResult.status !== 0) throw new Error(`buildAndCopyExeFresh: pnpm tauri build failed (exit ${buildResult.status}${buildResult.error ? `, error: ${buildResult.error.message}` : ''})`);
    if (!existsSync(src)) throw new Error(`buildAndCopyExeFresh: built exe not found at ${src} after a successful build`);
    const preCopyStat = statSync(src);
    // A cargo no-op leaves an older exe in place; an mtime before this build started means the
    // exe was not produced by it, so it is not evidence for the current source.
    if (preCopyStat.mtimeMs < buildStartedMs - 2_000) {
      console.warn(`${label}: exe mtime ${preCopyStat.mtime.toISOString()} predates this build's start (cargo reported nothing to rebuild) -- provenance recorded below.`);
    }
    const preCopyHash = sha256OfFile(src);
    copyFileSync(src, dest);
    const postCopyStat = statSync(src);
    const postCopyHash = existsSync(src) ? sha256OfFile(src) : null;
    const unchanged = postCopyHash === preCopyHash && postCopyStat.mtimeMs === preCopyStat.mtimeMs && postCopyStat.size === preCopyStat.size;
    if (unchanged) {
      const mtime = preCopyStat.mtime.toISOString();
      console.log(`${label}: built exe copied to ${dest} (private copy; sha256 ${preCopyHash}, mtime ${mtime}, confirmed unchanged through the copy).`);
      return { dest, hash: preCopyHash, mtime, builtDuringThisRun: preCopyStat.mtimeMs >= buildStartedMs - 2_000 };
    }
    console.warn(`${label}: source exe changed between build and copy (attempt ${attempt}) -- a concurrent lane is rebuilding; retrying.`);
  }
  throw new Error(`buildAndCopyExeFresh: source exe kept changing across ${maxAttempts} rebuild attempts.`);
}

/** `webview2DataDir`/`pidFile` are suffixed per call: a relaunch of the same exe would otherwise read
 *  the first launch's stale `target.pid` and accept a dead pid as `targetPid`. */
function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile }) {
  const stamp = nowStamp();
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir
  };
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function isStrictlyUnderTmpdir(target) {
  try {
    const realTmp = realpathSync.native(tmpdir()).toLowerCase();
    const resolved = path.resolve(target);
    // Realpath the deepest existing ancestor so a junction/symlink cannot lead out of the temp dir.
    let existing = resolved;
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    const real = path.join(realpathSync.native(existing), path.relative(existing, resolved)).toLowerCase();
    return real.startsWith(realTmp + path.sep.toLowerCase()) && real.length > realTmp.length + 1;
  } catch {
    return false;
  }
}

export async function safeRmSync(dir, label = 'verify') {
  if (!dir) return;
  if (!isStrictlyUnderTmpdir(dir)) {
    console.warn(`${label}: refusing to remove ${dir} -- not strictly inside the OS temp dir`);
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(path.resolve(dir), { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`${label}: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await sleep(1000);
    }
  }
}

export function assertExeUnchanged(exePath, expectedHash, label, scriptLabel = 'verify') {
  const actualHash = sha256OfFile(exePath);
  if (actualHash !== expectedHash) {
    throw new Error(`assertExeUnchanged (${label}): ${exePath} hash is ${actualHash.slice(0, 12)}…, expected ${expectedHash.slice(0, 12)}… -- the exe under test changed after launch; this run's findings cannot be trusted.`);
  }
  console.log(`${scriptLabel}: exe sha256 ${expectedHash.slice(0, 12)}… confirmed unchanged (${label}).`);
}

export async function getAccessibleNameAndRole(cdp, selectorExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return { name: null, role: null };
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  const node = nodes?.[0];
  return { name: node?.name?.value ?? null, role: node?.role?.value ?? null };
}

/** Reads and joins every DIRECT child's name in DOM order: for plain text spans Chromium puts the
 * name on nested leaves, and interpolated JSX renders several sibling text nodes. Not
 * `fetchRelatives` (it pulls ancestors, so the document title wins). */
export async function axText(cdp, selectorExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  const target = nodes?.[0];
  if (!target) return null;
  if (target.name?.value) return target.name.value;
  if (!target.nodeId) return null;
  const { nodes: children } = await cdp.send('Accessibility.getChildAXNodes', { id: target.nodeId });
  const names = (children ?? []).map((child) => child.name?.value).filter((value) => value != null);
  return names.length > 0 ? names.join('') : null;
}

/** Drives the real Profile-menu Theme submenu (no IPC theme call changes the `<html>` class).
 * Hovers before clicking, as Radix's `DropdownMenuSub` opens on pointer-enter. Waits for all menus
 * to be closed, then for an open one containing Theme, because a still-closing menu from a prior
 * call eats the click. Theme rows are `role="menuitemradio"`; the trigger stays `menuitem`. */
export async function switchTheme(cdp, themeId, themeName) {
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Every menu closed before switching theme' });
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Theme'))`,
    { timeoutMs: 10_000, label: 'Profile dropdown menu open (containing Theme)' }
  );
  const themeTriggerFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Theme'))`;
  await cdp.waitFor(`!!(${themeTriggerFinder})`, { timeoutMs: 10_000, label: 'Theme submenu trigger visible' });
  const rect = await cdp.evaluate(`(() => { const el = ${themeTriggerFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(400);
  await cdp.click(themeTriggerFinder);
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[role="menuitemradio"] span.flex-1')).find((el) => el.textContent.trim() === ${JSON.stringify(themeName)})`,
    { timeoutMs: 10_000, label: `Theme submenu open, "${themeName}" item visible` }
  );
  await cdp.click(
    `Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => { const span = el.querySelector('span.flex-1'); return span && span.textContent.trim() === ${JSON.stringify(themeName)}; })`
  );
  await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${themeId}`)})`, {
    timeoutMs: 15_000,
    label: `<html> class theme-${themeId} applied (real store round trip, not just the title-bar preview)`
  });
}

/** Refuses to build without the shared `CARGO_TARGET_DIR`: a worktree-local `src-tauri/target` once
 * consumed 5.9 GB. Rejects relative paths and ones inside `repoRoot`; realpaths the nearest
 * existing ancestor (the dir may not exist yet) and strips the `\\?\` prefix `realpathSync.native`
 * adds; compares case-insensitively on win32. */
function nearestExistingRealpath(p) {
  const segments = [];
  let current = p;
  while (true) {
    try {
      const real = realpathSync.native(current);
      const stripped = real.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
      return segments.length ? path.join(stripped, ...segments) : stripped;
    } catch (err) {
      if (err.code !== 'ENOENT') return segments.length ? path.join(current, ...segments) : current;
      const parent = path.dirname(current);
      if (parent === current) return segments.length ? path.join(current, ...segments) : current;
      segments.unshift(path.basename(current));
      current = parent;
    }
  }
}
export function requireSharedCargoTarget(repoRoot) {
  const value = process.env.CARGO_TARGET_DIR;
  if (!value) {
    throw new Error(
      'CARGO_TARGET_DIR is not set. Live-check scripts and ci-local refuse to fall back to a ' +
        "worktree-local `src-tauri/target` (issue #946): set CARGO_TARGET_DIR to the machine's " +
        'shared cargo target directory before running this script.'
    );
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      `CARGO_TARGET_DIR (${value}) is a relative path (issue #946): set it to an absolute path to ` +
        'a shared directory outside any repo/worktree.'
    );
  }
  const resolved = path.resolve(value);
  const repoResolved = path.resolve(repoRoot);
  let comparedTarget = nearestExistingRealpath(resolved);
  let comparedRepo = nearestExistingRealpath(repoResolved);
  if (process.platform === 'win32') {
    comparedTarget = comparedTarget.toLowerCase();
    comparedRepo = comparedRepo.toLowerCase();
  }
  if (comparedTarget === comparedRepo || comparedTarget.startsWith(comparedRepo + path.sep)) {
    throw new Error(
      `CARGO_TARGET_DIR (${resolved}) resolves inside the repo (${repoResolved}); this is the ` +
        'worktree-local fallback in disguise (issue #946). Point it at a shared directory outside any repo/worktree.'
    );
  }
  return path.join(resolved, 'debug');
}
