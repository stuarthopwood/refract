// One-line text that cuts off with an ellipsis and shows the whole value in the shared Tooltip, but only when it is
// actually cut off, so a short name never grows a pointless tooltip. The text stays in the DOM, so the accessible name
// is unchanged and the tooltip is a sighted-user extra. The text is not focusable, so a button that holds it passes its
// keyboard focus in (`useFocusVisibleWithin`) and the tooltip opens for a keyboard user too.
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The tooltip opens only when it was asked to and the text is wider than its box; no element means nothing to measure. */
export function shouldOpenTooltip(open: boolean, element: { scrollWidth: number; clientWidth: number } | null): boolean {
  return open && element !== null && element.scrollWidth > element.clientWidth
}

/** Whether keyboard focus is inside the element these handlers go on; a click's focus does not count. */
export function useFocusVisibleWithin() {
  const [focused, setFocused] = useState(false)
  const focusProps = {
    onFocus: (event: FocusEvent<HTMLElement>) => setFocused(event.currentTarget.matches(':focus-visible')),
    onBlur: () => setFocused(false)
  }
  return { focused, focusProps }
}

interface TruncatedTextProps {
  /** The full text the tooltip shows. Untrusted, rendered as plain text. */
  tooltip: string
  children: ReactNode
  className?: string
  /** True while the button holding this text has keyboard focus. */
  focused?: boolean
}

export function TruncatedText({ tooltip, children, className, focused = false }: TruncatedTextProps) {
  const textRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  // The element is measured when the tooltip would open: a width that changed since the render is still right.
  const handleOpenChange = (next: boolean) => setOpen(shouldOpenTooltip(next, textRef.current))
  useEffect(() => {
    setOpen(shouldOpenTooltip(focused, textRef.current))
  }, [focused])
  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <span ref={textRef} className={cn('block min-w-0 truncate', className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="break-words">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
