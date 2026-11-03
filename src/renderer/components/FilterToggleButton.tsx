import type { ComponentProps } from 'react'
import { FunnelIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface FilterToggleButtonProps
  extends Omit<ComponentProps<typeof Button>, 'variant' | 'children' | 'aria-label' | 'aria-expanded' | 'aria-controls' | 'onClick'> {
  /** Accessible name and tooltip; the caller says when a filter is applied, since the dot is hidden from assistive tech. */
  label: string
  open: boolean
  /** Whether a filter is applied while the panel is closed, shown as a dot on the funnel. */
  active: boolean
  /** Id of the filter panel; `aria-controls` points at it only while it is open. */
  panelId: string
  onToggle(): void
  tooltipSide?: ComponentProps<typeof TooltipContent>['side']
}

/** The funnel button that opens and closes a list's filter panel, with a dot while a filter is applied. */
export function FilterToggleButton({ label, open, active, panelId, onToggle, tooltipSide, className, size = 'icon-sm', ...props }: FilterToggleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button
          {...props}
          type="button"
          variant="ghost"
          size={size}
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
          className={cn('relative aria-expanded:bg-muted aria-expanded:text-foreground', COMPOSER_BUTTON_FOCUS_CLASS, className)}
        >
          <FunnelIcon aria-hidden className="size-4" />
          {active && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  )
}
