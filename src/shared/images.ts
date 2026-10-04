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
