import * as React from 'react'
import { Button } from '@/components/ui/button'

export interface ClampedContentProps {
  /** Visual line count past which the body clamps behind a Show more button. */
  lines: number
  children: React.ReactNode
}

// `CollapsedLine`'s `clampLines` body (#1236): clips an expanded body to `lines` lines and offers a
// real Show more / Show less button only when the content actually overflows. `lh` resolves against
// this element's own line-height, so "about 8 lines" follows the body's own typography. Measured in
// a layout effect and on resize, so a streaming or re-flowed body updates without a flash.
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
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, children])

  return (
    <>
      <div ref={bodyRef} id={bodyId} className={expanded ? undefined : 'overflow-hidden'} style={expanded ? undefined : { maxHeight: `${lines}lh` }}>
        {children}
      </div>
      {overflowing && (
        <Button type="button" variant="link" size="xs" className="mt-1 px-0" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  )
}
