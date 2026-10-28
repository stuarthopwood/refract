// FR-009: the shared row above the message box for every pending image and text chip; hidden
// entirely while nothing is pending. A small image's thumbnail renders compactly here (one
// fixed thumbnail size -- Refract never renders a taller preview block in the strip itself; the
// full-size view always lives in `ImagePreviewModal`, opened by clicking the thumbnail). A
// pending text chip shows here too, as its own clickable badge (always reachable regardless of
// the textarea's own scroll position, unlike the inline overlay this same module also renders --
// see `ChipOverlaySegments` below), but has no remove control of its own: FR-014 removes a chip
// only by editing or deleting its label the same way any other draft text is edited.
import type { ReactNode, RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ImageThumbnail } from '@/components/ImageThumbnail'
import { ImagePreviewModal } from './ImagePreviewModal'
import { TextPreviewModal } from './TextPreviewModal'
import { FileAttachmentChip } from './FileAttachmentChip'
import type { ChipOccurrence, PendingFileAttachment, PendingImageAttachment, PendingTextChip } from './attachments'
import { formatByteSize } from './attachments'

export interface AttachmentStripProps {
  images: PendingImageAttachment[]
  textChips: PendingTextChip[]
  // #926: files/folders attached via the Attach button, drag-and-drop, or a clipboard file
  // paste -- rendered between the image thumbnails and the text chips.
  files: PendingFileAttachment[]
  onRemoveImage: (id: string) => void
  onRemoveFile: (id: string) => void
  // PR #723 gate round 3 fix (A11y3 HIGH): lets the caller scope a focus/query to THIS
  // composer's own strip specifically -- in split view, two ChatPanes each render their own
  // MessageInput/AttachmentStrip pair, and a `document`-wide query for `[role="group"][aria-
  // label="Pending attachments"]` always finds whichever one is FIRST in the page, regardless of
  // which pane the user is actually in.
  containerRef?: RefObject<HTMLDivElement | null>
}

export function AttachmentStrip({ images, files, textChips, onRemoveImage, onRemoveFile, containerRef }: AttachmentStripProps) {
  if (images.length === 0 && files.length === 0 && textChips.length === 0) return null
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Pending attachments"
      // Gate round 3 (UI3 Medium): `p-1` gives the scroll box's own edges room for the image
      // Remove button's `-top-1 -right-1` offset (and its own focus ring) -- without it, a chip
      // in the first row or at the strip's right edge had both clipped by this container's own
      // `overflow-y-auto` boundary.
      className="flex max-h-28 flex-wrap items-center gap-2 overflow-y-auto p-1"
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
          <button
            type="button"
            aria-label={images.length > 1 ? `Remove image ${index + 1} of ${images.length}` : 'Remove image'}
            onClick={() => onRemoveImage(image.id)}
            // Gate round 4 (UI4 Low): matches `FileAttachmentChip.tsx`'s own Remove button -- a
            // real 24px target (`size-6`, was `size-4`/16px) and the same INSET focus ring
            // (`outline-offset-[-2px]`), so it never extends further outside the strip's own
            // `p-1` buffer than the file chip's already-fixed Remove button does.
            // Gate round 5 (UI5 Low): `pointer-events-none` while invisible (`opacity-0`) --
            // the button still sits in the DOM, overlapping the corner of the 40px image
            // thumbnail, and a 24px (round 4) invisible hit area is more of this thumbnail to
            // mis-click than the 16px one was; restored once actually visible (hover/focus).
            className="pointer-events-none absolute -top-1 -right-1 flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
      {(() => {
        // Gate round 2 (A11y2 Medium): two pending files sharing the exact same name (one from
        // each of two different picked/dropped folders, say) would otherwise both announce the
        // identical "Remove a.txt" -- disambiguated with a stable "N of M" position among same-
        // named files, computed once per render rather than per chip.
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

/** research.md Decision 10: a pending text chip's label is a short literal string inserted
 * directly into the plain-text draft model; this renders the clickable, chip-styled overlay
 * exactly over each occurrence's own rendered position, reusing MessageInput.tsx's existing
 * ghost-text overlay technique (spec 001 T103, FR-058) -- an inert sibling matching the
 * textarea's own box model, with an `invisible` span of literal text reserving the space before
 * each occurrence so the visible chip lands exactly where its label renders in the real
 * textarea. Only the chip buttons themselves are `pointer-events-auto`; the container stays
 * `pointer-events-none` (set by the caller) so the real textarea beneath remains the one surface
 * that receives clicks, drags, and text selection everywhere else.
 *
 * High remediation (code-reviewer): the clickable chip itself is a `<span role="button">`, not a
 * real `<button>` -- a `<button>` is `display: inline-block` by default (Chromium), one
 * unbreakable box, so a chip label positioned near a line's wrap point would sit on a different
 * visual line than the textarea's own text wraps it to (the ghost-text overlay this is meant to
 * reuse the measurement technique from uses only plain `<span>`s, which wrap exactly like the
 * underlying text). A `<span>` is `display: inline` by default and wraps the same way; `[box-
 * decoration-break:clone]` makes the chip's background/rounding repeat cleanly on every visual
 * line fragment it wraps across, rather than being sliced across the break.
 *
 * High remediation (accessibility-auditor): `tabIndex={-1}` keeps this a mouse-only shortcut --
 * it sits inside an `aria-hidden="true"` container (the ghost-overlay pattern), so a default
 * `tabIndex` of 0 would otherwise create a Tab stop with no exposed accessible name. The strip's
 * own badge (`AttachmentStrip` above) is a real `<button>` and remains the one keyboard/
 * assistive-tech route to the same preview. `restoreFocusTo` (the textarea) is threaded into
 * `TextPreviewModal` below so the modal's own close-focus-return target is the textarea, not this
 * now-keyboard-unreachable span, when it was opened from here specifically. */
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
            className="pointer-events-auto cursor-pointer rounded-sm bg-secondary/80 text-secondary-foreground underline decoration-dotted underline-offset-2 [box-decoration-break:clone] hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
