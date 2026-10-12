// Preview reader for the File explorer (spec 015 Slice 2, tasks.md T019, research.md decisions
// 3 and 4): reads one file's preview data for `FilePreviewPane.tsx`. Path containment is the
// caller's own job (`fileExplorer.ts`'s `readPreview` handler reuses `resolveListTarget`, the
// same hardened check `listDirectory` already goes through) -- this module only ever receives an
// ALREADY-validated, realpath'd absolute path; it never resolves or re-checks containment itself.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FilePreview } from '../../shared/model';
import { isBinary } from '../git/diffStat';

/** Matches `diffStat.ts`'s own `MAX_FILE_BYTES` (1 MiB) -- the same "this is plausibly readable
 * in a UI panel" threshold, not a new budget invented for this one caller. A file over this is
 * `kind: 'too-large'` with `size` set, never a partial read (FR-002, SC-001). */
const MAX_PREVIEW_BYTES = 1024 * 1024;

/** Dispatch between `'text'` and `'markdown'` is by EXTENSION, deliberately unlike binary/image
 * detection above (which is content-only, never extension) -- there is no containment or
 * security question here, only "which renderer": a `.md` file that happens to contain NUL bytes
 * still gets caught by `isBinary` first and never reaches this check at all. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/** Magic-byte signatures for the image formats this preview pane renders (research.md decisions
 * 3 and 4): checked on the file's own leading bytes, never its extension -- a `.png` that is
 * actually plain text fails every signature below and falls through to the binary/text path on
 * its own `isBinary`/content result instead of being force-rendered as a broken image. */
function sniffImageMimeType(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP ("BM" magic) is intentionally last and narrowest: only two bytes of signature, the
  // weakest of the five, so it is checked only after every more-specific format above has
  // already failed to match.
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

/** Reads one already-contained, realpath'd file's preview data. `relativePath` is used only for
 * the returned `FilePreview.path` and to pick `'text'` vs `'markdown'` by extension -- never for
 * any filesystem call, which always uses `absolutePath`. */
export async function readPreview(absolutePath: string, relativePath: string): Promise<FilePreview> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return { path: relativePath, kind: 'deleted' };
  }
  if (!stat.isFile()) {
    return { path: relativePath, kind: 'deleted' };
  }
  if (stat.size > MAX_PREVIEW_BYTES) {
    return { path: relativePath, kind: 'too-large', size: stat.size };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(absolutePath);
  } catch {
    return { path: relativePath, kind: 'deleted' };
  }

  const imageMimeType = sniffImageMimeType(buf);
  if (imageMimeType) {
    return { path: relativePath, kind: 'image', size: stat.size, base64: buf.toString('base64'), mimeType: imageMimeType };
  }
  if (isBinary(buf)) {
    return { path: relativePath, kind: 'binary', size: stat.size };
  }
  const ext = path.extname(relativePath).toLowerCase();
  const kind = MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text';
  return { path: relativePath, kind, size: stat.size, content: buf.toString('utf8') };
}
