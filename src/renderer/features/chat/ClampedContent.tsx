import * as React from 'react'
import { cn } from '@/lib/utils'
import { mutedLinkClassName } from './linkStyles'

export interface ClampedContentProps {
  /** Visual line count past which the body clamps behind a Show more button. */
  lines: number
  children: React.ReactNode
}

// `CollapsedLine`'s `clampLines` body (#1236): clips an expanded body to `lines` lines and offers a
// real Show more / Show less button only when the content actually overflows. `lh` resolves against
// this element's own line-height, so "about 8 lines" follows the body's own typography. Measured in
// a layout effect and on resize or DOM growth, so a streaming or re-flowed body updates. The toggle
// uses the shared muted link look (`mutedLinkClassName`, as "Show full brief" does) because the
// accent link colour fails 4.5:1 in three themes. Focus landing inside the clipped body (a link past
// the cut) expands it, so a focused control is never hidden.
export function ClampedContent({ lines, children }: ClampedContentProps) {
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const bodyId = React.useId()
  const [expanded, setExpanded] = React.useState(false)
  const [overflowing, setOverflowing] = React.useState(false)

  React.useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element || expanded) return
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(element)
    const mutationObserver = new MutationObserver(measure)
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [expanded])

  return (
    <>
      <div
        ref={bodyRef}
        id={bodyId}
        className={expanded ? undefined : 'overflow-hidden'}
        style={expanded ? undefined : { maxHeight: `${lines}lh` }}
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
          className={cn(mutedLinkClassName, 'min-h-6 inline-flex items-center text-xs text-muted-foreground')}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}
