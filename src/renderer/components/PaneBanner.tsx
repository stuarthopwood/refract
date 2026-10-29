import * as React from 'react'
import { OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// #746: the shared unboxed row for a Session- or pane-scoped problem (docs/design/components.md,
// "Banners"). Severity icon in the severity colour (error = destructive, warning = warning token), title in normal foreground, an optional muted
// detail line, then actions as `children`: one `outline` primary first, the rest `text` buttons,
// a destructive one last as `text-destructive`. `role="alert"` fires at appearance only; keep any
// expanding disclosure OUTSIDE this element so toggling it never re-announces the banner.
interface PaneBannerProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** `error` is the octagon, `warning` the triangle (the severity set in components.md). */
  severity?: 'error' | 'warning'
  title: React.ReactNode
  /** Second line, muted and selectable. */
  detail?: React.ReactNode
  /** Monospace by default (paths, ids, commands); pass false for a prose sentence. */
  detailMono?: boolean
}

function PaneBanner({
  severity = 'error',
  title,
  detail,
  detailMono = true,
  role = 'alert',
  className,
  children,
  ...props
}: PaneBannerProps) {
  const Icon = severity === 'warning' ? TriangleAlertIcon : OctagonAlertIcon
  return (
    <div
      data-slot="pane-banner"
      role={role}
      className={cn('grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-left text-sm', className)}
      {...props}
    >
      <span className="flex h-5 items-center">
        <Icon aria-hidden className={cn('size-4', severity === 'warning' ? 'text-severity-warning' : 'text-destructive')} />
      </span>
      <div className="font-medium text-foreground">{title}</div>
      {detail != null && detail !== '' && (
        <div
          data-slot="pane-banner-detail"
          className={cn(
            'col-start-2 text-xs text-muted-foreground [overflow-wrap:anywhere] select-text',
            detailMono && 'font-code'
          )}
        >
          {detail}
        </div>
      )}
      {children && <div className="col-start-2 mt-1 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

export { PaneBanner }
