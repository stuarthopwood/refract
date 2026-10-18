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
 * is the total item count before capping, used to compute how many overflowed the per-message cap.
 * Gate round 2 (UI2 Medium): `source` picks "attached"/"attached from dropped files." wording --
 * the Attach-button PICKER shares this exact loop but is not itself a "drop"; a folder is
 * counted and worded separately from an inline/path-sent FILE (`isDirectory` on the attachment
 * itself), never folded into one ambiguous "file" count. */
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
  const overflowText =
    overflowCount > 0
      ? remainingSlots === 0
        ? 'This message already has the maximum of 10 attachments; nothing more was attached.'
        : `Only ${remainingSlots} more attachment${remainingSlots === 1 ? '' : 's'} could be attached to this message; the rest were skipped.`
      : null
  // Gate round 2 (Code2 Medium, item 10): EVERY failed file is named with its own reason, never
  // folded into a bare count once there is more than one -- a developer attaching several bad
  // files at once used to see only "N files could not be attached," with no way to tell which.
  const failureText =
    failedFiles.length > 0
      ? failedFiles.map((f) => `"${f.name}" ${f.reason ? describeAnyAttachFailureReason(f.reason) : 'could not be attached'}.`).join(' ')
      : null
  notify({
    code: 'invalid-argument',
    message: [overflowText, failureText].filter(Boolean).join(' ')
  })
}
