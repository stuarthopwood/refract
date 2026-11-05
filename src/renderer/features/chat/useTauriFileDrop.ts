// Tauri's native drag-drop swallows the DOM `drop` event, so drops arrive via `onFileDrop` instead (#793).
// One app-wide subscription (the native hook is single); panes register here and a drop is hit-tested against each. 
import { useEffect, useRef } from 'react'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify } from '@/state'

interface PaneDescriptor {
  sessionId: string
  paneRef: { current: HTMLElement | null }
  /** Read fresh per drop; `composerDisabled` changes without re-registering. */
  isComposerDisabled: () => boolean
  dragDepthRef: { current: number }
  setIsDraggingFiles: (value: boolean) => void
}

const panes = new Set<PaneDescriptor>()
let unsubscribe: (() => void) | undefined

function ensureSubscribed(): void {
  if (unsubscribe) return
  const onFileDrop = window.refract.attachments.onFileDrop
  unsubscribe = onFileDrop(({ paths, position }) => {
    // The DOM `drop` never fires here, so nothing else clears the drag-over overlay.
    for (const pane of panes) {
      pane.dragDepthRef.current = 0
      pane.setIsDraggingFiles(false)
    }
    // `position` is physical px; devicePixelRatio (OS scale x page zoom) converts to CSS px at any zoom.
    const x = position.x / window.devicePixelRatio
    const y = position.y / window.devicePixelRatio
    for (const pane of panes) {
      const rect = pane.paneRef.current?.getBoundingClientRect()
      if (!rect) continue
      // Half-open bounds so a drop on a shared split-view edge lands in exactly one pane.
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue
      void handleDrop(pane, paths)
      break
    }
  })
}

async function handleDrop(pane: PaneDescriptor, paths: string[]): Promise<void> {
  // Record paths on the Session allow-list first: `readFile` refuses unrecorded absolute paths.
  // Check the Result so an unknown session fails here, not confusingly at `readFile`.
  const recordResult = await window.refract.attachments.recordDroppedPaths(pane.sessionId, paths)
  if (!recordResult.ok) {
    notify(recordResult.error)
    return
  }
  const remainingSlots = remainingAttachmentSlots(pane.sessionId)
  const capped = paths.slice(0, remainingSlots)
  const resolved = capped.map((filePath) => ({ name: filePath.split(/[\\/]/).pop() ?? filePath, filePath }))
  await attachResolvedPaths(pane.sessionId, resolved, [], paths.length, remainingSlots, pane.isComposerDisabled())
}

interface UseTauriFileDropArgs {
  sessionId: string
  paneRef: { current: HTMLElement | null }
  composerDisabled: boolean
  dragDepthRef: { current: number }
  setIsDraggingFiles: (value: boolean) => void
}

export function useTauriFileDrop({ sessionId, paneRef, composerDisabled, dragDepthRef, setIsDraggingFiles }: UseTauriFileDropArgs): void {
  const composerDisabledRef = useRef(composerDisabled)
  composerDisabledRef.current = composerDisabled
  useEffect(() => {
    ensureSubscribed()
    const descriptor: PaneDescriptor = {
      sessionId,
      paneRef,
      isComposerDisabled: () => composerDisabledRef.current,
      dragDepthRef,
      setIsDraggingFiles
    }
    panes.add(descriptor)
    return () => {
      panes.delete(descriptor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
}
