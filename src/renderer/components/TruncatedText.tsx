// One-line text that cuts off with an ellipsis and shows the whole value in the shared Tooltip, but only when it is
// actually cut off, so a short name never grows a pointless tooltip. The text stays in the DOM, so the accessible name
// is unchanged and the tooltip is a sighted-user extra.
import { useRef, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface TruncatedTextProps {
  /** The full text the tooltip shows. Untrusted, rendered as plain text. */
  tooltip: string
  children: ReactNode
  className?: string
}

export function TruncatedText({ tooltip, children, className }: TruncatedTextProps) {
  const textRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  // The element is measured when the tooltip would open: a width that changed since the render is still right.
  const handleOpenChange = (next: boolean) => {
    const el = textRef.current
    setOpen(next && el !== null && el.scrollWidth > el.clientWidth)
  }
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
