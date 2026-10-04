// FR-009: the shared row above the message box for every pending image and text chip; hidden
// entirely while nothing is pending. A small image's thumbnail renders compactly here (one
// fixed thumbnail size -- Refract never renders a taller preview block in the strip itself; the
// full-size view always lives in `ImagePreviewModal`, opened by clicking the thumbnail). A
// pending text chip shows here too, as its own clickable badge (always reachable regardless of
// the textarea's own scroll position, unlike the inline overlay this same module also renders --
// see `ChipOverlaySegments` below), but has no remove control of its own: FR-014 removes a chip
// only by editing or deleting its label the same way any other draft text is edited.
import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ImagePreviewModal } from './ImagePreviewModal'
import { TextPreviewModal } from './TextPreviewModal'
import type { ChipOccurrence, PendingImageAttachment, PendingTextChip } from './attachments'
import { formatByteSize } from './attachments'

export interface AttachmentStripProps {
  images: PendingImageAttachment[]
  textChips: PendingTextChip[]
  onRemoveImage: (id: string) => void
}

export function AttachmentStrip({ images, textChips, onRemoveImage }: AttachmentStripProps) {
  if (images.length === 0 && textChips.length === 0) return null
  return (
    <div role="group" aria-label="Pending attachments" className="flex flex-wrap items-center gap-1.5">
      {images.map((image) => (
        <div key={image.id} className="group relative">
          <ImagePreviewModal
            attachment={image}
            trigger={
              <button
                type="button"
                aria-label={`View pasted image, ${formatByteSize(image.byteLength)}`}
                className="block size-10 overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <img src={image.previewUrl} alt="" className="size-full object-cover" />
              </button>
            }
          />
          <button
            type="button"
            aria-label="Remove pasted image"
            onClick={() => onRemoveImage(image.id)}
            className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <XIcon className="size-2.5" />
          </button>
        </div>
      ))}
      {textChips.map((chip) => (
        <TextPreviewModal
          key={chip.id}
          chip={chip}
          trigger={
            <Badge asChild variant="secondary" className="max-w-56 cursor-pointer gap-1 py-1">
              <button type="button" className="truncate" title={chip.text}>
                {chip.label}
              </button>
            </Badge>
          }
        />
      ))}
    </div>
  )
}

/** research.md Decision 10: a pending text chip's label is a short literal string inserted
 * directly into the plain-text draft model; this renders the clickable, chip-styled overlay
 * exactly over each occurrence's own rendered position, reusing MessageInput.tsx's existing
 * ghost-text overlay technique (spec 001 T103, FR-058) -- an inert sibling matching the
 * textarea's own box model, with an `invisible` span of literal text reserving the space before
 * each occurrence so the visible chip lands exactly where its label renders in the real
 * textarea. Only the chip buttons themselves are `pointer-events-auto`; the container stays
 * `pointer-events-none` (set by the caller) so the real textarea beneath remains the one surface
 * that receives clicks, drags, and text selection everywhere else. */
export function ChipOverlaySegments({
  text,
  occurrences
}: {
  text: string
  occurrences: ChipOccurrence[]
}): ReactNode {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const occurrence of occurrences) {
    if (occurrence.start > cursor) {
      nodes.push(
        <span key={`gap-${cursor}`} className="invisible">
          {text.slice(cursor, occurrence.start)}
        </span>
      )
    }
    nodes.push(
      <TextPreviewModal
        key={occurrence.chip.id}
        chip={occurrence.chip}
        trigger={
          <button
            type="button"
            className="pointer-events-auto rounded-sm bg-secondary/80 align-baseline text-secondary-foreground underline decoration-dotted underline-offset-2 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {occurrence.chip.label}
          </button>
        }
      />
    )
    cursor = occurrence.end
  }
  if (cursor < text.length) {
    nodes.push(
      <span key={`gap-${cursor}`} className="invisible">
        {text.slice(cursor)}
      </span>
    )
  }
  return nodes
}
