// Shared attach-loop/notify core for a path-based drop (#432/#793 gate fix, generalised to any
// file type by #926): the Tauri `onFileDrop` path (`useTauriFileDrop.ts`, real OS paths) and
// `ChatPane.tsx`'s own (now Electron-dead, `getPathForFile` is always absent since the Electron
// build was deleted at the Rust cutover, #796) DOM `drop` path both go through this one function
// instead of two near-identical copies of the same loop.
import { notify, useDraftStore } from '@/state'
import { MAX_PATH_ATTACHMENTS_PER_MESSAGE } from './attachments'
import type { ImagePathAttachFailureReason } from './attachments'
import { buildAnyPathAttachment, describeAnyAttachFailureReason } from './anyFileAttachments'
import type { FileAttachFailureReason } from './anyFileAttachments'

export interface ResolvedDropItem {
  /** Basename only (never a full path, FR-029), for the honest-but-private failure notice. */
  name: string
  filePath: string
}

/** How many of this Session's CURRENTLY pending images/files together still fit, per issue
 * #432's PER-MESSAGE cap (#926: now shared across both kinds) -- both callers compute
 * `capped`/`overflowCount` against this before resolving paths, so neither a `File[]` nor a
 * `string[]` drop ever resolves more paths than could ever be attached. */
export function remainingAttachmentSlots(sessionId: string): number {
  const attachments = useDraftStore.getState().bySession[sessionId]?.attachments
  const alreadyPending = (attachments?.images.length ?? 0) + (attachments?.files.length ?? 0)
  return Math.max(0, MAX_PATH_ATTACHMENTS_PER_MESSAGE - alreadyPending)
}

/** Runs the attach loop over already-resolved paths and announces/notifies the result, exactly
 * once per drop regardless of which build's listener produced `resolved`. `preFailed` are items
 * whose path could not even be resolved (Electron's `getPathForFile` throw case only); `dropped`
 * is the total item count before capping, used to compute how many overflowed the per-message cap. */
export async function attachResolvedPaths(
  sessionId: string,
  resolved: ResolvedDropItem[],
  preFailed: { name: string }[],
  dropped: number,
  remainingSlots: number,
  composerDisabled: boolean
): Promise<void> {
  if (composerDisabled) {
    notify({ code: 'disabled', message: 'This session is not accepting input right now; nothing was attached.' })
    return
  }
  if (resolved.length === 0 && preFailed.length === 0 && dropped === 0) return
  let attachedImages = 0
  let attachedFiles = 0
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
        attachedFiles++
      }
    }
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
  const attachedCount = attachedImages + attachedFiles
  if (attachedCount > 0) {
    const parts = [attachedImages > 0 ? `${attachedImages} image${attachedImages === 1 ? '' : 's'}` : null, attachedFiles > 0 ? `${attachedFiles} file${attachedFiles === 1 ? '' : 's'}` : null]
    useDraftStore.getState().announceAttachment(sessionId, `${parts.filter(Boolean).join(' and ')} attached from dropped files.`)
  }
  const overflowCount = dropped - resolved.length - preFailed.length
  const skipped = failedFiles.length + overflowCount
  if (skipped === 0) return
  const only = failedFiles[0]
  const overflowText =
    overflowCount > 0
      ? remainingSlots === 0
        ? 'This message already has the maximum of 10 attachments; nothing more was attached.'
        : `Only ${remainingSlots} more attachment${remainingSlots === 1 ? '' : 's'} could be attached to this message; the rest were skipped.`
      : null
  const saysOther = attachedCount > 0 || overflowCount > 0
  const failureText =
    failedFiles.length === 1 && only
      ? `"${only.name}" ${only.reason ? describeAnyAttachFailureReason(only.reason) : 'could not be attached'}.`
      : failedFiles.length > 1
        ? saysOther
          ? `${failedFiles.length} other files could not be attached.`
          : `${failedFiles.length} files could not be attached.`
        : null
  notify({
    code: 'invalid-argument',
    message: [overflowText, failureText].filter(Boolean).join(' ')
  })
}
