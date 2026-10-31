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

// Display key to its aria-keyshortcuts name.
const KEY_SHORTCUT_NAMES: Record<string, string> = { Ctrl: 'Control', Esc: 'Escape', Cmd: 'Meta', Del: 'Delete' }

/** The one icon-only button: ghost, 24px, with the Tooltip every icon-only control requires (#579). */
export function IconButton({ label, shortcut, side, variant = 'ghost', size = 'icon-sm', type, asChild, children, ...props }: IconButtonProps) {
  const keyShortcuts = shortcut?.map((key) => KEY_SHORTCUT_NAMES[key] ?? key).join('+')
  // A forwarded type="button" is invalid on the <a> an asChild child renders.
  const buttonType = asChild ? type : (type ?? 'button')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={buttonType} asChild={asChild} variant={variant} size={size} aria-keyshortcuts={keyShortcuts} {...props} aria-label={label}>
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
