// Shared remove-with-focus-restoration core for a pending image or file/folder attachment
// (#926: generalises the image-only logic `MessageInput.tsx`'s own `handleRemoveImage` used to
// own alone, which would otherwise have been duplicated near-verbatim for the new file/folder
// kind -- keeping both in `MessageInput.tsx` itself also pushed that file further past its own
// `check:file-size` baseline than a second near-copy justified).
//
// PR #723 gate round 2/3 fixes (A11y2/A11y3 HIGH, carried over unchanged): if focus was inside
// THIS composer's own attachment strip when Remove was activated (never `document`-wide -- split
// view renders two independent strips), it moves to whichever chip now occupies that same
// position, or the previous one if the removed chip was last, or the textarea if none remain;
// `announceAttachment` always fires.
//
// `AttachmentStrip.tsx` renders every image chip, then every file chip, then text chips (which
// have no remove button of their own) -- so a chip's own index among the strip's shared
// `button[aria-label^="Remove"]` query is its bare index for an image, or `imagesCount +
// itsIndex` for a file.
import type { RefObject } from 'react'
import { useDraftStore } from '@/state'

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
    removedIndex = (draftAttachments?.files ?? []).findIndex((file) => file.id === id)
    useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, files: prev.files.filter((file) => file.id !== id) }))
    announceAttachment('File removed.')
  }
  if (!focusWasInStrip || removedIndex === -1) return
  const absoluteIndex = kind === 'image' ? removedIndex : imagesCount + removedIndex
  requestAnimationFrame(() => {
    const removeButtons = attachmentStripRef.current ? Array.from(attachmentStripRef.current.querySelectorAll('button[aria-label^="Remove"]')) : []
    const next = (removeButtons[absoluteIndex] ?? removeButtons[absoluteIndex - 1]) as HTMLElement | undefined
    if (next) next.focus()
    else textareaRef.current?.focus()
  })
}
