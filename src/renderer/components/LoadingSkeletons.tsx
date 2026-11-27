// Shared skeleton shapes for first loads (#1848, ADR 0003): rows for a list column, blocks for a
// detail pane. Both stand in for content whose shape is known, so a view never shows a dashed
// `Empty` or bare "Loading…" text while its data is in flight.
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const ROW_KEYS = [0, 1, 2, 3, 4, 5]

/** Decorative rows in a list's shape; the owning pane already announces its loading state. */
export function ListRowsSkeleton({ rows = ROW_KEYS.length, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden data-slot="list-rows-skeleton" className={cn('flex flex-col divide-y divide-divider', className)}>
      {ROW_KEYS.slice(0, rows).map((key) => (
        <div key={key} className="flex flex-col gap-2 px-3 py-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** A title, meta line and body blocks; polite status text names the load for screen readers. */
export function DetailPaneSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" data-slot="detail-pane-skeleton" className={cn('flex flex-col gap-4 p-4', className)}>
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}
