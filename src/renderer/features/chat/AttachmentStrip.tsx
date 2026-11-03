import type { ReactNode, RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ImageThumbnail } from '@/components/ImageThumbnail'
import { ImagePreviewModal } from './ImagePreviewModal'
import { TextPreviewModal } from './TextPreviewModal'
import { FileAttachmentChip } from './FileAttachmentChip'
import type { ChipOccurrence, PendingFileAttachment, PendingImageAttachment, PendingTextChip } from './attachments'
import { formatByteSize } from './attachments'
import { IconButton } from '@/components/IconButton'

export interface AttachmentStripProps {
  images: PendingImageAttachment[]
  textChips: PendingTextChip[]
  files: PendingFileAttachment[]
  onRemoveImage: (id: string) => void
  onRemoveFile: (id: string) => void
  // Scopes focus queries to this composer's strip; in split view a document-wide query finds the first pane's.
  containerRef?: RefObject<HTMLDivElement | null>
}

/** Row above the message box showing pending images, files and text chips; hidden when empty. */
export function AttachmentStrip({ images, files, textChips, onRemoveImage, onRemoveFile, containerRef }: AttachmentStripProps) {
  if (images.length === 0 && files.length === 0 && textChips.length === 0) return null
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Pending attachments"
      // `p-4` leaves room for the Remove button's -top-2/-right-2 offset and focus ring, which overflow-y-auto clips.
      // `gap-4` keeps the button off the next chip; `max-h-32` fits two thumbnail rows before scrolling.
      className="flex max-h-32 scroll-py-4 flex-wrap items-center gap-4 overflow-y-auto p-4"
    >
      {images.map((image, index) => (
        <div key={image.id} className="group relative">
          <ImagePreviewModal
            attachment={image}
            trigger={
              <ImageThumbnail
                state="ready"
                src={image.previewUrl}
                label={
                  images.length > 1
                    ? `View image ${index + 1} of ${images.length}, ${formatByteSize(image.byteLength)}`
                    : `View image, ${formatByteSize(image.byteLength)}`
                }
                className="size-10"
              />
            }
          />
          <IconButton
            label={images.length > 1 ? `Remove image ${index + 1} of ${images.length}` : 'Remove image'}
            variant="ghost"
            onClick={() => onRemoveImage(image.id)}
            // pointer-events-none while invisible so the 24px hit area can't be mis-clicked over the thumbnail.
            className="pointer-events-none absolute -top-2 -right-2 rounded-full bg-surface-1 text-muted-foreground opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-surface-1 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <XIcon aria-hidden />
          </IconButton>
        </div>
      ))}
      {(() => {
        // Same-named files get an "N of M" position so their Remove labels differ.
        const nameCounts = new Map<string, number>()
        for (const file of files) nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1)
        const seenSoFar = new Map<string, number>()
        return files.map((file) => {
          const total = nameCounts.get(file.name) ?? 1
          const position = (seenSoFar.get(file.name) ?? 0) + 1
          seenSoFar.set(file.name, position)
          const removeLabel = total > 1 ? `${file.name}, ${position} of ${total}` : undefined
          return (
            <FileAttachmentChip
              key={file.id}
              name={file.name}
              byteLength={file.byteLength}
              isDirectory={file.isDirectory}
              sentAs={file.sentAs}
              onRemove={() => onRemoveFile(file.id)}
              removeLabel={removeLabel}
              className="min-w-0 max-w-full"
            />
          )
        })
      })()}
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

/** Clickable chip overlay drawn over each text-chip label in the textarea (same technique as the ghost-text overlay). The chip is an inline `<span role="button">`, not a `<button>`, so it wraps like the textarea text; `tabIndex={-1}` because it sits in an `aria-hidden` container (the strip badge is the keyboard route). */
export function ChipOverlaySegments({
  text,
  occurrences,
  textareaRef
}: {
  text: string
  occurrences: ChipOccurrence[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
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
        restoreFocusTo={textareaRef}
        trigger={
          <span
            role="button"
            tabIndex={-1}
            className="pointer-events-auto cursor-pointer rounded-sm bg-secondary/80 text-secondary-foreground shadow-[-2px_0_0_2px_var(--secondary),2px_0_0_2px_var(--secondary)] underline decoration-dotted underline-offset-2 [box-decoration-break:clone] hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {occurrence.chip.label}
          </span>
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
