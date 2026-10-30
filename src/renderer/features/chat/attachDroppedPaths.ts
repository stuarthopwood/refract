import { notify, useDraftStore } from '@/state'
import { MAX_PATH_ATTACHMENTS_PER_MESSAGE } from './attachments'
import type { ImagePathAttachFailureReason } from './attachments'
import { buildAnyPathAttachment, describeAnyAttachFailureReason } from './anyFileAttachments'
import type { FileAttachFailureReason } from './anyFileAttachments'

/** A resolved dropped item. */
export interface ResolvedDropItem {
  /** Basename only, never a full path (FR-029). */
  name: string
  filePath: string
}

/** How many more images/files still fit under the per-message cap (#432). */
export function remainingAttachmentSlots(sessionId: string): number {
  const attachments = useDraftStore.getState().bySession[sessionId]?.attachments
  const alreadyPending = (attachments?.images.length ?? 0) + (attachments?.files.length ?? 0)
  return Math.max(0, MAX_PATH_ATTACHMENTS_PER_MESSAGE - alreadyPending)
}

/** The overflow-cap wording shared by every attach path (drop, picker, paste). */
export function buildOverflowCapMessage(remainingSlots: number, overflowCount: number): string {
  return remainingSlots === 0
    ? 'This message already has the maximum of 10 attachments; nothing more was attached.'
    : `Only ${remainingSlots} more attachment${remainingSlots === 1 ? '' : 's'} could be attached to this message; ${overflowCount} ${overflowCount === 1 ? 'was' : 'were'} skipped.`
}

/** Attaches already-resolved paths and notifies once with the result; `preFailed` could not be resolved, `dropped` is the pre-cap total, and `source` picks the wording. */
export async function attachResolvedPaths(
  sessionId: string,
  resolved: ResolvedDropItem[],
  preFailed: { name: string }[],
  dropped: number,
  remainingSlots: number,
  composerDisabled: boolean,
  source: 'picker' | 'drop' = 'drop'
): Promise<void> {
  if (composerDisabled) {
    notify({ code: 'disabled', message: 'This session is not accepting input right now; nothing was attached.' })
    return
  }
  if (resolved.length === 0 && preFailed.length === 0 && dropped === 0) return
  let attachedImages = 0
  let attachedFiles = 0
  let attachedFolders = 0
  const failedFiles: { name: string; reason?: ImagePathAttachFailureReason | FileAttachFailureReason }[] = [...preFailed]
  useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
  try {
    for (const { name, filePath } of resolved) {
      const result = await buildAnyPathAttachment(sessionId, filePath)
      if (!result.ok) {
        failedFiles.push({ name, reason: result.reason })
      } else if (result.kind === 'image') {
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
        attachedImages++
      } else {
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, files: [...prev.files, result.attachment] }))
        if (result.attachment.isDirectory) attachedFolders++
        else attachedFiles++
      }
    }
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
  const attachedCount = attachedImages + attachedFiles + attachedFolders
  if (attachedCount > 0) {
    const parts = [
      attachedImages > 0 ? `${attachedImages} image${attachedImages === 1 ? '' : 's'}` : null,
      attachedFiles > 0 ? `${attachedFiles} file${attachedFiles === 1 ? '' : 's'}` : null,
      attachedFolders > 0 ? `${attachedFolders} folder${attachedFolders === 1 ? '' : 's'}` : null
    ].filter(Boolean)
    const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
    useDraftStore.getState().announceAttachment(sessionId, `${joined} attached${source === 'drop' ? ' from dropped files' : ''}.`)
  }
  const overflowCount = dropped - resolved.length - preFailed.length
  const skipped = failedFiles.length + overflowCount
  if (skipped === 0) return
  const overflowText = overflowCount > 0 ? buildOverflowCapMessage(remainingSlots, overflowCount) : null
  const failureText =
    failedFiles.length > 0
      ? failedFiles.map((f) => `"${f.name}" ${f.reason ? describeAnyAttachFailureReason(f.reason) : 'could not be attached'}.`).join(' ')
      : null
  notify({
    code: 'invalid-argument',
    message: [overflowText, failureText].filter(Boolean).join(' ')
  })
}
