// Tauri build only (issue #793, spike section 2): Tauri's own native drag-drop handler swallows
// the HTML5 `drop` DOM event before `ChatPane.tsx`'s own `handlePaneDrop` ever sees it
// (`dragDropEnabled` defaults to `true`, left unset in `tauri.conf.json`'s window config), so the
// composer never attaches a dropped image there today. Listens to `window.refract.attachments.
// onFileDrop` instead (absent in the Electron build, where the DOM path already works
// unmodified), hit-tests the drop's physical-pixel `position` against the pane's own
// `getBoundingClientRect()`, and reuses the exact same attach-loop/notify shape `handlePaneDrop`
// already has for a `File[]` drop, sourced from real OS paths instead (`src/shared/ipc.ts`'s own
// doc comment: `ATTACHMENTS_READ_IMAGE_FILE` already accepts an absolute path, no backend change
// needed). Extracted to its own file (not inlined in `ChatPane.tsx`) so an already-over-the-600-
// line-cap file (issue #806, "no god files") never grows for this Tauri-only wiring.
import { useEffect } from 'react'
import { notify, useDraftStore } from '@/state'
import { buildImagePathAttachment, describeAttachFailureReason, MAX_PATH_ATTACHMENTS_PER_MESSAGE } from './attachments'
import type { ImagePathAttachFailureReason } from './attachments'

interface UseTauriFileDropArgs {
  sessionId: string
  paneRef: { current: HTMLElement | null }
  composerDisabled: boolean
  dragDepthRef: { current: number }
  setIsDraggingFiles: (value: boolean) => void
}

export function useTauriFileDrop({ sessionId, paneRef, composerDisabled, dragDepthRef, setIsDraggingFiles }: UseTauriFileDropArgs): void {
  useEffect(() => {
    const onFileDrop = window.refract.attachments.onFileDrop
    if (!onFileDrop) return
    return onFileDrop(({ paths, position }) => {
      // Nothing else ever clears the drag-over overlay for a real drop in this build (the DOM
      // `drop` event `handlePaneDrop` normally resets it on never fires here) -- reset it
      // unconditionally, even for a drop that lands outside this pane; every mounted pane runs
      // this same effect, so the reset is idempotent and harmless for the ones it did not hit.
      dragDepthRef.current = 0
      setIsDraggingFiles(false)
      const pane = paneRef.current
      if (!pane) return
      const rect = pane.getBoundingClientRect()
      // `position` is physical pixels relative to the webview's own top-left corner (spike
      // section 2); `getBoundingClientRect()` is CSS (logical) pixels.
      const x = position.x / window.devicePixelRatio
      const y = position.y / window.devicePixelRatio
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return
      void attach(sessionId, paths, composerDisabled)
    })
    // `paneRef`/`dragDepthRef`/`setIsDraggingFiles` are stable across renders (refs and a
    // `useState` setter); only a Session switch or the disabled flag changing needs a fresh
    // listener closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, composerDisabled])
}

async function attach(sessionId: string, paths: string[], composerDisabled: boolean) {
  if (composerDisabled) {
    notify({ code: 'disabled', message: 'This session is not accepting input right now; nothing was attached.' })
    return
  }
  if (paths.length === 0) return
  const alreadyPending = useDraftStore.getState().bySession[sessionId]?.attachments.images.length ?? 0
  const remainingSlots = Math.max(0, MAX_PATH_ATTACHMENTS_PER_MESSAGE - alreadyPending)
  const capped = paths.slice(0, remainingSlots)
  let attachedCount = 0
  // Basenames only (never a full path, FR-029) of every path that did not attach, for an
  // honest-but-private failure notice, matching `handlePaneDrop`'s own `File[]` path.
  const failedFiles: { name: string; reason?: ImagePathAttachFailureReason }[] = []
  useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
  try {
    for (const filePath of capped) {
      const name = filePath.split(/[\\/]/).pop() ?? filePath
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
  const overflowCount = paths.length - capped.length
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
