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
  onRemove?: () => void
  removeLabel?: string
  wrap?: boolean
  className?: string
}

// The chip's accessible name comes from its visible text; the icon is `aria-hidden`.
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
        wrap && 'flex-wrap items-start whitespace-normal rounded-md',
        className
      )}
      title={wrap ? undefined : name}
    >
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
              <XIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove {removeLabel ?? name}</TooltipContent>
        </Tooltip>
      )}
    </Badge>
  )
}
