// IPC handlers for `fileExplorer.*` (contracts/ipc.md "File explorer", spec 015 tasks.md
// T003-T005, T016-T019, T022-T025). `listDirectory` (Slice 1); `readPreview`/`getStatus`
// (Slice 2); `openInVSCode`/`reveal`/`copyPath` (Slice 3).

import { spawn } from 'node:child_process';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { clipboard, ipcMain, shell } from 'electron';
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { FilePreview, FileTreeEntryKind, FileTreeNode, GitStatusMap } from '../../shared/model';
import type { SessionManager } from '../SessionManager';
import { readGitStatus } from '../git/status';
import { type DirectoryWatchHandle, watchDirectory } from '../fs/watchDirectory';
import { readPreview as readPreviewFile } from '../fs/readPreview';
import { clearVSCodeExecutableCache, resolveVSCodeExecutable } from '../process/executables';
import { containsGitSegment } from '../fs/paths';
import { invalidArgument, notFound } from './util';
import { resolveErrorResult, resolveInWorktree, type ResolveInWorktreeResult } from './files';

const MAX_SESSION_ID_LENGTH = 256;
// Matches `files.ts`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt) -- kept as an
// independent constant rather than importing that one, since the two call sites have no reason
// to be forced to change together.
const MAX_RELATIVE_PATH_LENGTH = 4096;

/** `resolveInWorktree` (`files.ts`, issue #610) deliberately rejects a token that resolves to the
 * worktree root ITSELF as `file-missing` -- correct for its own `sessions.revealFile` call site
 * (revealing the whole worktree folder via a "file" action makes no sense there), but wrong here:
 * listing the worktree root is this panel's own first, most common operation (FR-004). This thin
 * wrapper special-cases `relativePath === ''` to realpath the worktree root directly (the exact
 * first step `resolveInWorktree` itself takes internally), and defers to the unmodified,
 * already-hardened function for every other value -- never a second containment implementation.
 *
 * PR #671 gate fix (Medium, security-auditor/code-reviewer): FR-007 ("`.git` itself is never
 * returned") was previously enforced only by filtering `.git` OUT of a listing's own rows, never
 * on the `relativePath` main is ASKED to list -- a caller could still request `.git`, `.GIT`, or
 * `sub/.git` directly and get the repository internals back. Rejected here, before
 * `resolveInWorktree` ever runs, on the token as typed; and again AFTER resolution, on the
 * realpath'd result relative to the (also realpath'd) worktree root, since the Windows 8.3
 * short-name alias `GIT~1` only reads as `.git` once `fs.realpath` expands it -- the as-typed
 * check alone would miss that alias entirely. */
async function resolveListTarget(worktreeRoot: string, relativePath: string): Promise<ResolveInWorktreeResult> {
  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(worktreeRoot);
  } catch {
    return { ok: false, reason: 'worktree-missing' };
  }
  if (relativePath === '') return { ok: true, realPath: rootRealPath };

  if (containsGitSegment(relativePath)) return { ok: false, reason: 'outside-worktree' };
  const resolved = await resolveInWorktree(worktreeRoot, relativePath);
  if (!resolved.ok) return resolved;
  if (containsGitSegment(path.relative(rootRealPath, resolved.realPath))) {
    return { ok: false, reason: 'outside-worktree' };
  }
  return resolved;
}

/** Maps a `fs.readdir` failure to a plain-English message -- never `err.message` itself (PR #671
 * gate fix, security-auditor/verification MEDIUM: the raw Node string includes the absolute
 * realpath, e.g. `EACCES: permission denied, scandir 'C:\Users\...'`, which both leaks a real
 * filesystem path into UI text and reads as errno jargon, not English). `resolved.realPath`
 * already proved to exist moments earlier (`resolveListTarget` itself calls `fs.realpath`, which
 * throws `ENOENT` for a missing path) -- `ENOENT` here is a genuine delete-after-resolve race,
 * not a containment question, so it still gets its own `file-missing` code. */
function mapReaddirError(err: unknown): Result<never> {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { ok: false, error: { code: 'file-missing', message: `That folder no longer exists` } };
  }
  if (code === 'ENOTDIR') return invalidArgument(`That is not a folder`);
  if (code === 'EACCES' || code === 'EPERM') {
    return invalidArgument(`You do not have permission to open that folder`);
  }
  return invalidArgument(`Could not read that folder`);
}

