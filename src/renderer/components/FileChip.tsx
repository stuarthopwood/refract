import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Last segment of a path in either separator style: agents report Windows and POSIX paths alike. */
export function fileBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? path
}

/** A compact borderless monospace chip of a file's basename; the full path stays in `title` so nothing is lost to the truncation. */
const FILE_CHIP_CLASS = 'h-auto min-w-0 max-w-full rounded-sm bg-command-pill-bg px-2 py-0 font-code text-micro text-command-pill-fg'

export function FileChip({ path, className }: { path: string; className?: string }) {
  return (
    <Badge variant="secondary" title={path} className={cn(FILE_CHIP_CLASS, className)}>
      <span className="truncate">{fileBasename(path)}</span>
    </Badge>
  )
}

export const FILE_CHIP_LIMIT = 4

// A bare number is a fragment of a path or a count the source split off, never a file.
const NUMERIC_FRAGMENT_RE = /^\d+$/

/** The files worth a chip: bare numeric fragments dropped, and one entry per basename (the first path wins) so `a/x.ts` and `b/x.ts` do not read as a repeat. */
export function distinctFileChips(files: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const path of files) {
    const name = fileBasename(path)
    if (NUMERIC_FRAGMENT_RE.test(name) || seen.has(name)) continue
    seen.add(name)
    kept.push(path)
  }
  return kept
}

/** Duplicates and numeric fragments collapse away; collapsed shows the first `limit`, the rest wait behind the "+N" button. */
export function splitFileChips(files: readonly string[], limit: number = FILE_CHIP_LIMIT): { shown: string[]; hidden: string[] } {
  const unique = distinctFileChips(files)
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
  /** False renders the overflow as plain "+N" text instead of a button, and the whole list as a role-less inline `span` instead of a labelled `div` group, for a host that is itself one control (a button may hold only phrasing content and no interactive child). */
  interactive?: boolean
}

// Renders nothing for no files, so a caller never leaves an empty row. The "+N" control is a real button
// (keyboard and screen-reader reachable), unlike a hover-only tooltip on a chip.
export function FileChipList({ files, label, limit = FILE_CHIP_LIMIT, tabbable, interactive = true, className }: FileChipListProps) {
  const inheritedTabbable = React.useContext(FileChipTabbableContext)
  const [expanded, setExpanded] = React.useState(false)
  const { shown, hidden } = splitFileChips(files ?? [], limit)
  if (shown.length === 0) return null
  const Wrapper = interactive ? 'div' : 'span'
  return (
    <Wrapper {...(interactive && { role: 'group', 'aria-label': label })} className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {shown.map((path) => (
        <FileChip key={path} path={path} />
      ))}
      {expanded && hidden.map((path) => <FileChip key={path} path={path} />)}
      {hidden.length > 0 &&
        (interactive ? (
          <Button
            variant="ghost"
            size="xs"
            tabIndex={(tabbable ?? inheritedTabbable) ? undefined : -1}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="text-muted-foreground"
          >
            {expanded ? 'Show fewer' : `+${hidden.length}`}
            {!expanded && <span className="sr-only"> more files</span>}
          </Button>
        ) : (
          <Badge variant="secondary" title={hidden.map(fileBasename).join(', ')} className={FILE_CHIP_CLASS}>
            +{hidden.length}
            <span className="sr-only"> more files</span>
          </Badge>
        ))}
    </Wrapper>
  )
}
