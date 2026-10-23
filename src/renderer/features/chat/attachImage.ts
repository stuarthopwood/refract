// Gate round 2 (code-reviewer LOW): `attachImageFile` lives in its own module, outside the
// import cycle `attachments.ts` would otherwise have with `state/draft-store.ts` -- that file
// needs `@/state` (`notify`, `useDraftStore`), and `draft-store.ts` imports types FROM
// `attachments.ts`, so having both directions in one file worked only because `@/state` happened
// to load first; any entry point loading `attachments.ts` first (a future unit test, say) would
// hit a load-time ReferenceError. This file only imports FROM `attachments.ts` and `@/state`,
// never the other way, so it adds no cycle.
import { buildImageAttachment, formatByteSize, IMAGE_PATH_EXTENSION_RE } from './attachments'
import { buildPastedFileAttachment, MAX_INLINE_FILE_BYTES } from './anyFileAttachments'
import { buildOverflowCapMessage, remainingAttachmentSlots } from './attachDroppedPaths'
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

/** #926: the single clipboard-image-paste call site (`MessageInput.tsx`'s own `handlePaste`,
 * when `data.files` carries nothing else) -- the ONLY `attachImageFile` caller not already
 * pre-capped by its own caller (`attachPastedFiles` below slices to `remainingSlots` BEFORE its
 * loop, so re-checking inside `attachImageFile` itself would wrongly reject a file that slice
 * already counted as fitting). Gate round 2 (UI2 Low): still respects the FR-039 shared
 * per-message cap (images+files together) -- FR-005's own "no cap" language predates that shared
 * cap and only ever meant "no image-specific sub-limit of its own". */
export async function attachPastedImage(sessionId: string, file: File): Promise<void> {
  if (remainingAttachmentSlots(sessionId) === 0) {
    // Gate round 4 (Code4 Low): shares `buildOverflowCapMessage`'s own wording instead of a
    // third independent literal copy of the same "maximum of 10" string.
    notify({ code: 'invalid-argument', message: buildOverflowCapMessage(0, 1) })
    return
  }
  await attachImageFile(sessionId, file)
}

/** Gate round 3 (UI3/Code3 Medium): the full per-reason wording for a failed pasted IMAGE
 * within a multi-file paste -- kept detailed (never just "could not be attached"), but returns a
 * STRING instead of calling `notify` directly so `attachPastedFiles` below can name this file
 * alongside every other failure in ONE combined toast, instead of one toast per image. */
function describePastedImageFailureReason(reason: 'too-large' | 'decode-failed'): string {
  return reason === 'too-large'
    ? `is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit)`
    : 'could not be read'
}

/** Gate round 3 (UI3/Code3 Medium): same reasoning as the image version above, for a failed
 * pasted non-image FILE (`buildPastedFileAttachment`'s own failure union) -- the detailed
 * explanation (no OS path, use Attach/drag-drop instead) survives, just per-file and joinable. */
function describePastedFileFailureReason(reason: 'too-large' | 'binary' | 'read-failed'): string {
  return reason === 'too-large'
    ? `is too large to inline (over ${formatByteSize(MAX_INLINE_FILE_BYTES)}) and was pasted with no file path, so it can't be sent as a path reference either; use the Attach button or drag it in instead`
    : reason === 'binary'
      ? "is a binary file pasted with no file path, so it can't be sent as a path reference; use the Attach button or drag it in instead"
      : 'could not be read'
}

/** #926: attaches every FILE from a clipboard paste (Explorer "Copy" a file, then Ctrl+V) in
 * order -- an image-shaped NAME attaches as an image (#926's own "images still go to omp as
 * images" decision), checked by extension ALONE (`IMAGE_PATH_EXTENSION_RE`, not
 * `looksLikeImagePathToken`, gate round 1 Code1 HIGH: a pasted `File`'s bare `file.name` carries
 * no path separator/drive prefix at all, so the path-SHAPED check always failed it and silently
 * misrouted every pasted image to the general file reader); everything else attaches as a file,
 * the only possible outcome for a pasted file with no OS path. Gate round 1 (FR-039 Medium,
 * Test1 Medium): shares the per-message cap with pending images (`remainingAttachmentSlots`),
 * and marks every read `pending` so Enter/Send waits for it the same way a path-based read
 * already does. Gate round 3 (UI3/Test3 Medium): calls `buildImageAttachment`/
 * `buildPastedFileAttachment` DIRECTLY instead of going through `attachImageFile`/the former
 * per-file `attachPastedFile` helper -- those each notify/announce individually, which used to
 * fire one sr-only announcement AND one toast per file in a multi-file paste; this loop instead
 * collects every success and failure and reports ONCE after the loop, matching
 * `attachDroppedPaths.ts`'s own `attachResolvedPaths` (the drop/picker shared core) exactly, and
 * shares its `buildOverflowCapMessage` wording rather than a second, independent copy. */
export async function attachPastedFiles(sessionId: string, files: readonly File[]): Promise<void> {
  useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
  try {
    const remainingSlots = remainingAttachmentSlots(sessionId)
    const capped = files.slice(0, remainingSlots)
    let attachedImages = 0
    let attachedFiles = 0
    const failed: { name: string; reason: string }[] = []
    for (const file of capped) {
      if (IMAGE_PATH_EXTENSION_RE.test(file.name)) {
        const result = await buildImageAttachment(file)
        if (!result.ok) {
          failed.push({ name: file.name, reason: describePastedImageFailureReason(result.reason) })
          continue
        }
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
        attachedImages++
      } else {
        const result = await buildPastedFileAttachment(file)
        if (!result.ok) {
          failed.push({ name: file.name, reason: describePastedFileFailureReason(result.reason) })
          continue
        }
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, files: [...prev.files, result.attachment] }))
        attachedFiles++
      }
    }
    const attachedCount = attachedImages + attachedFiles
    if (attachedCount > 0) {
      const parts = [
        attachedImages > 0 ? `${attachedImages} image${attachedImages === 1 ? '' : 's'}` : null,
        attachedFiles > 0 ? `${attachedFiles} file${attachedFiles === 1 ? '' : 's'}` : null
      ].filter(Boolean)
      const joined = parts.length > 1 ? `${parts[0]} and ${parts[1]}` : parts[0]
      useDraftStore.getState().announceAttachment(sessionId, `${joined} attached.`)
    }
    const overflow = files.length - capped.length
    if (failed.length === 0 && overflow === 0) return
    const overflowText = overflow > 0 ? buildOverflowCapMessage(remainingSlots, overflow) : null
    // Gate round 2 (Test2 HIGH) / round 3 (UI3/Code3 Medium): a VISIBLE toast, not only the
    // sr-only live region, naming EVERY failed file with its own reason in ONE combined
    // message -- never one toast per file, and never an absolute "nothing was attached" when
    // `attachedCount` above is actually positive (each per-file reason only ever describes that
    // one file's own fate, not the whole paste's).
    const failureText = failed.length > 0 ? failed.map((f) => `"${f.name}" ${f.reason}.`).join(' ') : null
    notify({ code: 'invalid-argument', message: [overflowText, failureText].filter(Boolean).join(' ') })
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
}
