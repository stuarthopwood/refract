import type { ReactNode } from 'react'
import { splitDocumentPath } from './document-path'

interface DocumentHeaderProps {
  /** Relative POSIX path: the name shows prominently, the folder muted, and the whole path is the tooltip. */
  path: string
  /** Quiet text beside the path, such as a diff's group. */
  meta?: ReactNode
  /** Buttons and toggles at the row's end. */
  actions?: ReactNode
}

/** The one fixed header row of a document tab (file or diff), outside the view's scroller. */
export function DocumentHeader({ path, meta, actions }: DocumentHeaderProps) {
  const { name, directory } = splitDocumentPath(path)
  return (
    <div className="no-drag-region flex shrink-0 flex-nowrap items-center gap-1 px-2 pt-2">
      <span title={path} className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate text-foreground">{name}</span>
        {directory && <span className="min-w-0 shrink-[100] truncate text-muted-foreground">{directory}</span>}
      </span>
      {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
      {actions}
    </div>
  )
}
