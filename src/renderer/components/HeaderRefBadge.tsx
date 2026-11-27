import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface NameParts {
  /** The visible reference, such as "#1738"; the accessible name starts with it (WCAG 2.5.3). */
  text: string
  /** Spoken state after the reference, such as "open, checks passed". */
  status?: string
  /** How many more items sit behind the badge. */
  extra?: number
  /** What activating the badge does, in lower case: "open pull request". */
  action: string
}

/** "#1738, open, and 1 more: show pull requests and issues". */
export function headerRefBadgeName({ text, status, extra = 0, action }: NameParts): string {
  return `${text}${status ? `, ${status}` : ''}${extra > 0 ? `, and ${extra} more` : ''}: ${action}`
}

/** Tooltip text: the action with the item title, then the state. */
export function headerRefBadgeTooltip({ action, itemTitle, status }: Pick<NameParts, 'action' | 'status'> & { itemTitle?: string }): string {
  const lead = `${action.charAt(0).toUpperCase()}${action.slice(1)}${itemTitle ? `: ${itemTitle}` : ''}`
  return status ? `${lead} (${status})` : lead
}

interface HeaderRefBadgeProps extends NameParts, Omit<ComponentProps<'button'>, 'aria-label' | 'children'> {
  /** State icon shown before the reference. */
  icon: ReactNode
  /** Extra decoration after the count, such as the PR checks icon; keep it `aria-hidden`, the state is in the name. */
  trailing?: ReactNode
  /** The item's own title, for the tooltip. */
  itemTitle?: string
}

/** The chat header's pull request or issue badge, which is itself the button that opens the item or its "+N" menu (#1745). */
export const HeaderRefBadge = forwardRef<HTMLButtonElement, HeaderRefBadgeProps>(function HeaderRefBadge(
  { icon, text, status, extra = 0, action, trailing, itemTitle, className, ...rest },
  ref
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* `rest` carries the trigger props a Radix `asChild` parent injects. */}
        <Button
          ref={ref}
          type="button"
          variant="outline"
          size="xs"
          className={cn('h-6 shrink-0 gap-1 px-2 font-normal', className)}
          {...rest}
          aria-label={headerRefBadgeName({ text, status, extra, action })}
        >
          {icon}
          <span>{text}</span>
          {extra > 0 && <span className="tabular-nums">+{extra}</span>}
          {trailing}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{headerRefBadgeTooltip({ action, itemTitle, status })}</TooltipContent>
    </Tooltip>
  )
})
