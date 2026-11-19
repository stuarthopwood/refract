import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type RailIconButtonProps = Omit<React.ComponentProps<typeof Button>, 'aria-label' | 'variant' | 'size'> & {
  /** Names the control (aria-label) and is the tooltip text unless `tooltip` replaces it. */
  label: string
  /** Richer tooltip content (for example a shortcut Kbd); the accessible name stays `label`. */
  tooltip?: React.ReactNode
}

// A pressed rail button takes the muted fill and accent glyph; forced-colors swaps the fill for a border.
const RAIL_BUTTON_CLASS =
  'text-muted-foreground aria-pressed:bg-muted aria-pressed:text-accent-text forced-colors:aria-pressed:border-2 forced-colors:aria-pressed:border-[Highlight]'

/** The one 40 px icon-rail button: ghost, left-side tooltip. The Right pane toggle and every panel button use it. */
export function RailIconButton({ label, tooltip, className, type = 'button', children, ...props }: RailIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={type} variant="ghost" size="icon-xl" aria-label={label} className={cn(RAIL_BUTTON_CLASS, className)} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}
