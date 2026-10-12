// Preview reader for the File explorer (spec 015 Slice 2, tasks.md T019, research.md decisions
// 3 and 4): reads one file's preview data for `FilePreviewPane.tsx`. Path containment is the
// caller's own job (`fileExplorer.ts`'s `readPreview` handler reuses `resolveListTarget`, the
// same hardened check `listDirectory` already goes through) -- this module only ever receives an
// ALREADY-validated, realpath'd absolute path; it never resolves or re-checks containment itself.

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
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
  // weakest of the five. PR #671 gate round 4 fix (Low, Sec4): a plain text file that happens to
  // start with the two ASCII letters "BM" (not rare: "BMP format", "Bmw", any sentence starting
  // with those letters) previously matched and rendered as a broken image. Also requires the
  // 32-bit little-endian "DIB header size" field at bytes 14-17 to be one of BMP's own known
  // header sizes (12/40/52/56/108/124 -- every BITMAPCOREHEADER/BITMAPINFOHEADER/V4/V5 variant
  // Windows itself recognises) AND the little-endian "file size" field at bytes 2-5 to equal the
  // buffer's own actual length -- two real structural facts a coincidental "BM"-prefixed text
  // file essentially never satisfies by chance, checked only after every more-specific format
  // above has already failed to match.
  if (buf.length >= 18 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const fileSizeField = buf.readUInt32LE(2);
    const headerSize = buf.readUInt32LE(14);
    const KNOWN_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);
    if (fileSizeField === buf.length && KNOWN_DIB_HEADER_SIZES.has(headerSize)) {
      return 'image/bmp';
    }
  }
  return null;
}

/** Reads at most `buf.length` bytes from `fh` into `buf`, looping until the buffer is full or EOF
 * (a single `read()` call is not guaranteed to fill the whole buffer even for a regular file, so
 * this never assumes one call is enough -- PR #671 gate round 4 fix). Returns the total bytes
 * actually read. */
async function readFully(fh: FileHandle, buf: Buffer): Promise<number> {
  let total = 0;
  while (total < buf.length) {
    const { bytesRead } = await fh.read(buf, total, buf.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/** Reads one already-contained, realpath'd file's preview data. `relativePath` is used only for
 * the returned `FilePreview.path` and to pick `'text'` vs `'markdown'` by extension -- never for
 * any filesystem call, which always uses `absolutePath`.
 *
 * PR #671 gate round 4 fix (Medium, Sec4/Code4, reproduced by reading): the previous version
 * `fs.stat`'d the path, THEN reopened it with a SEPARATE `fs.readFile` call -- a file that grows,
 * or is swapped for a symlink, between those two calls was read with NO size cap at all
 * (`readFile` reads to EOF regardless of what `stat` reported moments earlier), and the window
 * also extended `resolveNoFollow`'s own already-documented TOCTOU for a UNC-link swap one step
 * further. Fixed by opening ONE file handle (`fs.open`) and doing every later check (`stat`,
 * `read`) against that SAME handle -- the OS resolves the path exactly once, and nothing between
 * the size check and the read can swap the underlying file out from under it. Also: a NON-`ENOENT`
 * failure (`EACCES`/`EBUSY`, e.g. an agent has the file open for writing) now maps to `kind:
 * 'read-error'`, not `'deleted'` -- those are different, user-visible states, and reporting a
 * permission/busy failure as "removed or renamed" was simply wrong. */
export async function readPreview(absolutePath: string, relativePath: string): Promise<FilePreview> {
  let fh: FileHandle;
  try {
    fh = await fs.open(absolutePath, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { path: relativePath, kind: code === 'ENOENT' ? 'deleted' : 'read-error' };
  }
  try {
    let stat;
    try {
      stat = await fh.stat();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return { path: relativePath, kind: code === 'ENOENT' ? 'deleted' : 'read-error' };
    }
    // Gate round 5 fix (Sec5 Low): a non-regular-file target (a directory, a FIFO/device node)
    // is `'read-error'`, not `'deleted'` -- `'deleted'` is reserved for ENOENT specifically, and
    // the path manifestly still exists here (`stat()` just succeeded against it).
    if (!stat.isFile()) {
      return { path: relativePath, kind: 'read-error' };
    }
    if (stat.size > MAX_PREVIEW_BYTES) {
      return { path: relativePath, kind: 'too-large', size: stat.size };
    }

    // Reads at most `MAX_PREVIEW_BYTES + 1` bytes from the SAME handle `stat()` just checked --
    // a file that grew past the cap between the stat above and this read still hits the cap
    // here (`bytesRead > MAX_PREVIEW_BYTES`), never an unbounded read. The buffer itself is
    // sized from `stat.size`, not always `MAX_PREVIEW_BYTES`, though (gate round 6 fix, Sec6
    // Low): growth BELOW the cap needs its own check, below -- `bytesRead > MAX_PREVIEW_BYTES`
    // alone would miss it.
    const buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES) + 1);
    let bytesRead: number;
    try {
      bytesRead = await readFully(fh, buf);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return { path: relativePath, kind: code === 'ENOENT' ? 'deleted' : 'read-error' };
    }
    if (bytesRead > MAX_PREVIEW_BYTES) {
      return { path: relativePath, kind: 'too-large', size: stat.size };
    }
    // Gate round 6 fix (Sec6 Low): the buffer was sized from `stat.size + 1`, not always
    // `MAX_PREVIEW_BYTES + 1` -- if the file grew between the `stat()` above and this read
    // (still under the overall cap), `readFully` fills the WHOLE buffer without ever reaching
    // EOF, so `bytesRead` lands exactly on `stat.size + 1`: a silently truncated read, one byte
    // short of whatever the file had actually grown to, which can split a multi-byte UTF-8
    // character at that exact boundary. `bytesRead > stat.size` is only possible when more data
    // was available than this buffer was ever sized to hold -- never a legitimate "read it all"
    // outcome for an unchanged file, so this is read as a race, not partial content shown as if
    // complete.
    if (bytesRead > stat.size) {
      return { path: relativePath, kind: 'read-error' };
    }
    const content = buf.subarray(0, bytesRead);

    const imageMimeType = sniffImageMimeType(content);
    if (imageMimeType) {
      return {
        path: relativePath,
        kind: 'image',
        size: bytesRead,
        base64: content.toString('base64'),
        mimeType: imageMimeType
      };
    }
    if (isBinary(content)) {
      return { path: relativePath, kind: 'binary', size: bytesRead };
    }
    const ext = path.extname(relativePath).toLowerCase();
    const kind = MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text';
    return { path: relativePath, kind, size: bytesRead, content: content.toString('utf8') };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
