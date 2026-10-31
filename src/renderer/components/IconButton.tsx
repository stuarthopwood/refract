import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, 'aria-label' | 'children'> & {
  /** Names the control: the aria-label and the tooltip text are always the same string. */
  label: string
  /** Keys of the shortcut, shown as Kbd in the tooltip (for example `['Ctrl', 'F']`). */
  shortcut?: string[]
  side?: React.ComponentProps<typeof TooltipContent>['side']
  children: React.ReactNode
}

/** The one icon-only button: ghost, 24px, with the Tooltip every icon-only control requires (#579). */
export function IconButton({ label, shortcut, side, variant = 'ghost', size = 'icon-sm', type = 'button', children, ...props }: IconButtonProps) {
  const keyShortcuts = shortcut?.map((key) => (key === 'Ctrl' ? 'Control' : key === 'Esc' ? 'Escape' : key)).join('+')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={type} variant={variant} size={size} aria-keyshortcuts={keyShortcuts} {...props} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut && (
          <KbdGroup>
            {shortcut.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
