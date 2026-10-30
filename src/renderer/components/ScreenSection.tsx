// Shared screen section (#869, docs/design/components.md "Reusable components first"): a heading
// with a muted count, trailing actions, an optional muted note (for example "Updated 2 minutes
// ago") and a one-line error, above its content. Home's five sections use it; any later
// dashboard-style screen should too.
import type { ReactNode } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ScreenSectionProps {
  title: string
  /** Shown beside the heading and folded into the section's accessible name. */
  count?: number
  /** Right-aligned controls (tabs, a "Show all" button, a Refresh button). */
  actions?: ReactNode
  /** Muted text under the heading, for example the fetched time. */
  note?: ReactNode
  /** One line, shown with a warning icon; never replaces the content with a blank. */
  error?: string | null
  children?: ReactNode
  className?: string
}

export function ScreenSection({ title, count, actions, note, error, children, className }: ScreenSectionProps) {
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={headingId} className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-h-8 items-center gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {title}
          {count !== undefined && <span className="sr-only">, {count}</span>}
        </h2>
        {count !== undefined && (
          <span aria-hidden className="text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {children}
    </section>
  )
}
