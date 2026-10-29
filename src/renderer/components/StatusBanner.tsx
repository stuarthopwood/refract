// The `status` feedback channel (docs/design/patterns.md, issue #865): a non-modal, zero-box list
// of things still running for one Session, one line per item, mounted above the composer. Each
// line carries an icon plus a word (never colour alone), plain text, optional muted meta (for
// example elapsed time) and an optional action. `aria-live="off"`: callers announce settles
// themselves, once, so a screen reader is never interrupted by every tick.
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { FadeCollapse } from '@/components/FadeCollapse'

export interface StatusBannerItem {
  id: string
  /** Icon plus status word, for example `SubagentStatusIcon`. */
  status: ReactNode
  text: string
  meta?: ReactNode
  action?: { label: string; ariaLabel?: string; onClick: (opener: HTMLElement) => void }
}

export function StatusBanner({ label, items, testId }: { label: string; items: StatusBannerItem[]; testId?: string }) {
  return (
    <FadeCollapse show={items.length > 0}>
      <ul data-slot="status-banner" data-testid={testId} aria-label={label} aria-live="off" className="flex shrink-0 flex-col px-4 text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-6 min-w-0 items-center gap-2">
            <span className="flex shrink-0 items-center gap-2 text-muted-foreground">{item.status}</span>
            <span className="min-w-0 flex-1 truncate" title={item.text}>
              {item.text}
            </span>
            {item.meta != null && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{item.meta}</span>}
            {item.action && (
              <Button
                variant="ghost"
                size="xs"
                aria-label={item.action.ariaLabel}
                onClick={(e) => item.action?.onClick(e.currentTarget)}
              >
                {item.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </FadeCollapse>
  )
}
