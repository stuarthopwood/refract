// Shared main-process image-file reader (#514/#432): the ONE place that turns a user-supplied OS
// path into a validated image attachment, used by composer paste-path detection (#514) and
// chat-pane drag-and-drop (#432) alike (Stuart, 2026-10-07 on #432: "Build the reader once and
// share it"). This is a USER-initiated read -- a paste, a confirmed typed path, or a file dropped
// from the OS's own file explorer (`webUtils.getPathForFile`) -- never agent/tool/model-authored
// text, so an absolute token is validated and read directly, NOT required to stay inside the
// Session's worktree the way `sessions.revealFile`/the file explorer's own paths are (constitution
// V still applies: main is the sole authority, the renderer never reads a file itself; this is
// simply a different, already-established trust level -- the same one the repository folder
// picker already grants a user's own absolute choice). A token relative to the worktree is
// resolved and contained through `resolveInWorktree`, the single existing containment surface
// (`files.ts`, built for #610) -- never a second implementation.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { AttachmentImageFile, Result } from '../../shared/ipc';
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_PIXELS, readImageDimensions, sniffImageMimeType } from '../../shared/images';
import type { SessionManager } from '../SessionManager';
import { isUnsafeToken, resolveInWorktree } from './files';
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

/** Branches on whether `token` is absolute (read directly, no worktree containment -- see this
 * file's own header comment) or relative (delegates entirely to `resolveInWorktree`, matching "a
 * path relative to the Session's worktree" from #514's own spec). */
async function resolveAttachmentPath(worktreeRoot: string, token: string): Promise<ResolvedAttachmentPath> {
  if (isUnsafeToken(token)) return { ok: false, reason: 'not-found' };
  if (path.isAbsolute(token)) {
    let realPath: string;
    try {
      realPath = await fs.realpath(token);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, realPath };
  }
  const resolved = await resolveInWorktree(worktreeRoot, token);
  if (!resolved.ok) return { ok: false, reason: 'not-found' };
  return { ok: true, realPath: resolved.realPath };
}

/** The reader both #514 and #432 share. Never returns the resolved path or any other file
 * metadata beyond the validated image bytes themselves (this file's own header comment). */
async function readImageFile(worktreeRoot: string, token: string): Promise<Result<AttachmentImageFile>> {
  const resolved = await resolveAttachmentPath(worktreeRoot, token);
  if (!resolved.ok) return notFound('That file could not be found.');

  const stat = await fs.stat(resolved.realPath).catch(() => null);
  if (!stat || !stat.isFile()) return notFound('That file could not be found.');

  // Checked BEFORE ever reading the file's bytes (#514's own requirement: "Check... the size...
  // before decoding"), against the real on-disk size, never a declared/guessed one.
  if (stat.size > MAX_IMAGE_INPUT_BYTES) {
    return { ok: false, error: { code: 'image-too-large', message: `Image is too large to attach (over the ${Math.round(MAX_IMAGE_INPUT_BYTES / (1024 * 1024))} MiB limit); nothing was attached.` } };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolved.realPath);
  } catch {
    return notFound('That file could not be read.');
  }

  // Identified purely by content, never by filename extension -- the same "detect by content"
  // rule spec 015 FR-003 already established for the file explorer, and #514's own explicit
  // instruction ("Do not follow a hint from the extension alone").
  const mimeType = sniffImageMimeType(buffer.subarray(0, Math.min(HEADER_PEEK_BYTES, buffer.length)));
  if (!mimeType) {
    return { ok: false, error: { code: 'unsupported-image-type', message: 'That file is not a supported image type; nothing was attached.' } };
  }

  // Decompression-bomb guard (shared with the renderer's own re-encode path, `shared/images.ts`):
  // a header that cannot be parsed is NOT itself evidence of a bomb (see `readImageDimensions`'s
  // own doc comment) -- only an actually-oversized decoded pixel count is rejected here.
  const dimensions = readImageDimensions(buffer, mimeType);
  if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
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
