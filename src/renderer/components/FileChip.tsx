import * as React from 'react'
import { FileIcon } from 'lucide-react'
import { Badge, badgeVariants } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Last segment of a path in either separator style: agents report Windows and POSIX paths alike. */
export function fileBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? path
}

/** A compact monospace chip of a file's basename; the full path stays in `title` so nothing is lost to the truncation. */
export function FileChip({ path, className }: { path: string; className?: string }) {
  return (
    <Badge variant="outline" title={path} className={cn('min-w-0 max-w-full bg-surface-2 font-mono', className)}>
      <FileIcon aria-hidden />
      <span className="truncate">{fileBasename(path)}</span>
    </Badge>
  )
}

export const FILE_CHIP_LIMIT = 4

/** Duplicates collapse to one chip; collapsed shows the first `limit`, the rest wait behind the "+N" button. */
export function splitFileChips(files: readonly string[], limit: number = FILE_CHIP_LIMIT): { shown: string[]; hidden: string[] } {
  const unique = [...new Set(files)]
  return { shown: unique.slice(0, limit), hidden: unique.slice(limit) }
}

interface FileChipListProps {
  files: readonly string[] | undefined
  /** The accessible name of the group, e.g. "Files touched". */
  label: string
  limit?: number
  className?: string
}

// Renders nothing for no files, so a caller never leaves an empty row. The "+N" control is a real button
// (keyboard and screen-reader reachable), unlike a hover-only tooltip on a chip.
export function FileChipList({ files, label, limit = FILE_CHIP_LIMIT, className }: FileChipListProps) {
  const [expanded, setExpanded] = React.useState(false)
  const { shown, hidden } = splitFileChips(files ?? [], limit)
  if (shown.length === 0) return null
  return (
    <div role="group" aria-label={label} className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {shown.map((path) => (
        <FileChip key={path} path={path} />
      ))}
      {expanded && hidden.map((path) => <FileChip key={path} path={path} />)}
      {hidden.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className={cn(badgeVariants({ variant: 'outline' }), 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground')}
        >
          {expanded ? 'Show fewer' : `+${hidden.length}`}
          {!expanded && <span className="sr-only"> more files</span>}
        </button>
      )}
    </div>
  )
}
