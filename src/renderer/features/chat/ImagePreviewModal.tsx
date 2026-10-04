import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { PendingImageAttachment } from './attachments'
import { formatByteSize } from './attachments'

export interface ImagePreviewModalProps {
  attachment: PendingImageAttachment
  trigger: ReactNode
}

/** FR-004, FR-016: the full-size preview of a pending pasted image. `trigger` is the thumbnail
 * button itself (`DialogTrigger asChild`) -- Radix's own default focus handling (same pattern as
 * every other dialog in the app, e.g. `NewSessionDialog`) moves focus into the modal on open and
 * returns it to that exact thumbnail on Esc or an outside click, with no extra wiring needed. */
export function ImagePreviewModal({ attachment, trigger }: ImagePreviewModalProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pasted image ({formatByteSize(attachment.byteLength)})</DialogTitle>
        </DialogHeader>
        <img
          src={attachment.previewUrl}
          alt="Pasted content, full size"
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}
