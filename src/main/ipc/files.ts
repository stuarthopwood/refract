// IPC handler for `sessions.revealFile` (issue #610): reveals a single file in the OS file
// explorer via `shell.showItemInFolder`. Deliberately NEVER `shell.openPath` -- that runs the
// file's own default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` an agent or tool wrote would execute),
// which is exactly the attack surface constitution V's "agent/tool/file output is untrusted"
// rule exists to close. The path comes straight from rendered chat text (a linkified file
// reference) -- main is the sole authority on containment; the renderer's own string checks
// (`linkify.ts`) are a cheap early-out, never trusted here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, notFound } from './util';

/** Windows reserved device names (case-insensitive, with or without a trailing extension) --
 * rejected as a path SEGMENT anywhere in the token, before any filesystem call ever touches it. */
const RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^\\/]*)?$/i;

export type ResolveInWorktreeResult =
  | { ok: true; realPath: string }
  | { ok: false; reason: 'outside-worktree' | 'file-missing' | 'worktree-missing' };

/** Resolves `token` (untrusted: agent/tool/model-authored chat text) against `worktreeRoot`,
 * proving containment rather than assuming it. Every string-only rejection below runs BEFORE any
 * filesystem call touches `token` -- a UNC path reaching `fs.realpath`/`shell.showItemInFolder`
 * can trigger an outbound SMB authentication attempt on Windows (NTLM hash leak) even without
 * ever actually opening anything, so these must never be deferred to "resolve first, check
 * after". Shared by the IPC handler below; kept exported so a future caller (e.g. a composer
 * image-path reader, issue #514) can reuse the exact same containment rule instead of a second
 * one-off implementation. */
export async function resolveInWorktree(worktreeRoot: string, token: string): Promise<ResolveInWorktreeResult> {
  // NUL bytes are invalid in any real path and some platform APIs mishandle them outright.
  if (token.includes('\0')) return { ok: false, reason: 'outside-worktree' };

  // UNC (`\\host\share`, `//host/share`) and device paths (`\\?\...`, `\\.\...`) all normalize to
  // a leading `//` once every backslash becomes a forward slash -- one check catches every form.
  if (token.replace(/\\/g, '/').startsWith('//')) return { ok: false, reason: 'outside-worktree' };

  // Any colon other than a single drive-letter prefix (`C:`) is rejected outright: this is what
  // blocks `javascript:`/`data:`/`mailto:`/any other scheme, and an NTFS alternate data stream
  // (`file.txt:Zone.Identifier`) -- the renderer's own `linkify.ts` already strips a trailing
  // `:line[:col]` suffix before ever calling this, so a legitimate token never reaches here with
  // one; this is the independent, non-renderer-trusting half of that same rule.
  const colonIndex = token.indexOf(':');
  if (colonIndex !== -1 && !(colonIndex === 1 && /^[A-Za-z]$/.test(token[0] ?? ''))) {
    return { ok: false, reason: 'outside-worktree' };
  }

  // Reserved device names, checked per path segment (so `foo/CON/bar.ts` is caught too).
  const segments = token.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => RESERVED_NAME_RE.test(segment))) {
    return { ok: false, reason: 'outside-worktree' };
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(worktreeRoot);
  } catch {
    return { ok: false, reason: 'worktree-missing' };
  }

  // A relative token resolves against the (already-realpath'd) worktree root; an absolute one is
  // taken as given and only proven safe by the containment check below, after its own realpath.
  const candidate = path.isAbsolute(token) ? token : path.resolve(resolvedRoot, token);
  let resolvedTarget: string;
  try {
    // `fs.realpath` (not `fs.stat` first) so a symlink/junction inside the worktree that points
    // OUTSIDE it is resolved to its real, final target before the containment check below ever
    // runs -- checking containment against the unresolved candidate path would miss exactly that
    // escape.
    resolvedTarget = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: 'file-missing' };
  }

  // Case-insensitive (Windows): `startsWith` against the root plus a trailing separator, never a
  // bare prefix match, so `C:\Repos\worktree-evil` can never pass as contained in `C:\Repos\worktree`.
  const rootLower = resolvedRoot.toLowerCase();
  const targetLower = resolvedTarget.toLowerCase();
  const contained = targetLower === rootLower || targetLower.startsWith(`${rootLower}${path.sep}`);
  if (!contained) return { ok: false, reason: 'outside-worktree' };

  const stat = await fs.stat(resolvedTarget).catch(() => null);
  if (!stat) return { ok: false, reason: 'file-missing' };

  return { ok: true, realPath: resolvedTarget };
}

export function registerFilesIpc(manager: SessionManager): void {
  ipcMain.handle(
    IPC_REQUESTS.SESSIONS_REVEAL_FILE,
    async (_event, sessionId: unknown, token: unknown): Promise<Result<void>> => {
      if (typeof sessionId !== 'string' || typeof token !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.SESSIONS_REVEAL_FILE} expects a string sessionId and a string path`);
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`Session not found: ${sessionId}`);

      const resolved = await resolveInWorktree(session.worktreePath, token);
      if (!resolved.ok) {
        if (resolved.reason === 'worktree-missing') {
          return { ok: false, error: { code: 'worktree-missing', message: `Worktree missing: ${session.worktreePath}` } };
        }
        if (resolved.reason === 'file-missing') {
          return { ok: false, error: { code: 'file-missing', message: `Couldn't find that file in this Session's worktree` } };
        }
        return { ok: false, error: { code: 'outside-worktree', message: `That path is outside this Session's worktree` } };
      }

      // Never logs the resolved path itself, the same convention `openExternalSafe` follows.
      shell.showItemInFolder(resolved.realPath);
      return { ok: true, value: undefined };
    }
  );
}
