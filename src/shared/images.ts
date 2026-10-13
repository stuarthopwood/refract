// Shared constants for composer attachments (spec 009, data-model.md "Shared constants"): one
// module so the renderer's own paste-time check (immediate feedback) and the main process's
// independent re-check (constitution Principle V) can never drift apart.
import type { SupportedImageMimeType } from './frames';

export const SUPPORTED_IMAGE_MIME_TYPES: readonly SupportedImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
];

/** OMP's own cap (research.md Decision 3): a decoded image over this is rejected, never shrunk. */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024; // 20 MiB

/** research.md Decision 8: a pasted plain-text block over this many characters collapses into a
 * pending text chip instead of landing in the textarea as before. */
export const LARGE_PASTE_CHIP_THRESHOLD = 800;

/** Security remediation (Medium): the MIME-string check in `validateImageAttachment` / the
 * renderer's own `buildImageAttachment` only reads the clipboard's/caller's own *declared*
 * `mimeType`, never the actual bytes -- a renamed/mislabeled non-image file (an archive given a
 * `.png`-shaped clipboard type, for instance) would otherwise pass straight through as a
 * "validated" image. This checks only the first few bytes of `bytes` against the declared type's
 * real magic-byte signature; it never decodes or reads the whole payload, so it is cheap to run
 * on every paste/IPC call regardless of the image's total size. One shared implementation so the
 * renderer's paste-time check and the main process's independent re-check can never drift apart,
 * same reasoning as the constants above. */
export function matchesImageSignature(bytes: Uint8Array, mimeType: SupportedImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
      return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
  }
}

/** #514/#432: identifies a buffer's real image type purely by content, never by filename
 * extension (same "detect by content" rule spec 015 FR-003 already established for the file
 * explorer) -- tries each supported type's magic-byte signature in turn, returns the first
 * match or `null` if none matches. `bytes` only needs to carry the first ~12 bytes. */
export function sniffImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  for (const candidate of SUPPORTED_IMAGE_MIME_TYPES) {
    if (matchesImageSignature(bytes, candidate)) return candidate;
  }
  return null;
}

/** Decompression-bomb guard (Low remediation, originally renderer-only): a tiny file can still
 * declare an enormous pixel count, which would allocate a canvas/bitmap far larger than the byte
 * -size cap alone would catch. Moved here (#514/#432) so the main process's own path-based image
 * reader -- which has no browser `createImageBitmap`/canvas to decode into in the first place --
 * can enforce the exact same cap by parsing just the image header, never the main process's own
 * copy of this number. 40 MP is comfortably larger than any real screenshot/photo while still
 * bounding worst-case memory. */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Parses width/height straight out of a supported format's own header bytes -- no decode, no
 * image library, just the handful of fixed-offset fields each container format already commits
 * to in its spec. Returns `null` on a buffer too short or too malformed to contain a header
 * (treated by the caller as "could not verify dimensions", not as a hard failure -- the magic-
 * byte signature check already proved the type; a header that is merely too short to find
 * dimensions in is not itself evidence of a decompression bomb). */
export function readImageDimensions(bytes: Uint8Array, mimeType: SupportedImageMimeType): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case 'image/png': {
      // 8-byte signature, then one 4-byte chunk length + 4-byte "IHDR" tag, then width/height as
      // two big-endian uint32s (PNG spec 11.2.2).
      if (bytes.length < 24) return null;
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    case 'image/gif': {
      // 6-byte "GIF87a"/"GIF89a" signature, then width/height as two little-endian uint16s
      // (GIF89a spec section 18, Logical Screen Descriptor).
      if (bytes.length < 10) return null;
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    case 'image/jpeg': {
      // Scans marker segments from byte 2 (past the 0xFFD8 SOI marker) looking for a Start Of
      // Frame marker (0xFFC0-0xFFCF, excluding the DHT/JPG/DAC reserved codes 0xC4/0xC8/0xCC):
      // each SOF segment's own payload is [length:2][precision:1][height:2][width:2], both
      // dimensions big-endian (ITU-T T.81 Annex B). Every other marker's 2-byte length field
      // (itself included in the count) says exactly how far to skip to the next marker.
      //
      // PR #723 gate round 1 fix (Sec1/Code1/Verif1 Medium): ITU-T T.81 B.1.1.2 permits any
      // number of 0xFF "fill bytes" between markers (real encoders legitimately emit them, and
      // libjpeg skips them) -- the PREVIOUS version treated the byte right after the first 0xFF
      // as the marker code unconditionally, so a fill byte there was misread as a bogus marker,
      // producing a garbage length and (eventually) a `null` result for a perfectly normal JPEG.
      // `attachments.ts`'s own caller used to treat that `null` as "could not verify, allow it" --
      // together the two bugs let a crafted file with one fill/junk byte before its SOF bypass
      // the pixel cap entirely (fail-open). Fixed at BOTH ends: this loop now skips every
      // consecutive 0xFF before treating the next byte as the real marker code, and the caller
      // now refuses (never allows) a `null` result -- see that file's own comment.
      let offset = 2;
      while (offset + 2 <= bytes.length) {
        if (view.getUint8(offset) !== 0xff) return null; // not a marker where one was expected
        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && view.getUint8(markerOffset) === 0xff) markerOffset++;
        if (markerOffset >= bytes.length) return null;
        const marker = view.getUint8(markerOffset);
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          offset = markerOffset + 1; // markers with no length field (SOI/RST*/EOI/TEM)
          continue;
        }
        if (markerOffset + 3 > bytes.length) return null;
        const segmentLength = view.getUint16(markerOffset + 1, false);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          if (markerOffset + 8 > bytes.length) return null;
          return { height: view.getUint16(markerOffset + 4, false), width: view.getUint16(markerOffset + 6, false) };
        }
        if (marker === 0xda) return null; // Start Of Scan: no SOF seen before entropy-coded data
        offset = markerOffset + 1 + segmentLength;
      }
      return null;
    }
    case 'image/webp': {
      // 12-byte "RIFF"+size+"WEBP" container header, then one chunk: fourCC(4) + size(4) + data.
      if (bytes.length < 21) return null;
      const fourCc = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
      const dataOffset = 20;
      if (fourCc === 'VP8 ') {
        // Lossy: data is [frame tag:3][start code:3][width:2 LE][height:2 LE], each dimension's
        // top 2 bits are an unrelated scale factor (WebP container spec, "Simple File Format (Lossy)").
        if (bytes.length < dataOffset + 10) return null;
        const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
        const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
        return { width, height };
      }
      if (fourCc === 'VP8L') {
        // Lossless: data is [signature:1=0x2f][14 bits width-1][14 bits height-1]... packed
        // little-endian starting right after the signature byte (WebP container spec,
        // "Simple File Format (Lossless)").
        if (bytes.length < dataOffset + 5) return null;
        const bits = view.getUint32(dataOffset + 1, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fourCc === 'VP8X') {
        // Extended: data is [flags:1][reserved:3][canvas width-1:3 LE][canvas height-1:3 LE]
        // (WebP container spec, "Extended File Format").
        if (bytes.length < dataOffset + 10) return null;
        const width = (view.getUint8(dataOffset + 4) | (view.getUint8(dataOffset + 5) << 8) | (view.getUint8(dataOffset + 6) << 16)) + 1;
        const height = (view.getUint8(dataOffset + 7) | (view.getUint8(dataOffset + 8) << 8) | (view.getUint8(dataOffset + 9) << 16)) + 1;
        return { width, height };
      }
      return null;
    }
  }
}
