import { forwardRef, type ComponentProps, type ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface HeaderActionButtonProps extends Omit<ComponentProps<'button'>, 'aria-label'> {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  /** Visible word that drops out at the narrow chat breakpoint, leaving an icon button. */
  text: string
  /** Accessible name and tooltip. */
  label: string
}

/** Compact ghost button for the chat header; the text hides below the `chat-narrow` container width. */
export const HeaderActionButton = forwardRef<HTMLButtonElement, HeaderActionButtonProps>(function HeaderActionButton(
  { icon: Icon, text, label, className, ...rest },
  ref
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* `rest` carries the trigger props a Radix `asChild` parent injects. */}
        <Button ref={ref} type="button" variant="ghost" size="sm" className={cn('h-6 gap-1 px-2 text-xs', className)} {...rest} aria-label={label}>
          <Icon aria-hidden className="size-4" />
          <span className="@max-chat-narrow/chat:hidden">{text}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})
