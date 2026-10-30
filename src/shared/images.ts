import type { SupportedImageMimeType } from './frames';

export const SUPPORTED_IMAGE_MIME_TYPES: readonly SupportedImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
];

/** OMP's own cap (research.md Decision 3): a decoded image over this is rejected, never shrunk. */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024; // 20 MiB

/** research.md Decision 8: */
export const LARGE_PASTE_CHIP_THRESHOLD = 800;

/** Security remediation (Medium): */
export function matchesImageSignature(bytes: Uint8Array, mimeType: SupportedImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
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

/** #514/#432: */
export function sniffImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  for (const candidate of SUPPORTED_IMAGE_MIME_TYPES) {
    if (matchesImageSignature(bytes, candidate)) return candidate;
  }
  return null;
}

/** Decompression-bomb guard (Low remediation, originally renderer-only): */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Parses width/height straight out of a supported format's own header bytes -- no decode, no */
export function readImageDimensions(bytes: Uint8Array, mimeType: SupportedImageMimeType): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case 'image/png': {
      if (bytes.length < 24) return null;
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    case 'image/gif': {
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
          offset += 1;
          while (offset < bytes.length) {
            const subBlockSize = view.getUint8(offset);
            offset += 1 + subBlockSize;
            if (subBlockSize === 0) break;
          }
          continue;
        }
        return foundAnyFrame ? { width: maxWidth, height: maxHeight } : null;
      }
      return foundAnyFrame ? { width: maxWidth, height: maxHeight } : null;
    }
    case 'image/jpeg': {
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
      if (bytes.length < 21) return null;
      const fourCc = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
      const dataOffset = 20;
      if (fourCc === 'VP8 ') {
        if (bytes.length < dataOffset + 10) return null;
        const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
        const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
        return { width, height };
      }
      if (fourCc === 'VP8L') {
        if (bytes.length < dataOffset + 5) return null;
        const bits = view.getUint32(dataOffset + 1, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fourCc === 'VP8X') {
        if (bytes.length < dataOffset + 10) return null;
        const width = (view.getUint8(dataOffset + 4) | (view.getUint8(dataOffset + 5) << 8) | (view.getUint8(dataOffset + 6) << 16)) + 1;
        const height = (view.getUint8(dataOffset + 7) | (view.getUint8(dataOffset + 8) << 8) | (view.getUint8(dataOffset + 9) << 16)) + 1;
        return { width, height };
      }
      return null;
    }
  }
}
