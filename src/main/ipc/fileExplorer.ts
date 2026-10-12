// IPC handlers for `fileExplorer.*` (contracts/ipc.md "File explorer", spec 015 tasks.md T003-T005).
// Slice 1 only: `listDirectory`. `readPreview`/`getStatus` (Slice 2) and `openInVSCode`/`reveal`/
// `copyPath` (Slice 3) land in their own later commits.

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { FileTreeEntryKind, FileTreeNode } from '../../shared/model';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, notFound } from './util';
import { resolveErrorResult, resolveInWorktree, type ResolveInWorktreeResult } from './files';

const MAX_SESSION_ID_LENGTH = 256;
// Matches `files.ts`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt) -- kept as an
// independent constant rather than importing that one, since the two call sites have no reason
// to be forced to change together.
const MAX_RELATIVE_PATH_LENGTH = 4096;

/** Any path segment equal to `.git`, ASCII case-insensitively -- shared by both the lexical
 * (as-typed) and the realpath'd (post-resolution) checks below, and exported so Slice 2's
 * `readPreview` reuses the exact same rule rather than a second, drifting copy (PR #671 gate,
 * code-reviewer/security-auditor MEDIUM). */
function containsGitSegment(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git');
}

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

/** Classifies ONE symlink/junction dirent's `kind` WITHOUT ever following it to a target that
 * has not first been proven safe (PR #671 gate fix, security-auditor HIGH). The previous version
 * called `fs.stat` on every such entry unconditionally, which follows the link -- if its target
 * is a UNC path (`\\attacker\share\x`), merely opening this panel made Windows attempt an
 * outbound SMB/NTLM authentication with NO click from the user, the exact zero-click leak
 * `resolveInWorktree`'s own doc comment says must never be reachable.
 *
 * `fs.readlink` reads the link's OWN stored target text without ever following it -- always safe
 * to call. Only once that raw text has been checked, lexically, to be neither a UNC/device path
 * nor one `resolveInWorktree` itself rejects, is it safe to resolve and `fs.stat` the target to
 * learn whether it is a folder or a file. A target that fails either check resolves to
 * `'cannot-access'` -- spec.md's Edge Cases own "cannot access" row state -- never followed. */
async function classifySymlinkEntry(worktreeRoot: string, entryAbsPath: string): Promise<FileTreeEntryKind> {
  let rawTarget: string;
  try {
    rawTarget = await fs.readlink(entryAbsPath);
  } catch {
    return 'cannot-access'; // A broken link: nothing to follow, never stat'd.
  }
  // Checked on the raw, unfollowed target text, before anything that could reach a UNC host.
  if (rawTarget.replace(/\\/g, '/').startsWith('//')) return 'cannot-access';
  const targetToken = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(entryAbsPath), rawTarget);
  // Reuses the exact same hardened containment check every other path in this codebase goes
  // through (issue #610) -- including its own UNC/device-path rejection, which runs on
  // `targetToken` before any filesystem call follows it, and its final realpath-based check,
  // which is safe to reach here precisely BECAUSE the raw-text check above already ruled out a
  // UNC/device target.
  const resolved = await resolveInWorktree(worktreeRoot, targetToken);
  if (!resolved.ok) return 'cannot-access';
  const stat = await fs.stat(resolved.realPath).catch(() => null);
  return stat?.isDirectory() ? 'folder' : 'file';
}

// Bounds how many symlink/junction entries are classified at once -- a folder full of them (e.g.
// pnpm's own `node_modules`, which is nothing but junctions) must not serialise one `readlink`/
// `stat` round trip after another, matching the existing worker-pool shape
// `repositories.ts`'s own `remotesBounded` already uses for the same reason (PR #671 gate fix,
// security-auditor HIGH).
const SYMLINK_CLASSIFY_CONCURRENCY = 8;

/** Folders before files, then alphabetical (case-insensitive, matching Windows' own Explorer
 * convention and NTFS's case-insensitive-but-preserving names) within each group (FR-006). A
 * `'cannot-access'` entry sorts alongside files -- it is equally non-expandable. */
function sortEntries(a: FileTreeNode, b: FileTreeNode): number {
  const rank = (node: FileTreeNode) => (node.kind === 'folder' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function registerFileExplorer(manager: SessionManager): void {
  ipcMain.handle(
    IPC_REQUESTS.FILE_EXPLORER_LIST_DIRECTORY,
    async (_event, sessionId: unknown, relativePath: unknown): Promise<Result<{ entries: FileTreeNode[] }>> => {
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
      if (!session) return notFound(`Session not found: ${sessionId}`);
      const { worktreePath } = session;

      const resolved = await resolveListTarget(worktreePath, relativePath);
      if (!resolved.ok) return resolveErrorResult(worktreePath, resolved.reason, 'folder');
      const { realPath } = resolved;

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

      // Classifies every symlink/junction entry's `kind` with bounded concurrency (never one
      // `readlink`/`stat` after another -- see `SYMLINK_CLASSIFY_CONCURRENCY`'s own comment), and
      // never follows a target `classifySymlinkEntry` has not independently proven safe first.
      const kinds = new Array<FileTreeEntryKind>(dirents.length);
      let nextIndex = 0;
      async function classifyNext(): Promise<void> {
        while (nextIndex < dirents.length) {
          const i = nextIndex++;
          const dirent = dirents[i]!;
          kinds[i] = dirent.isSymbolicLink()
            ? await classifySymlinkEntry(worktreePath, path.join(realPath, dirent.name))
            : dirent.isDirectory()
              ? 'folder'
              : 'file';
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(SYMLINK_CLASSIFY_CONCURRENCY, dirents.length) }, () => classifyNext())
      );

      const entries: FileTreeNode[] = dirents.map((dirent, i) => ({
        path: relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`,
        name: dirent.name,
        kind: kinds[i]!
      }));
      entries.sort(sortEntries);

      return { ok: true, value: { entries } };
    }
  );
}
