import * as React from 'react'
import { FileIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

/** Lets a host that is already one tab stop (the panel's tree row, which renders the shared card body) take every nested "+N" out of the tab order without threading a prop through the card. */
export const FileChipTabbableContext = React.createContext(true)

interface FileChipListProps {
  files: readonly string[] | undefined
  /** The accessible name of the group, e.g. "Files touched". */
  label: string
  limit?: number
  /** False takes the "+N" button out of the tab order, for a host that is already one tab stop and shows the whole list elsewhere; defaults to the nearest `FileChipTabbableContext`. */
  tabbable?: boolean
  className?: string
}

// Renders nothing for no files, so a caller never leaves an empty row. The "+N" control is a real button
// (keyboard and screen-reader reachable), unlike a hover-only tooltip on a chip.
export function FileChipList({ files, label, limit = FILE_CHIP_LIMIT, tabbable, className }: FileChipListProps) {
  const inheritedTabbable = React.useContext(FileChipTabbableContext)
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
        <Button
          variant="outline"
          size="xs"
          tabIndex={(tabbable ?? inheritedTabbable) ? undefined : -1}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="text-muted-foreground"
        >
          {expanded ? 'Show fewer' : `+${hidden.length}`}
          {!expanded && <span className="sr-only"> more files</span>}
        </Button>
      )}
    </div>
  )
}
