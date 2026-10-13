// Main-process image validation (spec 009, FR-018, constitution Principle V): the renderer's
// own paste-time check (format already supported or re-encoded to PNG, size under the cap) is
// the primary path a developer actually sees; this is the independent gate that runs again here
// regardless, since the renderer is sandboxed and untrusted for anything crossing into a
// privileged operation -- a bug or a stale renderer must never be the only thing standing
// between a developer and an `ImageTooLargeError` surfacing as a confusing OMP-side failure
// instead of Refract's own clear one.
import { MAX_IMAGE_INPUT_BYTES, matchesImageSignature, SUPPORTED_IMAGE_MIME_TYPES } from '../../shared/images';
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

/** `chat.send` calls this on every entry in `images` before ever building the outgoing `prompt`
 * command (FR-018, contracts/ipc.md); `chat.sendNow` no longer takes a caller-supplied `images`
 * argument (High remediation), so it never reaches this. */
export function validateImageAttachment(image: ImageContent): ImageValidationResult {
  if (!isSupportedMimeType(image.mimeType)) return { ok: false, code: 'unsupported-image-type' };
  if (decodedBase64ByteLength(image.data) > MAX_IMAGE_INPUT_BYTES) return { ok: false, code: 'image-too-large' };
  // Security remediation (Medium): the two checks above only look at the declared `mimeType`
  // string and the base64 string's own length -- never the real bytes. Decode only the first 24
  // base64 characters (18 bytes) to catch a renamed/mislabeled non-image file that already
  // claims a supported MIME type, without ever touching the rest of a potentially huge payload.
  // PR #723 gate round 3 fix (Sec3 HIGH): round 2 strengthened `matchesImageSignature`'s PNG
  // case to require 16 bytes (full 8-byte signature plus the fixed-offset "IHDR" tag) and its
  // GIF case to require 6 -- this prefix used to decode only 16 base64 characters (12 bytes),
  // so `matchesImageSignature` was always `false` for PNG and `chat.send` rejected every PNG
  // attachment (the format nearly every screenshot is, and the renderer's own re-encode target
  // for any unsupported format) with "Unsupported image type: image/png". 24 base64 characters
  // decode to 18 bytes, covering every current format's signature with headroom.
  const prefix = Buffer.from(image.data.slice(0, 24), 'base64');
  if (!matchesImageSignature(prefix, image.mimeType)) return { ok: false, code: 'unsupported-image-type' };
  return { ok: true };
}