/** Classifies ONE symlink/junction dirent's `kind` by reusing the SAME hardened, never-follow-an-
 * unvetted-link resolver every other path in this codebase goes through (`resolveInWorktree`,
 * issue #610) -- not a separate, first-hop-only check. PR #671 gate round 2 fix (security-
 * auditor/code-reviewer/verification/a11y HIGH): an earlier version here vetted only the entry's
 * OWN raw `readlink` target text, then handed that text to `resolveInWorktree`, whose
 * `fs.realpath` followed the REST of a link CHAIN (`a -> b`, `b -> \\attacker\share`) -- or a
 * link sitting in a MIDDLE segment of the target's own path -- before the containment check ever
 * ran, a zero-click outbound SMB/NTLM connection reproduced live. `resolveInWorktree` now walks
 * every hop itself (`resolveNoFollow`, files.ts), so passing it the entry's own path is
 * sufficient: a target that escapes, is UNC/device-shaped, or sits behind a chain of links into
 * any of those, resolves to `kind: 'cannot-access'` without ever following it.
 *
 * A target that resolves INSIDE the worktree but under a `.git` segment (a link into the
 * repository's own internals) is also `'cannot-access'`, not `'folder'`/`'file'` (PR #671 gate
 * round 2 fix, LOW): `.git` itself is never represented as a node (FR-007), and classifying it
 * as an ordinary folder would render it with a disclosure control that then fails on expand. */
async function classifySymlinkEntry(
  worktreeRoot: string,
  rootRealPath: string,
  entryAbsPath: string
): Promise<FileTreeEntryKind> {
  const resolved = await resolveInWorktree(worktreeRoot, entryAbsPath);
  if (!resolved.ok) return 'cannot-access';
  if (containsGitSegment(path.relative(rootRealPath, resolved.realPath))) return 'cannot-access';
  const stat = await fs.stat(resolved.realPath).catch(() => null);
  return stat?.isDirectory() ? 'folder' : 'file';
}

// Bounds how many symlink/junction entries are classified at once -- a folder full of them (e.g.
// pnpm's own `node_modules`, which is nothing but junctions) must not serialise one `readlink`/
// `stat` round trip after another, matching the existing worker-pool shape
// `repositories.ts`'s own `remotesBounded` already uses for the same reason (PR #671 gate fix,
// security-auditor HIGH).
const SYMLINK_CLASSIFY_CONCURRENCY = 8;

/** Spec.md Edge Cases ("a huge repository"), research.md decision 7: caps how many entries ONE
 * `listDirectory` call ever classifies/returns for a single directory, enforced here in MAIN --
 * not only by Slice 2's renderer-side `react-virtuoso` virtualisation -- so a pathologically huge
 * directory can never force unbounded per-entry `readlink`/`stat` work before the renderer gets
 * a chance to cap what it renders (PR #671 gate round 2 fix, security-auditor/code-reviewer LOW).
 * 1000 is comfortably above any ordinary folder in a real repository while still bounding the
 * worst case (a directory with hundreds of thousands of entries) to a fixed, small multiple of
 * `SYMLINK_CLASSIFY_CONCURRENCY` rounds. */
const MAX_ENTRIES_PER_DIRECTORY = 1000;

/** Folders before files, then alphabetical (case-insensitive, matching Windows' own Explorer
 * convention and NTFS's case-insensitive-but-preserving names) within each group (FR-006). A
 * `'cannot-access'` entry sorts alongside files -- it is equally non-expandable. */
