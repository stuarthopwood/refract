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
      // PR #723 gate round 2 fix (Sec2 Low): the full 8-byte PNG signature plus the "IHDR" tag at
      // its fixed offset (PNG spec 11.2.2: the first chunk after the signature is ALWAYS IHDR) --
      // the previous 4-byte check alone accepted any file merely starting with `\x89PNG`,
      // including non-PNG content a prefix happened to share.
      return (
        bytes.length >= 16 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a &&
        bytes[12] === 0x49 && // 'I'
        bytes[13] === 0x48 && // 'H'
        bytes[14] === 0x44 && // 'D'
        bytes[15] === 0x52 // 'R'
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      // PR #723 gate round 2 fix (Sec2 Low): the full "GIF87a"/"GIF89a" signature (6 bytes,
      // including the version) -- the previous 4-byte check alone accepted any file merely
      // starting with "GIF8" (probed: a plain text file beginning "GIF8 this is any text"
      // passed as a "GIF" before this fix).
      return (
        bytes.length >= 6 &&
        bytes[0] === 0x47 && // 'G'
        bytes[1] === 0x49 && // 'I'
        bytes[2] === 0x46 && // 'F'
        bytes[3] === 0x38 && // '8'
        (bytes[4] === 0x37 || bytes[4] === 0x39) && // '7' or '9'
        bytes[5] === 0x61 // 'a'
      );
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
 * match or `null` if none matches. `bytes` only needs to carry the first 16 bytes. */
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
 * to in its spec. Returns `null` on a buffer too short or too malformed to contain a header --
 * the caller REFUSES (fail-closed) any `null` result for any format (round 1 gate fix, Code1
 * Medium: a `null` used to be silently accepted here, a pixel-cap bypass for a truncated/crafted
 * file); a genuinely too-short-to-decode file is never attached, never "possibly fine". */
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
      // 6-byte "GIF87a"/"GIF89a" signature, then the 7-byte Logical Screen Descriptor:
      // width:2/height:2 (little-endian), a packed byte (bit 0x80: Global Color Table present,
      // low 3 bits: its size as 2^(n+1) RGB triples), background colour index, pixel aspect
      // ratio (GIF89a spec section 18).
      //
      // PR #723 gate round 2 fix (Sec2 Medium): the Logical Screen Descriptor's own width/height
      // is only the NOMINAL canvas size -- a crafted file can declare a tiny screen (even 1x1)
      // while an Image Descriptor's own left/top/width/height describe a far larger frame;
      // real-world GIF decoders (including Chromium's) commonly EXPAND the canvas to fit an
      // over-sized frame rather than clipping it, so checking only the screen size let a
      // decompression-bomb-shaped frame bypass the pixel cap entirely.
      //
      // PR #723 gate round 3 fix (Code3 Low): round 2 only walked to the FIRST Image Descriptor
      // and returned immediately -- a crafted file with an innocuous first frame and an
      // oversized SECOND frame still bypassed the cap (probed: a 10x10 screen plus a 60000^2
      // second frame was accepted). This now walks every Image Descriptor in the buffer (never
      // stopping at the first), skipping each frame's own optional Local Color Table and
      // LZW-compressed image-data sub-blocks to reach the next one, and reports
      // `max(screen, every frame's own left+width and top+height)` -- the worst-case canvas size
      // a non-strict decoder could actually allocate across every frame, not only the first.
      // Cheap: the whole file is already in memory, so an extra walk costs nothing new. A walk
      // that finds no Image Descriptor at all (malformed, truncated, or the Trailer `0x3B`
      // reached first) fails closed (`null`), same as every other parser gap in this file.
      if (bytes.length < 13) return null;
      const screenWidth = view.getUint16(6, true);
      const screenHeight = view.getUint16(8, true);
      const packed = view.getUint8(10);
      let offset = 13;
      if (packed & 0x80) {
        const gctEntries = 2 ** ((packed & 0x07) + 1);
        offset += gctEntries * 3;
      }
      let maxWidth = screenWidth;
      let maxHeight = screenHeight;
      let foundAnyFrame = false;
      while (offset < bytes.length) {
        const blockType = view.getUint8(offset);
        if (blockType === 0x21) {
          // Extension: introducer(1) + label(1), then sub-blocks each [size:1][data:size],
          // terminated by a size-0 block.
          offset += 2;
          while (offset < bytes.length) {
            const subBlockSize = view.getUint8(offset);
            offset += 1 + subBlockSize;
            if (subBlockSize === 0) break;
          }
          continue;
        }
        if (blockType === 0x2c) {
          if (offset + 10 > bytes.length) return null;
          const frameLeft = view.getUint16(offset + 1, true);
          const frameTop = view.getUint16(offset + 3, true);
          const frameWidth = view.getUint16(offset + 5, true);
          const frameHeight = view.getUint16(offset + 7, true);
          const framePacked = view.getUint8(offset + 9);
          maxWidth = Math.max(maxWidth, frameLeft + frameWidth);
          maxHeight = Math.max(maxHeight, frameTop + frameHeight);
          foundAnyFrame = true;
          offset += 10;
          if (framePacked & 0x80) {
            const lctEntries = 2 ** ((framePacked & 0x07) + 1);
            offset += lctEntries * 3;
          }
          // LZW minimum code size (1 byte), then image-data sub-blocks, same terminated-by-zero
          // shape as an Extension's sub-blocks above.
          offset += 1;
          while (offset < bytes.length) {
            const subBlockSize = view.getUint8(offset);
            offset += 1 + subBlockSize;
            if (subBlockSize === 0) break;
          }
          continue;
        }
        // Trailer (0x3B) or any other unexpected byte: stop walking: report whatever frames were
        // found so far, or fail closed if none were.
        return foundAnyFrame ? { width: maxWidth, height: maxHeight } : null;
      }
      return foundAnyFrame ? { width: maxWidth, height: maxHeight } : null;
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
