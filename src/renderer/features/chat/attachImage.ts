// Gate round 2 (code-reviewer LOW): `attachImageFile` lives in its own module, outside the
// import cycle `attachments.ts` would otherwise have with `state/draft-store.ts` -- that file
// needs `@/state` (`notify`, `useDraftStore`), and `draft-store.ts` imports types FROM
// `attachments.ts`, so having both directions in one file worked only because `@/state` happened
// to load first; any entry point loading `attachments.ts` first (a future unit test, say) would
// hit a load-time ReferenceError. This file only imports FROM `attachments.ts` and `@/state`,
// never the other way, so it adds no cycle.
import { buildImageAttachment, formatByteSize, IMAGE_PATH_EXTENSION_RE } from './attachments'
import { buildPastedFileAttachment, MAX_INLINE_FILE_BYTES } from './anyFileAttachments'
import { remainingAttachmentSlots } from './attachDroppedPaths'
import { notify, useDraftStore } from '@/state'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'

/** Validates `file` via `buildImageAttachment` and either toasts the rejection reason or commits
 * the resulting attachment to the draft store and announces it -- the single path both a pasted
 * clipboard image (`MessageInput.tsx`'s own `handlePaste`) and the composer's Attach button
 * (`ComposerPickers.tsx`'s `AttachButton`) go through, so neither the toast wording nor the
 * draft-store write can drift between the two (gate round 1, code-reviewer MEDIUM finding: they
 * used to be two independent four-line copies of this exact sequence). */
export async function attachImageFile(sessionId: string, file: File): Promise<void> {
  const result = await buildImageAttachment(file)
  if (!result.ok) {
    notify({
      code: result.reason === 'too-large' ? 'image-too-large' : 'invalid-argument',
      message:
        result.reason === 'too-large'
          ? `Image is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit); nothing was attached.`
          : 'That image could not be read; nothing was attached.'
    })
    return
  }
  useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
  useDraftStore.getState().announceAttachment(sessionId, `Image attached, ${formatByteSize(result.attachment.byteLength)}.`)
}

/** #926: the validate-plus-commit sequence for a non-image clipboard-pasted `File` (Explorer
 * "Copy" a file, then Ctrl+V) -- mirrors `attachImageFile` above exactly, but for
 * `buildPastedFileAttachment` (renderer-only, no OS path: Tauri's `File` API exposes none for a
 * pasted file, so a binary/over-cap one has no path to fall back to and is a clear, named error
 * instead of a silent drop). */
async function attachPastedFile(sessionId: string, file: File): Promise<void> {
  const result = await buildPastedFileAttachment(file)
  if (!result.ok) {
    notify({
      code: 'invalid-argument',
      message:
        result.reason === 'too-large'
          ? `"${file.name}" is too large to inline (over ${formatByteSize(MAX_INLINE_FILE_BYTES)}) and was pasted with no file path, so it can't be sent as a path reference either; use the Attach button or drag it in instead. Nothing was attached.`
          : result.reason === 'binary'
            ? `"${file.name}" is a binary file pasted with no file path, so it can't be sent as a path reference; use the Attach button or drag it in instead. Nothing was attached.`
            : `"${file.name}" could not be read; nothing was attached.`
    })
    return
  }
  useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, files: [...prev.files, result.attachment] }))
  useDraftStore.getState().announceAttachment(sessionId, `"${file.name}" attached as text, ${formatByteSize(result.attachment.byteLength)}.`)
}

/** #926: attaches every non-image FILE from a clipboard paste (Explorer "Copy" a file, then
 * Ctrl+V) in order -- an image-shaped NAME still goes through `attachImageFile` unchanged
 * (#926's own "images still go to omp as images" decision), checked by extension ALONE
 * (`IMAGE_PATH_EXTENSION_RE`, not `looksLikeImagePathToken`, gate round 1 Code1 HIGH: a pasted
 * `File`'s bare `file.name` carries no path separator/drive prefix at all, so the path-SHAPED
 * check always failed it and silently misrouted every pasted image to the general file reader);
 * everything else goes through `attachPastedFile` above, the only possible outcome for a pasted
 * file with no OS path. Gate round 1 (FR-039 Medium, Test1 Medium): shares the per-message cap
 * with pending images (`remainingAttachmentSlots`), and marks every read `pending` so Enter/Send
 * waits for it the same way a path-based read already does. */
export async function attachPastedFiles(sessionId: string, files: readonly File[], announceAttachment: (message: string) => void): Promise<void> {
  useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
  try {
    const remainingSlots = remainingAttachmentSlots(sessionId)
    const capped = files.slice(0, remainingSlots)
    for (const file of capped) {
      if (IMAGE_PATH_EXTENSION_RE.test(file.name)) await attachImageFile(sessionId, file)
      else await attachPastedFile(sessionId, file)
    }
    const overflow = files.length - capped.length
    if (overflow > 0) {
      announceAttachment(
        remainingSlots === 0
          ? 'This message already has the maximum of 10 attachments; nothing more was attached.'
          : `Only ${remainingSlots} more attachment${remainingSlots === 1 ? '' : 's'} could be attached to this message; ${overflow} ${overflow === 1 ? 'was' : 'were'} skipped.`
      )
    }
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
}
