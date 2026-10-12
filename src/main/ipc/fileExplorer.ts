// IPC handlers for `fileExplorer.*` (contracts/ipc.md "File explorer", spec 015 tasks.md T003-T005).
// Slice 1 only: `listDirectory`. `readPreview`/`getStatus` (Slice 2) and `openInVSCode`/`reveal`/
// `copyPath` (Slice 3) land in their own later commits.

import { promises as fs } from 'node:fs';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { FileTreeNode } from '../../shared/model';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, notFound } from './util';
import { resolveInWorktree, type ResolveInWorktreeResult } from './files';

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
 * already-hardened function for every other value -- never a second containment implementation. */
async function resolveListTarget(worktreeRoot: string, relativePath: string): Promise<ResolveInWorktreeResult> {
  if (relativePath !== '') return resolveInWorktree(worktreeRoot, relativePath);
  try {
    return { ok: true, realPath: await fs.realpath(worktreeRoot) };
  } catch {
    return { ok: false, reason: 'worktree-missing' };
  }
}

function resolveListErrorResult(worktreePath: string, reason: Exclude<ResolveInWorktreeResult, { ok: true }>['reason']): Result<never> {
  if (reason === 'worktree-missing') {
    return { ok: false, error: { code: 'worktree-missing', message: `Worktree missing: ${worktreePath}` } };
  }
  if (reason === 'file-missing') {
    return { ok: false, error: { code: 'file-missing', message: `Couldn't find that folder in this Session's worktree` } };
  }
  return { ok: false, error: { code: 'outside-worktree', message: `That path is outside this Session's worktree` } };
}

/** Folders before files, then alphabetical (case-insensitive, matching Windows' own Explorer
 * convention and NTFS's case-insensitive-but-preserving names) within each group (FR-006). */
function sortEntries(a: FileTreeNode, b: FileTreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
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

      const resolved = await resolveListTarget(session.worktreePath, relativePath);
      if (!resolved.ok) return resolveListErrorResult(session.worktreePath, resolved.reason);

      let dirents;
      try {
        dirents = await fs.readdir(resolved.realPath, { withFileTypes: true });
      } catch (err) {
        // `resolved.realPath` already proved to exist (both `resolveInWorktree` and the root
        // special-case above call `fs.realpath`, which throws ENOENT for a missing path) --
        // the only realistic failure left here is `ENOTDIR` (the renderer asked to "list" a
        // file, not a folder) or a permissions error; neither is a security boundary, so both
        // map to the same plain-English `invalid-argument` rather than inventing a new code.
        return invalidArgument(
          `Couldn't read that folder: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // FR-007: `.git` itself is never shown, regardless of anything else (no ignore toggle
      // exists yet to even ask for it -- Slice 2). A symlink/junction entry's OWN kind is
      // resolved via one extra `fs.stat` (follows the link) ONLY for that entry, so a symlinked
      // folder still renders with a disclosure control; containment of whatever it actually
      // points to is checked lazily, only when that specific entry is itself expanded or
      // previewed (resolveInWorktree again, at that later call) -- never here, which would mean
      // one extra filesystem round trip per entry just to list a folder.
      const entries: FileTreeNode[] = [];
      for (const dirent of dirents) {
        if (dirent.name === '.git') continue;
        const entryPath = relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`;
        let isFolder = dirent.isDirectory();
        if (dirent.isSymbolicLink()) {
          const targetStat = await fs.stat(`${resolved.realPath}/${dirent.name}`).catch(() => null);
          isFolder = targetStat?.isDirectory() ?? false;
        }
        entries.push({ path: entryPath, name: dirent.name, kind: isFolder ? 'folder' : 'file' });
      }
      entries.sort(sortEntries);

      return { ok: true, value: { entries } };
    }
  );
}
