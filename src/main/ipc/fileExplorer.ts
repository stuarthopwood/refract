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
import { resolveVSCodeExecutable } from '../process/executables';
import { invalidArgument, notFound } from './util';
import { containsGitSegment, resolveErrorResult, resolveInWorktree, type ResolveInWorktreeResult } from './files';

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

export function registerFileExplorer(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  // One `fs.watch` per Session, started lazily the first time that Session's file explorer panel
  // actually lists a directory (never eagerly for every open Session) -- research.md decision 5,
  // tasks.md T013/T014. Keyed by sessionId rather than worktreePath so two Sessions that happened
  // to share a worktree path would still each own their own watcher lifecycle.
  const watchers = new Map<string, DirectoryWatchHandle>();

  function ensureWatcher(sessionId: string, worktreePath: string): void {
    if (watchers.has(sessionId)) return;
    const handle = watchDirectory(worktreePath, (relativePath) => {
      void (async () => {
        // The Session may have been archived/deleted between the watcher firing and this flush --
        // re-check the registry rather than trusting the closed-over `worktreePath` is still
        // live, and tear this watcher down once its own Session is gone. There is no separate
        // "Session removed" event this module subscribes to, so this flush is also the
        // watcher's own eventual cleanup path.
        const session = manager.registry.getSession(sessionId);
        if (!session) {
          watchers.get(sessionId)?.stop();
          watchers.delete(sessionId);
          return;
        }
        const result = await listDirectoryEntries(session.worktreePath, relativePath);
        // A re-list failing (the changed directory itself was deleted in the same burst, say) is
        // not an error to surface here -- the renderer only learns about THAT if/when it
        // navigates there directly, the same as any other stale-path race `resolveListTarget`
        // already handles per-request.
        if (!result.ok) return;
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        window.webContents.send(IPC_EVENTS.FILE_EXPLORER_PATCH, {
          sessionId,
          relativePath,
          entries: result.value.entries
        });
      })();
    });
    watchers.set(sessionId, handle);
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

      ensureWatcher(sessionId, session.worktreePath);
      return listDirectoryEntries(session.worktreePath, relativePath);
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
      // second command.
      spawn(codeExePath, [resolved.realPath], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, value: { opened: true } };
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
