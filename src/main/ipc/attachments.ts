// Shared main-process image-file reader (#514/#432): the ONE place that turns a user-supplied OS
// path into a validated image attachment, used by composer paste-path detection (#514) and
// chat-pane drag-and-drop (#432) alike (Stuart, 2026-10-07 on #432: "Build the reader once and
// share it"). This is a USER-initiated read -- a paste, a confirmed typed path, or a file dropped
// from the OS's own file explorer (`webUtils.getPathForFile`) -- never agent/tool/model-authored
// text IN THE SENSE OF "the final destination is chosen by the user", but PR #723 gate round 1
// (Sec1/Verif1 HIGH, reproduced live) found that an agent-planted symlink inside the worktree
// (printed as an absolute path in chat text the user then copies and pastes, or dragged directly)
// still reached `fs.realpath` unvetted -- so every absolute token is now walked one segment at a
// time (`resolveNoFollowUnrooted`, `files.ts`) with every link's OWN target text re-vetted by
// `isUnsafeToken` before it is ever followed, exactly like a top-level token, same as the
// worktree-relative branch already does via `resolveInWorktree`. An absolute token is still NOT
// required to stay inside any particular Session's worktree (research.md Decision 11: the
// resolved FILE itself may legitimately live anywhere on disk, e.g. Downloads/Pictures) -- only
// its OWN path text and every LINK it passes through are vetted, never its final containment.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { AttachmentImageFile, Result } from '../../shared/ipc';
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_PIXELS, readImageDimensions, sniffImageMimeType } from '../../shared/images';
import type { SessionManager } from '../SessionManager';
import { isUnsafeToken, resolveInWorktree, resolveNoFollowUnrooted } from './files';
import { invalidArgument, notFound } from './util';

const MAX_SESSION_ID_LENGTH = 256;
// Matches `files.ts`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt) -- kept as an
// independent constant rather than importing that one, same reasoning `fileExplorer.ts`'s own
// copy already documents: the two call sites have no reason to be forced to change together.
const MAX_PATH_LENGTH = 4096;

// Only the first 24 bytes of a file are ever needed: up to 16 for the magic-byte signature check
// (`matchesImageSignature`'s own WebP case, the longest) and up to 24 for `readImageDimensions`'s
// PNG case (its own longest fixed read). Read once, reused for both checks.
const HEADER_PEEK_BYTES = 24;

type ResolvedAttachmentPath = { ok: true; realPath: string } | { ok: false; reason: 'not-found' };

/** Branches on whether `token` is absolute (walked one segment at a time via
 * `resolveNoFollowUnrooted`, no worktree containment -- see this file's own header comment) or
 * relative (delegates entirely to `resolveInWorktree`, matching "a path relative to the Session's
 * worktree" from #514's own spec). */
async function resolveAttachmentPath(worktreeRoot: string, token: string): Promise<ResolvedAttachmentPath> {
  if (isUnsafeToken(token)) return { ok: false, reason: 'not-found' };
  if (path.isAbsolute(token)) {
    const walked = await resolveNoFollowUnrooted(token);
    if (!walked.ok) return { ok: false, reason: 'not-found' };
    // PR #723 gate round 2 fix (Sec2 Low, Verif2 Medium): this used to call `fs.realpath
    // (walked.path)` here "only to canonicalise casing/8.3 short names" -- but `fs.realpath`
    // FOLLOWS LINKS, and `walked.path` is already link-free, so that call bought nothing except
    // a second, unvetted chance for a link swapped in between the walk and this call to be
    // followed (round 1's own SMB/NTLM class of bug, reopened as a race). `walked.path` is
    // handed to `readImageFile` as-is now; `fs.open` below is the only further filesystem call
    // that touches it.
    //
    // **Accepted residual risk (PR #723 gate round 2, Sec2/Verif2 Low/Medium; the lane's own
    // measurement, not independently reproduced by every reviewer: 1/1228 runs under a tight
    // symlink-swap loop)**: a window still exists between this walk's last `fs.lstat` and
    // `readImageFile`'s own `fs.open` -- a link swapped into an already-checked segment in that
    // window could still be followed by `fs.open`. This is the same RACE WINDOW
    // `resolveNoFollow`'s own doc comment (`files.ts`) already documents for the worktree-relative
    // branch below (round 3 correction, Code3 Low: NOT "the exact same accepted residual" --
    // the relative branch's window ends in `resolveInWorktree`'s own `fs.realpath` followed by a
    // containment rejection, a backstop this absolute branch has no equivalent of; here, a link
    // swapped in during the window is followed by `fs.open` and its bytes read with no check
    // after, so a swapped-in image located ANYWHERE ELSE on disk could be attached, on top of the
    // shared UNC/NTLM risk). Winning it requires a process with symlink-creation privilege
    // already running locally as the user racing a paste/drop, i.e. the same local attacker who
    // could already reach a UNC path directly -- accepted, not mitigated.
    return { ok: true, realPath: walked.path };
  }
  const resolved = await resolveInWorktree(worktreeRoot, token);
  if (!resolved.ok) return { ok: false, reason: 'not-found' };
  return { ok: true, realPath: resolved.realPath };
}

