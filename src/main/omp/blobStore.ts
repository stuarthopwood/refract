// Issue #513 (research.md Decision 17): resolves a `TranscriptImageRef.id` to its actual bytes,
// either from a `SessionAgent`'s own just-sent live cache (`cached`, served before OMP's blob
// store write has necessarily landed on disk) or from OMP's on-disk blob store at
// `~/.omp/agent/blobs/<id>` (no extension -- a same-content `.<ext>`-suffixed copy also exists
// but is never read here, per the issue's own confirmed probe). Constitution Principle V: this
// is the ONE place that reads that folder; the id is validated against a strict
// `^[0-9a-f]{64}$` pattern before it ever reaches a path, and the path is built from the fixed
// blob folder alone -- no path or file name from the transcript is ever used.
//
// Thumbnail generation: this codebase has no image decode/resize library (`package.json` has
// no `sharp`/`jimp`/`canvas`, and Electron's own `nativeImage` does not reliably decode every
// one of the 4 supported formats, e.g. animated GIF/WebP, across platforms). Adding a new
// heavyweight dependency for a ~480px downscale was judged not worth it for v1: `size` is
// accepted for the IPC surface's own documented 'thumbnail'/'full' distinction, but both
// currently resolve to the SAME bytes -- the existing `MAX_IMAGE_INPUT_BYTES` cap already
// bounds the cost of serving an original as its own thumbnail (disclosed choice, PR body).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupportedImageMimeType } from '../../shared/frames';
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_PIXELS, matchesImageSignature, readImageDimensions, SUPPORTED_IMAGE_MIME_TYPES } from '../../shared/images';

const IMAGE_ID_RE = /^[0-9a-f]{64}$/;
const BLOBS_DIR = path.join(os.homedir(), '.omp', 'agent', 'blobs');
// Matches `attachments.ts`'s own `HEADER_PEEK_BYTES`: up to 16 for the longest magic-byte
// signature (WebP), up to 24 for the longest fixed-offset dimension read (PNG).
const HEADER_PEEK_BYTES = 24;

export interface ResolvedImage {
  dataUrl: string;
  mimeType: SupportedImageMimeType;
  byteLength: number;
  width: number;
  height: number;
}

export type ImageResolution = { ok: true; value: ResolvedImage } | { ok: false; code: 'not-found' | 'invalid' };

/** A `SessionAgent`'s own just-sent live cache entry, keyed by `hashImageBytes` (transcript.ts) --
 * see `SessionAgent.getCachedImage`'s own doc comment for how/when it is populated. */
export interface CachedImageBytes {
  bytes: Buffer;
  mimeType: string;
}

/** Reads the capped, TOCTOU-safe file at `~/.omp/agent/blobs/<id>` -- same pattern as
 * `attachments.ts`'s `readImageFile` (stat, open once, read into a size+1-capped buffer, never a
 * second stat). Returns `undefined` on any failure (missing, not a file, oversized, unreadable);
 * the caller turns that into `not-found`. */
async function readBlobFile(id: string): Promise<Buffer | undefined> {
  const filePath = path.join(BLOBS_DIR, id);
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_INPUT_BYTES) return undefined;
    const capped = Buffer.alloc(Math.min(stat.size, MAX_IMAGE_INPUT_BYTES) + 1);
    const { bytesRead } = await handle.read(capped, 0, capped.length, 0);
    if (bytesRead > MAX_IMAGE_INPUT_BYTES) return undefined;
    return capped.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Issue #513: resolves `id` to its bytes (live cache first, then the on-disk blob store) and
 * validates them against the caller-supplied `mimeType` (the TranscriptItem's own, already
 * recorded by `transcript.ts`) before ever building a renderable `data:` URL -- magic-byte
 * signature, decoded dimensions, and the decompression-bomb pixel cap, exactly like
 * `attachments.ts`'s `readImageFile` validates a path-based attachment. `size` is accepted for
 * the documented 'thumbnail'/'full' IPC shape but does not change the bytes served (see this
 * file's own header comment). Never throws: every failure path returns `{ ok: false }`, which
 * the IPC handler turns into a `Result` error the renderer renders as the "Image no longer
 * available" placeholder, never a broken `<img>`. */
export async function resolveImage(
  id: string,
  mimeType: string,
  _size: 'thumbnail' | 'full',
  cached: CachedImageBytes | undefined,
): Promise<ImageResolution> {
  if (!IMAGE_ID_RE.test(id)) return { ok: false, code: 'invalid' };
  if (!(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return { ok: false, code: 'invalid' };
  const supported = mimeType as SupportedImageMimeType;
  const bytes = cached && cached.mimeType === mimeType ? cached.bytes : await readBlobFile(id);
  if (!bytes) return { ok: false, code: 'not-found' };
  const header = bytes.subarray(0, HEADER_PEEK_BYTES);
  if (!matchesImageSignature(header, supported)) return { ok: false, code: 'invalid' };
  const dimensions = readImageDimensions(bytes, supported);
  if (!dimensions) return { ok: false, code: 'invalid' };
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return { ok: false, code: 'invalid' };
  const dataUrl = `data:${supported};base64,${bytes.toString('base64')}`;
  return { ok: true, value: { dataUrl, mimeType: supported, byteLength: bytes.length, width: dimensions.width, height: dimensions.height } };
}
