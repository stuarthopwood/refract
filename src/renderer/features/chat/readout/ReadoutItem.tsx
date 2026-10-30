import { forwardRef } from 'react'
import type { ComponentType, FocusEvent, HTMLAttributes, MouseEvent, ReactNode, Ref } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// One source of truth for the classes either way -- this component below still uses the SAME two constants, never a second copy of the literal strings.
export const READOUT_ITEM_BASE_CLASS = 'inline-flex h-6 shrink-0 items-center gap-2 text-readout text-muted-foreground'
export const READOUT_ITEM_INTERACTIVE_ADDITIONS =
  'min-h-6 min-w-6 justify-center rounded-md px-1 -mx-1 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export interface ReadoutItemProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'onFocus' | 'onBlur' | 'onPointerEnter' | 'onPointerLeave' | 'className'> {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  children: ReactNode
  onActivate?: (event: MouseEvent<HTMLButtonElement>) => void
  href?: string
  accessibleName?: string
  pressed?: boolean
  controls?: string
  pinHookId?: string
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  className?: string
  /** Amber alert icon after the content, for a readout whose figure may be wrong; pair it with a tooltip and an accessible name that says so. */
  warning?: boolean
}

export const ReadoutItem = forwardRef<HTMLButtonElement | HTMLAnchorElement | HTMLSpanElement, ReadoutItemProps>(function ReadoutItem(
  { icon: Icon, children, onActivate, href, accessibleName, className, pressed, controls, pinHookId, onPointerEnter, onPointerLeave, onFocus, onBlur, warning, ...rest },
  ref
) {
  const baseClasses = cn(READOUT_ITEM_BASE_CLASS, className)
  const interactiveClasses = cn(baseClasses, READOUT_ITEM_INTERACTIVE_ADDITIONS)
  const warningIcon = warning ? <TriangleAlertIcon aria-hidden data-readout-warning className="size-4 text-severity-warning forced-colors:text-[CanvasText]" /> : null

  if (href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        data-slot="readout-chip"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={accessibleName}
        className={interactiveClasses}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {Icon && <Icon aria-hidden className="size-4" />}
        {children}
        {warningIcon}
      </a>
    )
  }

  if (onActivate || rest['aria-haspopup']) {
    return (
      <button
        {...rest}
        ref={ref as Ref<HTMLButtonElement>}
        data-slot="readout-chip"
        type="button"
        onClick={onActivate}
        aria-label={accessibleName}
        aria-pressed={pressed}
        aria-controls={pressed ? controls : rest['aria-controls']}
        data-todo-pin-hook={pinHookId}
        className={interactiveClasses}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {Icon && <Icon aria-hidden className="size-4" />}
        {children}
        {warningIcon}
      </button>
    )
  }

  return (
    <span ref={ref as Ref<HTMLSpanElement>} data-slot="readout-chip" className={baseClasses} aria-label={accessibleName}>
      {Icon && <Icon aria-hidden className="size-4" />}
      {children}
      {warningIcon}
    </span>
  )
})