/** The reader both #514 and #432 share. Never returns the resolved path or any other file
 * metadata beyond the validated image bytes themselves (this file's own header comment).
 *
 * PR #723 gate round 1 fix (Sec1/Code1/Verif1 Medium, TOCTOU): the size cap and the read now both
 * go through the SAME open file handle (`fs.open` -> `handle.stat()` -> a single bounded read),
 * never a `fs.stat(path)` followed by a separate `fs.readFile(path)` -- a file swapped or grown
 * between those two calls could otherwise be read with no limit at all. The read buffer is sized
 * from the real on-disk size (round 2 fix, Sec2 Low; see the read call site below), capped at
 * `MAX_IMAGE_INPUT_BYTES + 1` so an over-cap file is rejected from the bytes actually read, not
 * from a second, already-stale stat. */
async function readImageFile(worktreeRoot: string, token: string): Promise<Result<AttachmentImageFile>> {
  const resolved = await resolveAttachmentPath(worktreeRoot, token);
  if (!resolved.ok) return notFound('That file could not be found.');

  let handle: fs.FileHandle | undefined;
  let buffer: Buffer;
  try {
    handle = await fs.open(resolved.realPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return notFound('That file could not be found.');
    // Checked BEFORE ever reading the file's bytes (#514's own requirement: "Check... the size...
    // before decoding"), against the real on-disk size from the SAME open handle, never a
    // separately-stat'd, possibly-stale one.
    if (stat.size > MAX_IMAGE_INPUT_BYTES) {
      return {
        ok: false,
        error: { code: 'image-too-large', message: `Image is too large to attach (over the ${Math.round(MAX_IMAGE_INPUT_BYTES / (1024 * 1024))} MiB limit); nothing was attached.` }
      };
    }
    // PR #723 gate round 2 fix (Sec2 Low): sized from the REAL on-disk size (capped at the byte
    // limit), not a flat `MAX_IMAGE_INPUT_BYTES + 1` allocation every time -- a 1 KB file no
    // longer zero-fills 20 MiB. `+ 1` still over-reads by one byte so a file that GREW past the
    // cap between the stat above and this read is caught by `bytesRead > stat.size` below.
    const capped = Buffer.alloc(Math.min(stat.size, MAX_IMAGE_INPUT_BYTES) + 1);
    const { bytesRead } = await handle.read(capped, 0, capped.length, 0);
    if (bytesRead > stat.size) {
      // The file changed size between the stat and this read -- refuse rather than trust a
      // read that no longer matches what was size-checked.
      return notFound('That file could not be read.');
    }
    // PR #723 gate round 3 fix (Code3 Low): the `bytesRead > MAX_IMAGE_INPUT_BYTES` branch that
    // used to sit here was dead code -- `stat.size` is already checked `<= MAX_IMAGE_INPUT_BYTES`
    // above (or this function already returned), the buffer is sized from `stat.size` (never
    // larger than `MAX_IMAGE_INPUT_BYTES + 1`), and the `bytesRead > stat.size` check above
    // already catches the only way `bytesRead` could exceed `stat.size` -- so `bytesRead` can
    // never exceed `MAX_IMAGE_INPUT_BYTES` once both checks above have passed. Removed.
    buffer = capped.subarray(0, bytesRead);
  } catch {
    return notFound('That file could not be read.');
  } finally {
    await handle?.close().catch(() => {});
  }

  // Identified purely by content, never by filename extension -- the same "detect by content"
  // rule spec 015 FR-003 already established for the file explorer, and #514's own explicit
  // instruction ("Do not follow a hint from the extension alone").
  const mimeType = sniffImageMimeType(buffer.subarray(0, Math.min(HEADER_PEEK_BYTES, buffer.length)));
  if (!mimeType) {
    return { ok: false, error: { code: 'unsupported-image-type', message: 'That file is not a supported image type; nothing was attached.' } };
  }

  // Decompression-bomb guard (shared with the renderer's own re-encode path, `shared/images.ts`).
  // PR #723 gate round 1 fix (Sec1/Code1/Verif1 Medium, fail-open): a `null` result used to be
  // treated as "could not verify, allow it" -- but every one of the 4 supported formats always
  // carries its own dimensions in a fixed-offset header field when genuinely well-formed; `null`
  // now means either a malformed/truncated file OR a crafted header designed to defeat the
  // parser (the JPEG walker's own 0xFF-fill-byte fix closes one such case; `null` is the
  // catch-all for any other parser gap), and is refused either way -- the magic-byte check above
  // already proved the type, so "dimensions unreadable" is never itself evidence of anything
  // OTHER than a file this reader will not attach.
  const dimensions = readImageDimensions(buffer, mimeType);
  if (!dimensions) {
    return { ok: false, error: { code: 'unsupported-image-type', message: 'That file could not be read as an image; nothing was attached.' } };
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return { ok: false, error: { code: 'image-too-large', message: 'Image exceeds the maximum pixel count; nothing was attached.' } };
  }

  return { ok: true, value: { mimeType, base64: buffer.toString('base64'), byteLength: buffer.length } };
}

export function registerAttachmentsIpc(manager: SessionManager): void {
  ipcMain.handle(
    IPC_REQUESTS.ATTACHMENTS_READ_IMAGE_FILE,
    async (_event, sessionId: unknown, token: unknown): Promise<Result<AttachmentImageFile>> => {
      if (typeof sessionId !== 'string' || typeof token !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.ATTACHMENTS_READ_IMAGE_FILE} expects a string sessionId and a string path`);
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || token.length > MAX_PATH_LENGTH) {
        return invalidArgument(`${IPC_REQUESTS.ATTACHMENTS_READ_IMAGE_FILE} rejected an oversized sessionId or path`);
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`Session not found: ${sessionId}`);
      return readImageFile(session.worktreePath, token);
    }
  );
}
