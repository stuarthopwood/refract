import type { RefObject } from 'react'
import { useDraftStore } from '@/state'

/** Removes a pending attachment and restores focus to the neighbouring chip, else the textarea. */
export function removeAttachment(
  sessionId: string,
  kind: 'image' | 'file',
  id: string,
  attachmentStripRef: RefObject<HTMLDivElement | null>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  announceAttachment: (message: string) => void
): void {
  const activeElement = document.activeElement as HTMLElement | null
  const focusWasInStrip = !!attachmentStripRef.current?.contains(activeElement)
  const draftAttachments = useDraftStore.getState().bySession[sessionId]?.attachments
  const imagesCount = draftAttachments?.images.length ?? 0
  let removedIndex: number
  if (kind === 'image') {
    removedIndex = (draftAttachments?.images ?? []).findIndex((image) => image.id === id)
    useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: prev.images.filter((image) => image.id !== id) }))
    announceAttachment('Image removed.')
  } else {
    const files = draftAttachments?.files ?? []
    removedIndex = files.findIndex((file) => file.id === id)
    const removed = files[removedIndex]
    useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, files: prev.files.filter((file) => file.id !== id) }))
    announceAttachment(removed?.isDirectory ? 'Folder removed.' : 'File removed.')
  }
  if (!focusWasInStrip || removedIndex === -1) return
  const absoluteIndex = kind === 'image' ? removedIndex : imagesCount + removedIndex // strip renders images before files
  requestAnimationFrame(() => {
    const removeButtons = attachmentStripRef.current ? Array.from(attachmentStripRef.current.querySelectorAll('button[aria-label^="Remove"]')) : []
    const next = (removeButtons[absoluteIndex] ?? removeButtons[absoluteIndex - 1]) as HTMLElement | undefined
    if (next) next.focus()
    else textareaRef.current?.focus()
  })
}
