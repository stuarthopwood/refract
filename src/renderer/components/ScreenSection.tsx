// Shared screen section (#869, docs/design/components.md "Reusable components first"): a heading
// with a muted count, trailing actions, an optional muted note (for example "Updated 2 minutes
// ago") and a one-line error, above its content. Home's five sections use it; any later
// dashboard-style screen should too. Content priority: loading, then error, then empty, then the list.
import { useId, type ReactNode, type Ref } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { cn } from '@/lib/utils'

export interface ScreenSectionProps {
  title: string
  /** Shown beside the heading and folded into the section's accessible name; hidden while `loading`. */
  count?: number
  /** Right-aligned controls (tabs, a "Show all" button, a Refresh button). */
  actions?: ReactNode
  /** Muted text under the heading, for example the fetched time. */
  note?: ReactNode
  /** One line, shown with a warning icon. Replaces the empty line, never the list itself. */
  error?: string | null
  /** First fetch in flight: a loading line replaces the content, and no count is shown. */
  loading?: boolean
  /** Text for an empty list; pass it only when there is nothing to list. Never shown with `loading` or `error`. */
  empty?: string | null
  children?: ReactNode
  className?: string
  /** Lets the caller move focus to the heading, for example after the focused row disappears. */
  headingRef?: Ref<HTMLHeadingElement>
}

export function ScreenSection({ title, count, actions, note, error, loading = false, empty, children, className, headingRef }: ScreenSectionProps) {
  const headingId = useId()
  const showCount = count !== undefined && !loading
  const emptyLine = (text: string) => (
    <Empty className="border p-4">
      <EmptyDescription>{text}</EmptyDescription>
    </Empty>
  )
  return (
    <section aria-labelledby={headingId} className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-h-8 items-center gap-2">
        <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-sm font-semibold outline-none">
          {title}
          {showCount && <span className="sr-only">, {count}</span>}
        </h2>
        {showCount && (
          <span aria-hidden className="text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {!loading && error && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {loading ? emptyLine('Loading…') : empty && !error ? emptyLine(empty) : children}
    </section>
  )
}
