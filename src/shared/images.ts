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
