import * as React from 'react'
import { ImageViewer } from '@/components/ImageViewer'
import type { PendingImageAttachment } from './attachments'

export interface ImagePreviewModalProps {
  attachment: PendingImageAttachment
  trigger: React.ReactElement<{ onClick?: React.MouseEventHandler }>
}

/** FR-004, FR-016: the full-size preview of a pending pasted image, now the shared `ImageViewer`.
 * `trigger` is the thumbnail button itself; Radix returns focus to it on close. */
export function ImagePreviewModal({ attachment, trigger }: ImagePreviewModalProps) {
  const [open, setOpen] = React.useState(false)
  const items = React.useMemo(
    () => [{ key: attachment.id, data: { src: attachment.previewUrl, byteLength: attachment.byteLength } }],
    [attachment.id, attachment.previewUrl, attachment.byteLength]
  )
  return (
    <>
      {React.cloneElement(trigger, { onClick: () => setOpen(true) })}
      <ImageViewer open={open} onOpenChange={setOpen} items={items} index={0} onIndexChange={() => {}} title="Pasted image" />
    </>
  )
}
