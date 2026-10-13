import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { formatByteSize } from './attachments'

/** One image the viewer can show -- `src` is always already a renderable `data:` URL (never
 * `blob:`, the CSP forbids it): either the composer's own just-built preview, or a transcript
 * image's resolved `images.get` result. `mimeType`/`byteLength` are optional because a
 * transcript image's history (`blob:sha256:`) case has neither until resolution completes. */
export interface ViewerImage {
  src: string
  mimeType?: string
  byteLength?: number
}

export interface ImagePreviewModalProps {
  images: ViewerImage[]
  /** Which `images` entry this particular trigger opens to; defaults to 0 (the composer's own
   * single-image case never needs anything else). */
  initialIndex?: number
  trigger: ReactNode
  /** FR-004/FR-016 (composer) and issue #513 (transcript): the fixed word before the parenthesised
   * detail, e.g. "Pasted image" or "Image". Defaults to "Image". */
  titlePrefix?: string
}

function formatMimeLabel(mimeType: string): string | undefined {
  const slash = mimeType.indexOf('/')
  if (slash === -1) return undefined
  return mimeType.slice(slash + 1).toUpperCase()
}

/** FR-004, FR-016 (composer) and issue #513 (transcript bubble): the full-size preview of any
 * image source, generalised from the composer-only `PendingImageAttachment` modal it began as.
 * Several `images` (issue #513 requirement 3) get Left/Right navigation inside the SAME dialog;
 * a single image (every composer use, and a one-image transcript message) gets none, matching
 * the original composer-only behaviour exactly. Radix's own default fade/scale transition and
 * focus-trap/Esc/close-button/focus-return handling are unchanged -- no new zoom effect is added
 * on top of it (reduced-motion requirement). */
export function ImagePreviewModal({ images, initialIndex = 0, trigger, titlePrefix = 'Image' }: ImagePreviewModalProps) {
  const [index, setIndex] = useState(initialIndex)
  const total = images.length
  const current = images[index]
  const canNavigate = total > 1

  function handleOpenChange(open: boolean) {
    if (open) setIndex(initialIndex)
  }

  function goTo(nextIndex: number) {
    setIndex(((nextIndex % total) + total) % total)
  }

  if (!current) return null

  const details = [
    canNavigate ? `${index + 1} of ${total}` : null,
    current.mimeType ? formatMimeLabel(current.mimeType) : null,
    current.byteLength != null ? formatByteSize(current.byteLength) : null
  ].filter((part): part is string => part != null)
  const title = details.length > 0 ? `${titlePrefix} (${details.join(', ')})` : titlePrefix

  return (
    <Dialog onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-2xl"
        onKeyDown={(event) => {
          if (!canNavigate) return
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            goTo(index + 1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            goTo(index - 1)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <img src={current.src} alt="" className="max-h-[70vh] w-full rounded-md object-contain" />
          {canNavigate && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Previous image"
                className="absolute top-1/2 left-2 -translate-y-1/2 bg-popover/80 hover:bg-popover"
                onClick={() => goTo(index - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Next image"
                className="absolute top-1/2 right-2 -translate-y-1/2 bg-popover/80 hover:bg-popover"
                onClick={() => goTo(index + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
