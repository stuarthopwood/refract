// The profile menu's update row content (#137): label, detail and glyph all come from `updateMenuEntry`. Kept apart from the menu item so it renders without a Radix menu or the app stores.
import { DownloadIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { UpdateMenuEntry, UpdateMenuIcon } from '@/lib/updateStatus'

const ICONS: Record<UpdateMenuIcon, ComponentType<LucideProps>> = {
  download: DownloadIcon,
  warning: TriangleAlertIcon,
  refresh: RefreshCwIcon,
  busy: Spinner
}

export function UpdateMenuEntryRow({ entry }: { entry: UpdateMenuEntry }) {
  const Icon = ICONS[entry.icon]
  return (
    <>
      <Icon aria-hidden />
      {entry.detail ? (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span>{entry.label}</span>
          {/* A failure message can be long; the line is cut to the menu width and the full text stays in the tooltip. */}
          <span className="truncate text-xs text-muted-foreground" title={entry.detail}>
            {entry.detail}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1">{entry.label}</span>
      )}
      {entry.version && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <span aria-hidden> </span>
          <span className="sr-only"> version </span>
          {entry.version}
        </span>
      )}
    </>
  )
}
