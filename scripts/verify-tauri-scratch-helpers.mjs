// Shared scratch-live-check helpers for `scripts/verify-5xx-*.mjs` Tauri debug-build CDP checks
// (issue #570 gate round 1, #806 file-size split: extracted out of `verify-570-tool-colours.mjs`
// once it grew past the 600-line soft cap). Generic across any story's own live check: resolving
// `git rev-parse HEAD`, building the Job-Object launcher, a scratch git repo, hashing/copying/
// rebuilding the debug exe, launching it isolated (own `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/
// `REFRACT_IMPORT_SOURCE_DIR`), safely removing scratch dirs, asserting the launched exe's own
// hash didn't change under a lane, reading a real accessible name off the AX tree, and driving the
// real Profile-menu Theme submenu. `verify-565-spine.mjs` carries its own near-identical copies of
// several of these (written before this split); not touched here, out of scope for #570.
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

/** Cites each named screenshot by file AND its own sha256, so a reviewer can confirm the exact
 *  file they viewed is the one this run produced -- for `report.json`, not console output. */
export function citeScreenshots(dir, names) {
  return names.map((name) => ({ name, sha256: sha256OfFile(path.join(dir, name)) }));
}

/** Gate round 4 fix (Main's safety finding, MUST): `SHOT_DIR`-style evidence folders are often
 *  overridable via an env var, so recursively deleting the folder itself would be building a
 *  delete target from a variable -- exactly what this repo's safe-deletion rule bans. Clears
 *  only a script's own KNOWN output files, by literal name, never the folder; refuses unless
 *  `shotDir` resolves directly under the OS temp dir with the given prefix, so a misconfigured
 *  override can never reach somewhere unintended. Recreates the (now-empty, or newly made)
 *  folder itself afterward, same as a plain `mkdirSync(shotDir, { recursive: true })` would.
 *  Gate round 5 fix (Main's finding 9): a short-path (8.3) or differently-cased `%TEMP%` would
 *  make the earlier plain string comparison wrongly refuse (or, worse, wrongly allow) a
 *  legitimate folder -- `realpathSync.native` resolves both sides to the same canonical form
 *  before comparing, and the trailing `.toLowerCase()` is belt-and-braces over Windows' own
 *  case-insensitive filesystem semantics.
 *  Gate round 2 fix (issue #991, item 7, LOW, security-auditor): the parent-directory check
 *  above never confirmed `resolved` ITSELF is a real directory, not a symlink/junction --
 *  someone (or something stale) could plant `<prefix>*` as a symlink/junction pointing anywhere,
 *  and this function would delete files by name INSIDE that target instead of a genuine temp
 *  subfolder. Refuses outright when `resolved` already exists and is a symlink/junction
 *  (`lstatSync` reports a Windows directory junction as `isSymbolicLink()` too); the delete loop
 *  and the recreate below both now operate on `resolved` (the validated, canonical path), never
 *  the caller's own possibly-relative/trailing-separator `shotDir` string. */
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
    const buildResult = spawnSync('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: repoRoot, stdio: 'inherit', shell: true, windowsHide: true });
    if (buildResult.status !== 0) throw new Error(`buildAndCopyExeFresh: pnpm tauri build failed (exit ${buildResult.status}${buildResult.error ? `, error: ${buildResult.error.message}` : ''})`);
    if (!existsSync(src)) throw new Error(`buildAndCopyExeFresh: built exe not found at ${src} after a successful build`);
    const preCopyStat = statSync(src);
    const preCopyHash = sha256OfFile(src);
    copyFileSync(src, dest);
    const postCopyStat = statSync(src);
    const postCopyHash = existsSync(src) ? sha256OfFile(src) : null;
    const unchanged = postCopyHash === preCopyHash && postCopyStat.mtimeMs === preCopyStat.mtimeMs && postCopyStat.size === preCopyStat.size;
    if (unchanged) {
      console.log(`${label}: built exe copied to ${dest} (private copy; sha256 ${preCopyHash.slice(0, 12)}…, confirmed unchanged through the copy).`);
      return { dest, hash: preCopyHash };
    }
    console.warn(`${label}: source exe changed between build and copy (attempt ${attempt}) -- a concurrent lane is rebuilding; retrying.`);
  }
  throw new Error(`buildAndCopyExeFresh: source exe kept changing across ${maxAttempts} rebuild attempts.`);
}

