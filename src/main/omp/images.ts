// Main-process image validation (spec 009, FR-018, constitution Principle V): the renderer's
// own paste-time check (format already supported or re-encoded to PNG, size under the cap) is
// the primary path a developer actually sees; this is the independent gate that runs again here
// regardless, since the renderer is sandboxed and untrusted for anything crossing into a
// privileged operation -- a bug or a stale renderer must never be the only thing standing
// between a developer and an `ImageTooLargeError` surfacing as a confusing OMP-side failure
// instead of Refract's own clear one.
import { MAX_IMAGE_INPUT_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from '../../shared/images';
import type { ImageContent, SupportedImageMimeType } from '../../shared/frames';

function isSupportedMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Decoded byte length of a base64 string, computed from the string's own length -- never a
 * live decode/download (contracts/ipc.md, tasks.md T002): 3 bytes per 4 base64 characters, minus
 * 1 or 2 for trailing `=` padding. */
export function decodedBase64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

export type ImageValidationResult = { ok: true } | { ok: false; code: 'unsupported-image-type' | 'image-too-large' };

/** `chat.send`/`chat.sendNow` call this on every entry in `images` before ever building the
 * outgoing `prompt`/`steer` command (FR-018, contracts/ipc.md). */
export function validateImageAttachment(image: ImageContent): ImageValidationResult {
  if (!isSupportedMimeType(image.mimeType)) return { ok: false, code: 'unsupported-image-type' };
  if (decodedBase64ByteLength(image.data) > MAX_IMAGE_INPUT_BYTES) return { ok: false, code: 'image-too-large' };
  return { ok: true };
}
