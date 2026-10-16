// Shared ghost icon-only refresh button for the pull request list and detail views (#568
// decision 8: both call sites settle on the detail view's existing `size-4` icon, not the list's
// old smaller icon).
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS, COMPOSER_DISABLED_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'

export interface RefreshButtonProps {
  loading: boolean
  onClick: () => void
  label: string
  className?: string
}

export function RefreshButton({ loading, onClick, label, className }: RefreshButtonProps) {
  return (
    <Tooltip>
      {/* Gate round 1 fix (A11y Medium): Radix points the open tooltip's own `aria-describedby`
          at the trigger; since the tooltip text is identical to `aria-label`, that doubled the
          announcement ("Refresh pull requests" read twice). Matches the repo's existing fix at
          `PanelTabBar.tsx`/`SubagentChainRow.tsx`/`Markdown.tsx`. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          // Gate round 1 fix (A11y Medium): a native `disabled` button drops out of the Tab
          // order the instant it disables itself, so pressing Enter/Space on this exact control
          // strands keyboard focus on `<body>` mid-interaction -- the repo's own composer-picker
          // pattern (`aria-disabled` plus an `onClick` guard) keeps the button focusable while
          // still refusing the click.
          aria-disabled={loading}
          onClick={() => {
            if (loading) return
            onClick()
          }}
          className={cn(COMPOSER_DISABLED_CLASS, COMPOSER_BUTTON_FOCUS_CLASS, className)}
        >
          <RefreshCwIcon aria-hidden className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
