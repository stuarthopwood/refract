// #926: one shared chip for a pending (composer strip) or sent (bubble) file/folder attachment --
// `AttachmentStrip.tsx` and `UserMessageRow.tsx` both render this exact markup so a reviewer
// never finds the visible text, the accessible name, or the FR-034/FR-035 wording drifting apart
// between the two surfaces. Gate round 1 (Code1/A11y1/UI1 HIGH): the prior copies hid everything
// but the bare file name behind `aria-hidden`/a Badge-level `aria-label`, so neither surface ever
// showed the size or the "sent as path" state at all -- FR-034 ("name, byte size... and 'sent as
// path'") and FR-035 (the sent bubble shows the SAME chip) both require visible text, not a
// screen-reader-only summary with nothing rendered for a sighted developer to read. Gate round 2
// (UI2/A11y2/Code2 HIGH): the optional Remove control now renders INSIDE this same Badge (normal
// flow, never absolutely positioned outside it); the chip's own wrapper caps its width with
// `min-w-0 max-w-full` (a flex child that actually shrinks/truncates inside a wrapping row),
// never a fixed `max-w-56` that let a long name push the strip wider than its own container.
// Gate round 3 (Code3/A11y3/UI3 HIGH): `Badge`'s own base style (`h-5 overflow-hidden`) clipped
// the Remove button's own focus ring whenever it was NOT in `wrap` mode (the composer strip's
// pending chip) -- now `h-auto overflow-visible` always, matching `MessageInput.tsx`'s own
// queued-chip Badge. The button is now a REAL 24px target (`size-6`, pulled back in flow with a
// negative margin so it never inflates the chip's own visual height) -- the doc comment used to
// claim 24px while the button was actually `size-4` (16px). Its own focus ring is now INSET
// (`outline-offset-[-2px]`), so it stays fully inside the button's own box even with the Badge's
// overflow now visible, never bleeding into a neighbouring chip when the strip wraps several
// close together.
import { FileIcon, FileTextIcon, FolderIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatByteSize } from './attachments'

export interface FileAttachmentChipProps {
  name: string
  byteLength: number
  isDirectory: boolean
  sentAs: 'inline' | 'path'
  /** Present only in the composer strip (a pending attachment); absent in the sent bubble, which
   * has no remove control at all. */
  onRemove?: () => void
  /** Gate round 2 (A11y2 Medium): overrides the bare `Remove <name>` wording with a
   * disambiguated one (`"Remove a.txt, 2 of 3"`) when the strip holds more than one pending
   * attachment sharing this exact name -- computed by `AttachmentStrip.tsx`, which is the only
   * place that sees every pending file at once. */
  removeLabel?: string
  /** Gate round 2 (A11y2/UI2 Medium): the sent bubble passes this -- a truncated name's full
   * text is only ever revealed by a mouse hover (`title`), which a keyboard-only user can never
   * trigger; the bubble's own chip wraps the full name across lines instead of truncating it at
   * all. The composer strip (with Remove, one visual row) keeps the single-line truncate. */
  wrap?: boolean
  className?: string
}

/** Gate round 1 (A11y1 HIGH): no `aria-label` on the chip and no `aria-hidden` on the name --
 * the chip's accessible name is computed from its own visible text content (icon excluded via
 * `aria-hidden`). Gate round 2 (A11y2 Medium): the visible "· sent as path" text is never
 * DUPLICATED by an `sr-only` suffix saying the same thing again -- the `·` glyph itself is the
 * only part hidden from the accessible name (`aria-hidden`, a screen reader may not render it as
 * a pause); a FOLDER shows no visible kind text at all (the icon alone), so its `sr-only` suffix
 * carries the full ", folder, sent as path" a sighted developer already reads from the icon
 * shape; an INLINE file's `sr-only` ", attached as text" is likewise the one case with nothing
 * else visible to say it. */
export function FileAttachmentChip({ name, byteLength, isDirectory, sentAs, onRemove, removeLabel, wrap, className }: FileAttachmentChipProps) {
  const Icon = isDirectory ? FolderIcon : sentAs === 'inline' ? FileTextIcon : FileIcon
  const isPathFile = !isDirectory && sentAs === 'path'
  const srSuffix = isDirectory ? ', folder, sent as path' : sentAs === 'inline' ? ', attached as text' : null
  return (
    <Badge
      variant="secondary"
      className={cn(
        'h-auto max-w-full gap-2 overflow-visible py-1 text-secondary-foreground',
        onRemove && 'pr-1',
        // Gate round 3 (UI3 Low): `flex-wrap` lets the chip's own children (icon, name, size,
        // "sent as path") drop onto a new line as a group once the name itself wraps, instead
        // of a lone overflowing row; `rounded-md` replaces the Badge's own pill shape
        // (`rounded-4xl`), which reads oddly on a chip now spanning several lines.
        wrap && 'flex-wrap items-start whitespace-normal rounded-md',
        className
      )}
      title={wrap ? undefined : name}
    >
      {/* Gate round 2 (UI2 Low): no explicit size class here -- `Badge`'s own base style forces
          `[&>svg]:size-3!` on any direct svg child regardless, so an explicit `size-3.5` was
          dead, misleading code that never actually rendered. */}
      <Icon aria-hidden className={cn('shrink-0', wrap && 'mt-1')} />
      <span className={cn('min-w-0', wrap ? 'break-words' : 'truncate')}>{name}</span>
      {!isDirectory && <span className="shrink-0 text-xs text-secondary-foreground/80">{formatByteSize(byteLength)}</span>}
      {isPathFile && (
        <span className="shrink-0 text-xs text-secondary-foreground/80">
          <span aria-hidden>&middot;</span> sent as path
        </span>
      )}
      {srSuffix && <span className="sr-only">{srSuffix}</span>}
      {onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Remove ${removeLabel ?? name}`}
              aria-describedby={undefined}
              onClick={onRemove}
              className="relative -my-1 flex size-6 shrink-0 items-center justify-center rounded-full text-secondary-foreground/70 hover:bg-secondary-foreground/15 hover:text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            >
              <XIcon className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove {removeLabel ?? name}</TooltipContent>
        </Tooltip>
      )}
    </Badge>
  )
}
