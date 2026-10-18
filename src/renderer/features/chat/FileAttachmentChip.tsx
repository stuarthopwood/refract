// #926: one shared chip for a pending (composer strip) or sent (bubble) file/folder attachment --
// `AttachmentStrip.tsx` and `UserMessageRow.tsx` both render this exact markup so a reviewer
// never finds the visible text, the accessible name, or the FR-034/FR-035 wording drifting apart
// between the two surfaces. Gate round 1 (Code1/A11y1/UI1 HIGH): the prior copies hid everything
// but the bare file name behind `aria-hidden`/a Badge-level `aria-label`, so neither surface ever
// showed the size or the "sent as path" state at all -- FR-034 ("name, byte size... and 'sent as
// path'") and FR-035 (the sent bubble shows the SAME chip) both require visible text, not a
// screen-reader-only summary with nothing rendered for a sighted developer to read.
import { FileIcon, FileTextIcon, FolderIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { formatByteSize } from './attachments'

export interface FileAttachmentChipProps {
  name: string
  byteLength: number
  isDirectory: boolean
  sentAs: 'inline' | 'path'
  /** The composer strip needs room on the right for its own absolutely-positioned Remove
   * button (`pr-5`); the sent bubble (no Remove control) does not. */
  className?: string
}

/** Gate round 1 (A11y1 HIGH): no `aria-label` on the chip and no `aria-hidden` on the name --
 * the chip's accessible name is now computed from its own visible text content (icon excluded via
 * `aria-hidden` on the icon only), the normal accessible-name-from-content rule, never a second,
 * easy-to-drift-from-the-visible-text summary string. The `sr-only` suffix adds the exact wording
 * a sighted developer already sees from the visible "· sent as path" text/icon shape, spelled out
 * for a screen reader that may not render the `·` separator as a pause. */
export function FileAttachmentChip({ name, byteLength, isDirectory, sentAs, className }: FileAttachmentChipProps) {
  const Icon = isDirectory ? FolderIcon : sentAs === 'inline' ? FileTextIcon : FileIcon
  const isPath = isDirectory || sentAs === 'path'
  const srSuffix = isDirectory ? ' folder' : isPath ? ', sent as path' : ', attached as text'
  return (
    <Badge variant="secondary" className={cn('max-w-full gap-1.5 py-1 text-secondary-foreground', className)} title={name}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
      {!isDirectory && <span className="shrink-0 text-xs text-secondary-foreground/80">{formatByteSize(byteLength)}</span>}
      {isPath && <span className="shrink-0 text-xs text-secondary-foreground/80">&middot; sent as path</span>}
      <span className="sr-only">{srSuffix}</span>
    </Badge>
  )
}
