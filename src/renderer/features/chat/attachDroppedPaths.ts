// Shared attach-loop/notify core for a path-based drop (#432/#793 gate fix): both the Electron
// DOM `drop` path (`ChatPane.tsx`'s `handlePaneDrop`, `File[]` resolved via `getPathForFile`) and
// the Tauri `onFileDrop` path (`useTauriFileDrop.ts`, already real OS paths) now go through this
// one function instead of two near-identical copies of the same loop. Each caller does its own
// per-build path RESOLUTION first (Electron's `getPathForFile` can throw per file; Tauri's paths
// never fail to resolve), then hands the already-resolved list here.
import { notify, useDraftStore } from '@/state'
import { buildImagePathAttachment, describeAttachFailureReason, MAX_PATH_ATTACHMENTS_PER_MESSAGE } from './attachments'
import type { ImagePathAttachFailureReason } from './attachments'

export interface ResolvedDropItem {
  /** Basename only (never a full path, FR-029), for the honest-but-private failure notice. */
  name: string
  filePath: string
}

/** How many of this Session's CURRENTLY pending images still fit, per issue #432's PER-MESSAGE
 * cap -- both callers compute `capped`/`overflowCount` against this before resolving paths, so
 * neither a `File[]` nor a `string[]` drop ever resolves more paths than could ever be attached. */
export function remainingAttachmentSlots(sessionId: string): number {
  const alreadyPending = useDraftStore.getState().bySession[sessionId]?.attachments.images.length ?? 0
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
  let attachedCount = 0
  const failedFiles: { name: string; reason?: ImagePathAttachFailureReason }[] = [...preFailed]
  useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
  try {
    for (const { name, filePath } of resolved) {
      const result = await buildImagePathAttachment(sessionId, filePath)
      if (result.ok) {
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
        attachedCount++
      } else {
        failedFiles.push({ name, reason: result.reason })
      }
    }
  } finally {
    useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
  }
  if (attachedCount > 0) {
    useDraftStore
      .getState()
      .announceAttachment(sessionId, attachedCount === 1 ? 'Image attached from a dropped file.' : `${attachedCount} images attached from dropped files.`)
  }
  const overflowCount = dropped - resolved.length - preFailed.length
  const skipped = failedFiles.length + overflowCount
  if (skipped === 0) return
  const only = failedFiles[0]
  const overflowText =
    overflowCount > 0
      ? remainingSlots === 0
        ? 'This message already has the maximum of 10 images; nothing more was attached.'
        : `Only ${remainingSlots} more image${remainingSlots === 1 ? '' : 's'} could be attached to this message; the rest were skipped.`
      : null
  const saysOther = attachedCount > 0 || overflowCount > 0
  const failureText =
    failedFiles.length === 1 && only
      ? `"${only.name}" ${only.reason ? describeAttachFailureReason(only.reason) : 'could not be attached as an image'}.`
      : failedFiles.length > 1
        ? saysOther
          ? `${failedFiles.length} other files could not be attached as images.`
          : `${failedFiles.length} files could not be attached as images.`
        : null
  notify({
    code: 'invalid-argument',
    message: [overflowText, failureText].filter(Boolean).join(' ')
  })
}