function sortEntries(a: FileTreeNode, b: FileTreeNode): number {
  const rank = (node: FileTreeNode) => (node.kind === 'folder' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Resolves, reads, caps, classifies, and sorts one directory's listing (tasks.md T003, PR #671
 * gate round 2 cap fix) -- the one hardened implementation shared by the `listDirectory` IPC
 * handler and the file watcher's own re-list-on-change path (`ensureWatcher` below), so a live
 * `FILE_EXPLORER_PATCH` is never produced by a second, drifting copy of this containment/
 * capping/classification logic.
 */
async function listDirectoryEntries(
  worktreePath: string,
  relativePath: string
): Promise<Result<{ entries: FileTreeNode[]; truncated: number }>> {
  const resolved = await resolveListTarget(worktreePath, relativePath);
  if (!resolved.ok) return resolveErrorResult(resolved.reason, 'folder');
  const { realPath } = resolved;

  // Computed once per request, never per entry: `classifySymlinkEntry` needs the WORKTREE
  // root's own realpath (not just the listed directory's, which may be a subfolder) to test
  // whether a link's target lands under `.git`. `worktreePath` is main-controlled (the
  // registry's own Session record), never attacker-influenced, so this is the same kind of
  // trusted realpath `resolveListTarget`/`resolveInWorktree` already do internally -- not a
  // second containment check.
  const rootRealPath = await fs.realpath(worktreePath).catch(() => realPath);

  let dirents: Dirent[];
  try {
    // FR-007: a `.git` dirent is filtered here too (case-insensitively), defence in depth
    // alongside `resolveListTarget`'s own rejection of `.git` as a requested PATH above --
    // this one catches a literal `.git` folder sitting INSIDE whatever directory is being
    // listed, not `.git` itself as the request target.
    dirents = (await fs.readdir(realPath, { withFileTypes: true })).filter(
      (dirent) => dirent.name.toLowerCase() !== '.git'
    );
  } catch (err) {
    return mapReaddirError(err);
  }

  // PR #671 gate round 2 fix (security-auditor/code-reviewer LOW): a pathologically huge
  // directory must never force unbounded per-entry `readlink`/`stat` work -- the cap runs
  // BEFORE classification, not just on the final rendered list. A cheap NAME-ONLY sort (no
  // I/O at all, even for a symlink: `dirent.name` needs no filesystem call) decides WHICH
  // entries survive the cap, so the result is the alphabetically-first `MAX_ENTRIES_PER_
  // DIRECTORY` entries -- not an arbitrary readdir-order subset -- while still never
  // classifying a single entry beyond that cap. The FINAL folder-before-file ordering
  // (`sortEntries`, needs each entry's real `kind`) only runs after classification, on the
  // already-capped subset.
  const byNameOnly = [...dirents].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const truncated = Math.max(0, byNameOnly.length - MAX_ENTRIES_PER_DIRECTORY);
  const capped = truncated > 0 ? byNameOnly.slice(0, MAX_ENTRIES_PER_DIRECTORY) : byNameOnly;

  // Classifies every symlink/junction entry's `kind` with bounded concurrency (never one
  // `readlink`/`stat` after another -- see `SYMLINK_CLASSIFY_CONCURRENCY`'s own comment), and
  // never follows a target `classifySymlinkEntry` has not independently proven safe first.
  const kinds = new Array<FileTreeEntryKind>(capped.length);
  let nextIndex = 0;
  async function classifyNext(): Promise<void> {
    while (nextIndex < capped.length) {
      const i = nextIndex++;
      const dirent = capped[i]!;
      kinds[i] = dirent.isSymbolicLink()
        ? await classifySymlinkEntry(worktreePath, rootRealPath, path.join(realPath, dirent.name))
        : dirent.isDirectory()
          ? 'folder'
          : 'file';
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SYMLINK_CLASSIFY_CONCURRENCY, capped.length) }, () => classifyNext())
  );

  const entries: FileTreeNode[] = capped.map((dirent, i) => ({
    path: relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`,
    name: dirent.name,
    kind: kinds[i]!
  }));
  entries.sort(sortEntries);

  return { ok: true, value: { entries, truncated } };
}

/** One `fs.watch` per Session, started lazily the first time that Session's file explorer panel
 * actually lists a directory (never eagerly for every open Session) -- research.md decision 5,
 * tasks.md T013/T014. Keyed by sessionId rather than worktreePath so two Sessions that happened
 * to share a worktree path would still each own their own watcher lifecycle. Module-level (not
 * local to `registerFileExplorer`, PR #671 gate round 4 fix, Critical): `sessions.ts` needs to
 * reach into this same map from a SEPARATE registration function (`stopFileExplorerWatcher`
 * below) to release a Session's watcher before archive/delete/recreateWorktree ever touch its
 * worktree folder -- the previous design only ever tore a watcher down from a LATER fs event
 * finding the Session gone from the registry, which never fires at all for a deleted-root event
 * flood (see `watchDirectory`'s own doc comment) and left the handle open under a folder a
 * caller was about to `mkdir` back into existence (`EPERM`). */
interface SessionWatchState {
  handle: DirectoryWatchHandle;
  /** Directories the renderer has actually fetched for this Session via a successful
   * `listDirectory` call (`''` is the worktree root). A watcher patch for anything else is
   * dropped before any `readdir`/classify/IPC-send work runs (PR #671 gate round 4 fix, High,
   * Sec4/Code4, reproduced live): an agent's own `pnpm install`/checkout touching dozens of
   * directories the panel never opened must not re-list and re-status all of them for nothing
   * the renderer will ever render. */
  loadedPaths: Set<string>;
}

// Gate round 6 fix (Code6/Verif6 Low): `loadedPaths` itself compared case-SENSITIVELY while
// `isPathGoneUnderPatch` (the renderer's own FR-021 check) was already made case-insensitive in
// round 5 -- a case-only rename of an expanded folder (`src` -> `Src`, Windows/NTFS being
// case-preserving-but-insensitive) recorded a loaded path under the OLD casing, so a watcher
// patch keyed on the NEW casing (whatever `fs.watch` happens to report) never matched and the
// live-refresh patch for it was silently dropped. Every `loadedPaths` read/write below goes
// through this normaliser so the two always agree, matching NTFS's own convention.
function normalizePathKey(relativePath: string): string {
  return relativePath.toLowerCase();
}
const watchers = new Map<string, SessionWatchState>();

// Gate round 5 fix (Code5 HIGH1): the ONE module-scope reference to the window getter
// `registerFileExplorer` receives -- `registerFileExplorer` is only ever instantiated once (at
// app startup), so capturing it here lets `notifyFileExplorerReset` below be called from
// `sessions.ts` (a separate registration function) without threading a `getWindow` parameter
// through every intermediate call site.
let cachedGetWindow: (() => BrowserWindow | undefined) | undefined;

/** Pushes `FILE_EXPLORER_RESET` (contracts/ipc.md, gate round 5 Code5 HIGH1) so the renderer
 * drops its stale `bySession[sessionId]` state and re-fires its "load root once per Session"
 * effect. Exported so `sessions.ts` can call it after `recreateWorktree` succeeds, after a
 * restore, and after an archive -- `stopFileExplorerWatcher` below only releases the WATCHER
 * (called pre-emptively, before those operations touch the worktree folder); this is the
 * separate signal that tells the renderer it is safe to reload, called once the operation that
 * actually changed the worktree has finished. */
export function notifyFileExplorerReset(sessionId: string): void {
  const window = cachedGetWindow?.();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC_EVENTS.FILE_EXPLORER_RESET, { sessionId });
}

// Gate round 6 fix (Verif6 Low): a per-Session "busy" marker, checked by `ensureWatcher` below.
// Closes a race `stopFileExplorerWatcher` alone did not: an in-flight `listDirectory` call,
// started just BEFORE `sessions.ts` begins archiving/deleting/recreating a Session's worktree,
// calls `ensureWatcher` synchronously at its own handler's very first line, then `await`s the
// actual listing -- if that `await` resolves DURING the window `sessions.ts` has the worktree
// folder itself mid-operation (a `git worktree remove`/`add`, for recreate), the race recreates
// a fresh watcher on a folder the operation is still touching, reopening round 4's own
// EPERM-on-`mkdir` bug one call site later than the original fix closed it. Exported so
// `sessions.ts` can mark a Session busy around its own archive/delete/recreateWorktree bodies,
// cleared before (not after) the matching `notifyFileExplorerReset` call.
const busySessionIds = new Set<string>();
export function setFileExplorerSessionBusy(sessionId: string, busy: boolean): void {
  if (busy) busySessionIds.add(sessionId);
  else busySessionIds.delete(sessionId);
}

// Gate round 5 fix (Code5 Medium): dedupes watcher-triggered re-lists by `sessionId` + directory
// -- under churn (a checkout, an agent's own multi-file write) the same directory could
// otherwise be queued and re-listed multiple times concurrently, and since replies land in
// COMPLETION order (not start order), an older in-flight listing finishing last could overwrite
// a newer one. At most one `listDirectoryEntries` call is ever in flight per key; a change that
// arrives while one is already running just marks it dirty for exactly one more pass once the
// current one finishes, rather than queuing a second concurrent run.
const inFlightDirectoryKeys = new Set<string>();
const dirtyDirectoryKeys = new Set<string>();
function directoryFlushKey(sessionId: string, relativePath: string): string {
  return `${sessionId}\0${relativePath}`;
}

// PR #671 gate round 4 fix (High, Sec4/Code4): bounds how many watcher-triggered re-lists run
// concurrently ACROSS EVERY SESSION'S watcher at once -- an agent's own `pnpm install`/checkout
// touching many directories in one burst must not fire dozens of concurrent `readdir`+classify
// cycles (each with its own IPC send) at once, the same "never one thing after another, never
// everything at once" reasoning `SYMLINK_CLASSIFY_CONCURRENCY` already uses for per-entry
// classification within a single directory listing.
const WATCHER_FLUSH_CONCURRENCY = 4;
let activeFlushes = 0;
const flushQueue: Array<() => void> = [];
function runFlush(fn: () => Promise<void>): void {
  const run = (): void => {
    activeFlushes++;
    fn().finally(() => {
      activeFlushes--;
      const next = flushQueue.shift();
      if (next) next();
    });
  };
  if (activeFlushes < WATCHER_FLUSH_CONCURRENCY) run();
  else flushQueue.push(run);
}

/** Stops and discards a Session's watcher, if one exists. Exported so `sessions.ts` can call it
 * before archive, delete, and `recreateWorktree` ever touch the worktree folder itself (PR #671
 * gate round 4 fix, Critical) -- a watcher left running under a folder about to be deleted or
 * recreated is exactly the deleted-root event flood `watchDirectory`'s own doc comment describes.
 * Safe to call for a Session with no watcher (a no-op). Also called from this module's own
 * `onFatal` callback below when a watcher self-detects it must stop (the deleted-root flood, or a
 * genuine `'error'` event) -- the one difference is that path removes the Session's entry so the
 * NEXT `listDirectory` call starts a fresh watcher, while this export is a plain teardown a
 * caller uses right before it is ABOUT to touch the folder itself (recreateWorktree's own
 * success re-establishes a watcher on its own next `listDirectory`, same as any other first
 * open). */
export function stopFileExplorerWatcher(sessionId: string): void {
  watchers.get(sessionId)?.handle.stop();
  watchers.delete(sessionId);
}

/** Stops and discards EVERY Session's watcher (PR #671 gate round 4 fix, Low/Medium, Verif4/Sec4:
 * a watcher otherwise only ever stopped on an explicit archive/delete/recreateWorktree/self-
 * detected-fatal path, never on app quit). Exported for `main/index.ts`'s own `before-quit`
 * handler to call alongside its existing best-effort cleanup there. */
export function stopAllFileExplorerWatchers(): void {
  for (const sessionId of [...watchers.keys()]) stopFileExplorerWatcher(sessionId);
}

export function registerFileExplorer(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  cachedGetWindow = getWindow;

  // Gate round 5 fix (Code5 Medium): the actual per-directory re-list work, shared by both the
  // immediate run and the single deferred rerun below. Pulled out of the watcher callback itself
  // so `scheduleDirectoryFlush` can invoke it uniformly from either path.
  async function refreshDirectory(sessionId: string, relativePath: string): Promise<void> {
    // The Session may have been archived/deleted between the watcher firing and this flush --
    // re-check the registry rather than trusting the closed-over `worktreePath` is still live.
    const session = manager.registry.getSession(sessionId);
    if (!session) {
      stopFileExplorerWatcher(sessionId);
      return;
    }
    const state = watchers.get(sessionId);
    if (!state?.loadedPaths.has(normalizePathKey(relativePath))) return;
    const result = await listDirectoryEntries(session.worktreePath, relativePath);
    if (!result.ok) {
      // Gate round 6 fix (Code6/A11y6/Verif6 Medium, re-probed independently four ways): round
      // 5's own fix gated this on `relativePath === ''`, reasoning that only a ROOT re-list would
      // ever observe `worktree-missing`. That reasoning was wrong -- a foreign rename of the
      // watched root itself succeeds silently with ZERO watcher events (confirmed this round on
      // both Node 26 and the Electron 44.5.1 runtime: the handle simply follows the moved
      // folder), so the FIRST signal this app ever gets is the next flush for whatever SUBfolder
      // happened to be mid-edit -- and `resolveListTarget` returns `worktree-missing` for ANY
      // `relativePath` once `fs.realpath(worktreeRoot)` itself fails, not only for `''`. Gating
      // on `relativePath === ''` meant that common case was silently dropped, leaving the
      // renderer on a stale 'ready' tree forever. Any `relativePath` failing `worktree-missing`
      // now means the same thing: the root is gone, stop watching it and tell the renderer.
      // Residual, not fixed by this: a renamed root itself produces ZERO watcher events (the
      // handle follows the move) -- detection is NEVER immediate, only on the next flush for
      // whatever subfolder next changes, or the next explicit `listDirectory` call for any path.
      if (result.error.code === 'worktree-missing') {
        stopFileExplorerWatcher(sessionId);
        notifyFileExplorerReset(sessionId);
      }
      // Otherwise not an error to surface here -- the renderer only learns about a deleted
      // SUBdirectory if/when it navigates there directly, the same as any other stale-path race
      // `resolveListTarget` already handles per-request.
      return;
    }
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC_EVENTS.FILE_EXPLORER_PATCH, {
      sessionId,
      relativePath,
      entries: result.value.entries,
      truncated: result.value.truncated
    });
  }

  function scheduleDirectoryFlush(sessionId: string, relativePath: string): void {
    const key = directoryFlushKey(sessionId, relativePath);
    if (inFlightDirectoryKeys.has(key)) {
      dirtyDirectoryKeys.add(key);
      return;
    }
    inFlightDirectoryKeys.add(key);
    runFlush(async () => {
      // Gate round 6 fix (Code6/Sec6/Verif6 Medium): `inFlightDirectoryKeys.delete(key)` and the
      // dirty rerun used to run only on the HAPPY path -- a rejection from `refreshDirectory`
      // (e.g. `webContents.send` throwing "Render frame was disposed" during a renderer reload,
      // or a throw inside `listDirectoryEntries`) left the key permanently stuck "in flight",
      // silently starving that one directory of every future live-refresh for the rest of the
      // app's life, and raised an unhandled rejection through `runFlush`'s own `fn().finally`.
      try {
        await refreshDirectory(sessionId, relativePath);
      } catch (err) {
        console.error('fileExplorer: refreshDirectory failed', err);
      } finally {
        inFlightDirectoryKeys.delete(key);
        if (dirtyDirectoryKeys.delete(key)) scheduleDirectoryFlush(sessionId, relativePath);
      }
    });
  }

  function ensureWatcher(sessionId: string, worktreePath: string): void {
    if (watchers.has(sessionId)) return;
    // Gate round 6 fix (Sec6/Code6/Verif6 Medium): never watches an ARCHIVED Session -- the
    // reset this same round's own `FILE_EXPLORER_RESET` fires after archive makes a still-
    // mounted panel reload, and without this check that reload's own `listDirectory` call would
    // recreate a fresh recursive watcher on the Session archive was supposed to stop watching,
    // undoing round 4's own leak fix. The `FILE_EXPLORER_LIST_DIRECTORY` handler below already
    // refuses an archived Session before ever reaching this function; this is defence in depth
    // for any other call site.
    if (manager.registry.getSession(sessionId)?.archivedAt) return;
    // Gate round 6 fix (Verif6 Low): never watches a Session `sessions.ts` has marked busy --
    // see `setFileExplorerSessionBusy`'s own doc comment for the exact race this closes.
    if (busySessionIds.has(sessionId)) return;
    const handle = watchDirectory(
      worktreePath,
      (relativePath) => scheduleDirectoryFlush(sessionId, relativePath),
      () => {
        // onFatal (PR #671 gate round 4 fix, Critical; round 5 fix, Code5 HIGH1 + Sec5 Low
        // reentrancy): the watched root was deleted or became unwatchable out from under a
        // running watch. Guards against a STALE handle's late fatal clobbering a NEWER watcher
        // that has since replaced it for this `sessionId` -- `handle` below is this very
        // `watchDirectory` call's own return value, compared by identity before dropping
        // anything, so an old handle's delayed callback can never delete a fresh one's state.
        // Drops the cached state AND tells the renderer (`FILE_EXPLORER_RESET`) so its stale
        // tree does not sit there forever with no watcher underneath it; the NEXT
        // `listDirectory` call (the renderer's own re-fired "load root once per Session" effect,
        // or `sessions.recreateWorktree` succeeding) starts a fresh watcher.
        if (watchers.get(sessionId)?.handle !== handle) return;
        watchers.delete(sessionId);
        notifyFileExplorerReset(sessionId);
      }
    );
    // `watchDirectory` returns `undefined` when `watch()` itself threw synchronously (the
    // worktree folder was already gone at watch-start time) -- do NOT cache anything in that
    // case, so the next `listDirectory` call retries instead of staying permanently un-watched
    // (PR #671 gate round 4 fix, Critical).
    if (!handle) return;
    watchers.set(sessionId, { handle, loadedPaths: new Set() });
  }

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_LIST_DIRECTORY,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<{ entries: FileTreeNode[]; truncated: number }>> => {
      if (typeof sessionId !== 'string' || typeof relativePath !== 'string') {
        return invalidArgument('fileExplorer.listDirectory expects a string sessionId and a string relativePath');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
        return invalidArgument('fileExplorer.listDirectory rejected an oversized sessionId or path');
      }
      // Session authorisation (constitution V): `worktreePath` comes from the registry, keyed by
      // a `sessionId` the renderer supplied but main alone resolves -- the renderer never passes
      // a path of its own for the root, only ever a session id plus a worktree-relative path
      // `resolveInWorktree`/`resolveListTarget` independently prove stays inside it.
      const session = manager.registry.getSession(sessionId);
      // PR #671 gate round 2 fix (a11y/code-reviewer MEDIUM): never the raw session id -- this
      // panel's own root-load error state renders the message verbatim via `role="alert"`.
      if (!session) return notFound(`This Session no longer exists`);
      // Gate round 6 fix (Sec6/Code6/Verif6 Medium): an archived Session's panel can still be
      // mounted (its own chat pane does not unmount just because `sessions.archive` ran), and
      // this round's own `FILE_EXPLORER_RESET` reload would otherwise make that reload's
      // `listDirectory` call recreate a fresh recursive watcher here -- undoing round 4's own
      // "archive releases the watcher, a pure leak otherwise" fix the moment archive finishes.
      // Refused honestly (never silently): the renderer's existing root-error state renders this
      // message verbatim, the same "honest archived state" every other load failure already
      // gets, no new UI needed.
      if (session.archivedAt) {
        return { ok: false, error: { code: 'session-archived', message: `This Session is archived` } };
      }

      ensureWatcher(sessionId, session.worktreePath);
      const result = await listDirectoryEntries(session.worktreePath, relativePath);
      // Records this directory as one the renderer has actually fetched, so a later watcher
      // patch for it is allowed through (PR #671 gate round 4 fix, High) -- recorded on success
      // only, so a failed/escaping path never ends up "loaded".
      if (result.ok) watchers.get(sessionId)?.loadedPaths.add(normalizePathKey(relativePath));
      return result;
    }
  );

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_READ_PREVIEW,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<{ preview: FilePreview }>> => {
      if (typeof sessionId !== 'string' || typeof relativePath !== 'string') {
        return invalidArgument('fileExplorer.readPreview expects a string sessionId and a string relativePath');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
        return invalidArgument('fileExplorer.readPreview rejected an oversized sessionId or path');
      }
      // There is no "preview the whole worktree" concept -- `''` is `resolveListTarget`'s own
      // special case for LISTING the root, not a valid file to read a preview of.
      if (relativePath === '') {
        return invalidArgument('fileExplorer.readPreview requires a non-empty relativePath');
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`This Session no longer exists`);

      // Same path-containment check and error codes as `listDirectory` above (contracts/ipc.md),
      // reusing `resolveListTarget` unchanged rather than a second containment implementation --
      // it already covers the `.git` hard-block (as-typed AND post-realpath) that FR-007 also
      // requires here.
      const resolved = await resolveListTarget(session.worktreePath, relativePath);
      if (!resolved.ok) return resolveErrorResult(resolved.reason, 'file');

      const preview = await readPreviewFile(resolved.realPath, relativePath);
      return { ok: true, value: { preview } };
    }
  );

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_GET_STATUS,
    async (_event, sessionId: unknown): Promise<Result<{ status: GitStatusMap | null }>> => {
      if (typeof sessionId !== 'string') {
        return invalidArgument('fileExplorer.getStatus expects a string sessionId');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH) {
        return invalidArgument('fileExplorer.getStatus rejected an oversized sessionId');
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`This Session no longer exists`);

      // `readGitStatus` never throws (matches `diffStat.ts`'s own never-throw-into-renderer
      // convention) -- `null` is itself a normal, successful `Result` value, not an IPC error, so
      // the tree still renders with no status marks rather than failing the whole listing.
      const status = await readGitStatus(session.worktreePath);
      return { ok: true, value: { status } };
    }
  );

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_OPEN_IN_VSCODE,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<{ opened: boolean }>> => {
      if (typeof sessionId !== 'string' || typeof relativePath !== 'string') {
        return invalidArgument('fileExplorer.openInVSCode expects a string sessionId and a string relativePath');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
        return invalidArgument('fileExplorer.openInVSCode rejected an oversized sessionId or path');
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`This Session no longer exists`);

      // Same hardened containment check every other handler in this file reuses -- `relativePath`
      // can be `''` (the worktree root itself, "Open in VS Code" from the panel's own header) or
      // any file/folder inside it.
      const resolved = await resolveListTarget(session.worktreePath, relativePath);
      if (!resolved.ok) return resolveErrorResult(resolved.reason, 'folder');

      // research.md decision 1 (FR-016, FR-017): the fixed-install-root resolver, never
      // `resolveExecutable('code')` (`code.cmd`, unspawnable without `shell: true`). `undefined`
      // is a normal, expected result (VS Code not installed) -- `{ opened: false }`, not an IPC
      // error, so the renderer shows its own "VS Code not found" state inline.
      const codeExePath = await resolveVSCodeExecutable();
      if (!codeExePath) return { ok: true, value: { opened: false } };

      // `shell: false` (the default, stated explicitly) and an absolute-path args array -- never
      // a shell-interpolated command string, so a path containing `& | ^ %` cannot be read as a
      // second command. `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` are stripped from the child's own
      // env (PR #671 gate round 4 fix, Medium): this process is itself an Electron process, and
      // an inherited `ELECTRON_RUN_AS_NODE=1` would make the spawned `Code.exe` (which embeds its
      // own Electron/Node runtime) try to run its first argument as a Node SCRIPT instead of
      // opening it as a file, a real argument-confusion risk, not merely a stray env var. Case-
      // insensitive comparison (gate round 5, Sec5 Low) matches `git.ts`'s own
      // `GIT_ENV_VARS_TO_STRIP` convention for the identical reason: a variable set in a
      // differently-cased form (e.g. `electron_run_as_node`) would otherwise survive untouched.
      const STRIPPED_SPAWN_ENV_VARS = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);
      const childEnv: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (STRIPPED_SPAWN_ENV_VARS.has(key.toUpperCase())) continue;
        childEnv[key] = value;
      }
      const child = spawn(codeExePath, [resolved.realPath], {
        shell: false,
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
        env: childEnv
      });
      // PR #671 gate round 4 fix (Medium, Code4/Verif4/Sec4): a bare `spawn(...).unref()` has no
      // `'error'` listener -- a launch failure (a stale cached path whose target vanished after
      // the resolver ran, `EACCES`, AV quarantine) previously raised an UNCAUGHT exception in
      // main, after the handler had already returned `{ opened: true }` (the wrong FR-017 state).
      // Waits for the first of `'spawn'`/`'error'` instead, clearing the now-proven-stale cache
      // on error so the NEXT call re-resolves rather than repeating the same failure forever.
      // Executor form (not `Promise.withResolvers()`): `Promise.withResolvers()` needs lib
      // "ES2024"; `tsconfig.node.json` is pinned to "ES2023" (owned by another task) -- the same
      // documented exception `OmpProcess.ts`'s own `start()` already carries.
      const opened = await new Promise<boolean>((resolve) => {
        child.once('spawn', () => resolve(true));
        child.once('error', (err) => {
          console.error('fileExplorer.openInVSCode: spawn failed', err);
          clearVSCodeExecutableCache();
          resolve(false);
        });
      });
      child.unref();
      return { ok: true, value: { opened } };
    }
  );

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_REVEAL,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<void>> => {
      if (typeof sessionId !== 'string' || typeof relativePath !== 'string') {
        return invalidArgument('fileExplorer.reveal expects a string sessionId and a string relativePath');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
        return invalidArgument('fileExplorer.reveal rejected an oversized sessionId or path');
      }
      if (relativePath === '') {
        return invalidArgument('fileExplorer.reveal requires a non-empty relativePath');
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`This Session no longer exists`);

      const resolved = await resolveListTarget(session.worktreePath, relativePath);
      if (!resolved.ok) return resolveErrorResult(resolved.reason, 'file');

      // Deliberately `shell.showItemInFolder`, NOT `shell.openPath` -- contracts/ipc.md's own
      // prose for this method cites `SessionDetailsCard.tsx`'s `revealWorktree` (which DOES use
      // `shell.openPath`), but that reveals a Session's WHOLE WORKTREE FOLDER, never an arbitrary
      // file an agent/tool may have written. This method reveals one FILE, the exact same threat
      // model `sessions.revealFile` (issue #610, `files.ts`) already exists to close:
      // `shell.openPath` on a file runs its own default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` would
      // execute), which constitution V's "agent/tool/file output is untrusted" rule forbids.
      // `shell.showItemInFolder` only ever selects the file in Explorer, never executes it --
      // this corrects contracts/ipc.md's own imprecise wording rather than reintroducing the
      // exact bug `sessions.revealFile` was written to fix.
      shell.showItemInFolder(resolved.realPath);
      return { ok: true, value: undefined };
    }
  );

  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_COPY_PATH,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<void>> => {
      if (typeof sessionId !== 'string' || typeof relativePath !== 'string') {
        return invalidArgument('fileExplorer.copyPath expects a string sessionId and a string relativePath');
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
        return invalidArgument('fileExplorer.copyPath rejected an oversized sessionId or path');
      }
      if (relativePath === '') {
        return invalidArgument('fileExplorer.copyPath requires a non-empty relativePath');
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`This Session no longer exists`);

      const resolved = await resolveListTarget(session.worktreePath, relativePath);
      if (!resolved.ok) return resolveErrorResult(resolved.reason, 'file');

      try {
        clipboard.writeText(resolved.realPath);
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { code: 'clipboard-failed', message: err instanceof Error ? err.message : String(err) } };
      }
    }
  );
}
