import * as React from 'react'
import { OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PaneBannerProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  severity?: 'error' | 'warning'
  title: React.ReactNode
  /** Id on the title node, for a wrapper's `aria-labelledby`. */
  titleId?: string
  detail?: React.ReactNode
  detailMono?: boolean
}

function PaneBanner({
  severity = 'error',
  title,
  titleId,
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
      <div id={titleId} className="font-medium text-foreground">{title}</div>
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