/** Gate-fix (relaunch, caught live 2026-10-17): `webview2DataDir`/`pidFile` used to be fixed
 *  names derived only from `exePath`'s directory. Any caller that relaunches the SAME exe twice
 *  in one run (a remembered-settings-across-a-relaunch check) reused both paths: the stale
 *  `target.pid` from the first launch was still on disk when the second `launchViaJobObject`
 *  started polling, and its very first check (run essentially synchronously right after a
 *  non-blocking `spawn()`, long before a brand-new launcher could have written anything) read
 *  that leftover, now-dead pid and accepted it as the new launch's `targetPid` -- so
 *  `isTargetOwningPort` correctly refused to drive the process that actually owned the new CDP
 *  port. Matches the already-established fix in `verify-tauri-567.mjs`/`559.mjs`/
 *  `560-helpers.mjs`/`735.mjs`/`ask.mjs`'s own `launchBuiltExe` copies: suffix both names with a
 *  per-call timestamp so two launches against the same `exePath` never collide.
 */
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

export async function safeRmSync(dir, label = 'verify') {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
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

/** `getAccessibleNameAndRole` above reads `nodes[0]`'s own `name`, which is reliable for a
 * WIDGET (a button with an `aria-label`) but not for a plain text-content `<span>`: Chromium's
 * AX tree computes "name" on the role the text is naturally exposed through, nested leaves
 * under the requested node rather than on the node itself -- confirmed live against #560's own
 * `Low memory (N agents)` span (`verify-tauri-560-helpers.mjs`'s own `axText`, promoted here
 * since #941 hit the identical issue against a plain Stage-label span). Fetches only the exact
 * node's own DIRECT children via `Accessibility.getChildAXNodes` (NOT `fetchRelatives: true`,
 * which also pulls in ancestors up to the document root, so the first hit becomes the document
 * title instead) and concatenates every child's own name in DOM order (NOT just the first:
 * JSX with an interpolated expression between two string literals renders as several sibling
 * text nodes, each its own leaf AX node). */
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

/** Drives the REAL Profile-menu UI (`window.refract.theme.preview(id)` only moves the title-bar
 * overlay colour, never the renderer's `<html>` class the CSS tokens key off). A real
 * `mouseMoved` hover before the click matches how Radix's own `DropdownMenuSub` actually opens
 * (pointer-enter, not just a bare click). */
export async function switchTheme(cdp, themeId, themeName) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile dropdown menu open' });
  const themeTriggerFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Theme'))`;
  await cdp.waitFor(`!!(${themeTriggerFinder})`, { timeoutMs: 10_000, label: 'Theme submenu trigger visible' });
  const rect = await cdp.evaluate(`(() => { const el = ${themeTriggerFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(400);
  await cdp.click(themeTriggerFinder);
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[role="menuitem"] span.flex-1')).find((el) => el.textContent.trim() === ${JSON.stringify(themeName)})`,
    { timeoutMs: 10_000, label: `Theme submenu open, "${themeName}" item visible` }
  );
  await cdp.click(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => { const span = el.querySelector('span.flex-1'); return span && span.textContent.trim() === ${JSON.stringify(themeName)}; })`
  );
  await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${themeId}`)})`, {
    timeoutMs: 15_000,
    label: `<html> class theme-${themeId} applied (real store round trip, not just the title-bar preview)`
  });
}

/** #946: refuses to build without the shared `CARGO_TARGET_DIR`, never falling back to a
 * worktree-local `src-tauri/target` (a 2026-10-16 live-check built into one and consumed 5.9 GB,
 * dropping C: to 1.3 GB free mid-build for another lane). `repoRoot` is only used to reject a
 * `CARGO_TARGET_DIR` that resolves inside the repo/worktree itself, which is the same fallback in
 * disguise; the actual shared directory is machine-specific and deliberately not hardcoded here.
 * Refuses a relative path outright (ambiguous against whatever `cwd` happens to be). Compares
 * `fs.realpathSync.native` output (resolves symlinks/junctions and 8.3 short names, e.g. a
 * worktree reached through a junction or `RUNNER~1`) case-insensitively on win32, where the
 * filesystem itself is case-insensitive. `CARGO_TARGET_DIR` need not exist yet (cargo creates it
 * on first build), so the nearest EXISTING ancestor is realpath'd and the not-yet-created
 * remainder re-appended rather than giving up on symlink/junction resolution entirely; a leading
 * Windows `\\?\` (or `\\?\UNC\`) extended-length prefix is stripped from the realpath'd half so
 * it never breaks the suffix join or the prefix comparison below (`fs.realpathSync.native` adds
 * it, `path.resolve` on the caller's input never does). */
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
