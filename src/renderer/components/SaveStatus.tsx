import type { ComponentProps } from 'react'
import { CheckIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { InlineStatus } from './InlineStatus'
import { describeSaveStatus } from './saveStatusView'
import type { SaveState } from './saveStatusView'

const ICON_CLASS = 'mr-1 inline size-4 shrink-0 align-[-0.2em]'

/**
 * Saving…, Saved or the write's error as one line of text with an icon. A single `status` region stays mounted
 * (empty when idle) so a screen reader announces its text changing; an error is an `alert` rendered beside it.
 */
export function SaveStatus({ state, error, className, ...props }: Omit<ComponentProps<typeof InlineStatus>, 'tone' | 'density' | 'leading' | 'children'> & { state: SaveState; error?: string }) {
  const view = describeSaveStatus(state, error)
  const failed = view?.tone === 'error'
  const leading = view?.icon === 'spinner' ? <Spinner className={ICON_CLASS} /> : view?.icon === 'check' ? <CheckIcon aria-hidden className={ICON_CLASS} /> : undefined
  return (
    <>
      {/* `contents` keeps the idle region out of flex gaps; the text inside is tone `info` so it carries no nested live role. */}
      {/* Refract renders in WebView2's evergreen Chromium, which keeps the role of `display: contents` elements in the accessibility tree. */}
      <div role="status" data-slot="save-status" className="contents">
        {view && !failed && (
          <InlineStatus tone="info" density="compact" leading={leading} className={cn('px-0 py-0', className)} {...props}>
            {view.text}
          </InlineStatus>
        )}
      </div>
      {view && failed && (
        <InlineStatus tone="error" density="compact" className={cn('px-0 py-0', className)} {...props}>
          {view.text}
        </InlineStatus>
      )}
    </>
  )
}
