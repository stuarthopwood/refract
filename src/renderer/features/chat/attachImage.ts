// This file only imports FROM `attachments.ts` and `@/state`, never the other way, so it adds no
// cycle.
import { buildImageAttachment, formatByteSize, IMAGE_PATH_EXTENSION_RE } from './attachments'
import { buildPastedFileAttachment, MAX_INLINE_FILE_BYTES } from './anyFileAttachments'
import { buildOverflowCapMessage, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify, useDraftStore } from '@/state'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'

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

/** #926: the single clipboard-image-paste call site (`MessageInput.tsx`'s own `handlePaste`, when `data.files` carries nothing else) -- the ONLY `attachImageFile` caller not already pre-capped by its own caller (`attachPastedFiles` below slices to `remainingSlots` BEFORE its loop, so re-checking inside `attachImageFile` itself would wrongly reject a file that slice already counted as fitting). */
export async function attachPastedImage(sessionId: string, file: File): Promise<void> {
  if (remainingAttachmentSlots(sessionId) === 0) {
    notify({ code: 'invalid-argument', message: buildOverflowCapMessage(0, 1) })
    return
  }
  await attachImageFile(sessionId, file)
}

function describePastedImageFailureReason(reason: 'too-large' | 'decode-failed'): string {
  return reason === 'too-large'
    ? `is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit)`
    : 'could not be read'
}

function describePastedFileFailureReason(reason: 'too-large' | 'binary' | 'read-failed'): string {
  return reason === 'too-large'
    ? `is too large to inline (over ${formatByteSize(MAX_INLINE_FILE_BYTES)}) and was pasted with no file path, so it can't be sent as a path reference either; use the Attach button or drag it in instead`
    : reason === 'binary'
      ? "is a binary file pasted with no file path, so it can't be sent as a path reference; use the Attach button or drag it in instead"
      : 'could not be read'
}

/** #926: attaches every FILE from a clipboard paste (Explorer "Copy" a file, then Ctrl+V) in order -- an image-shaped NAME attaches as an image (#926's own "images still go to omp as images" decision), checked by extension ALONE (`IMAGE_PATH_EXTENSION_RE`, not `looksLikeImagePathToken`, gate round 1 Code1 HIGH: a pasted `File`'s bare `file.name` carries no path separator/drive prefix at all, so the path-SHAPED check always failed it and silently misrouted every pasted image to the general file reader); everything else attaches as a file, the only possible outcome for a pasted file with no OS path. */
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
    const failureText = failed.length > 0 ? failed.map((f) => `"${f.name}" ${f.reason}.`).join(' ') : null
    notify({ code: 'invalid-argument', message: [overflowText, failureText].filter(Boolean).join(' ') })
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
}
