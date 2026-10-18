// Issue #941 grill item 4: a Stage's own captured batch context, rendered Markdown, visually
// capped to about 6 lines with a REAL expand/collapse control -- shown only when the content
// genuinely overflows the cap, continuously re-measured (gate round 2 fix, item 2: a
// `ResizeObserver`, not a one-shot mount-time read -- the pane resizing, a font/zoom change, or
// `context` itself changing can all flip whether it overflows; `DiffView.tsx`'s own identical
// pattern). Gate round 2 fix, item 3: the visible text is NEVER `inert` (a screen reader must
// still read it in full); only a focusable descendant (a link, a footnote backref, a task-list
// checkbox) whose own top edge sits PAST the visible fold is pulled out of the Tab order while
// collapsed, restored the instant it expands or the fold itself moves. Gate round 2 fix, item
// 4: the label-column indent is the CALLER's own choice (`className`), never hardcoded here --
// a one-agent Stage's `CollapsibleContent` already supplies it, so this component must not add
// a second one on top.
import * as React from 'react'
import { cn } from '@/lib/utils'
import { Markdown, mutedLinkClassName } from './Markdown'

const COLLAPSED_MAX_HEIGHT_PX = 144 // ~6 lines at this text's own line-height
const COLLAPSED_CLASS = 'max-h-36 overflow-hidden'
const FOCUSABLE_SELECTOR = 'a[href], button, [tabindex]'

export function StageContextBrief({ id, context, className }: { id: string; context: string; className?: string }) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [overflows, setOverflows] = React.useState(false)
  const [extraLines, setExtraLines] = React.useState(0)
  const contentId = React.useId()

  // Gate round 2 fix (item 2): a `ResizeObserver` re-measures on every layout change the
  // collapsed block's own rendered height can undergo (pane resize, font/zoom, `context` itself
  // changing), not only once at mount -- `DiffView.tsx`'s own identical pattern.
  React.useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const does = el.scrollHeight > el.clientHeight + 1
      setOverflows(does)
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20
      setExtraLines(does ? Math.max(1, Math.ceil((el.scrollHeight - COLLAPSED_MAX_HEIGHT_PX) / lineHeight)) : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [context])

  // Gate round 2 fix (item 3): while collapsed and overflowing, pull every focusable descendant
  // whose own top edge sits PAST the visible fold out of the Tab order (`tabIndex=-1`) -- the
  // text itself stays fully in the accessibility tree and the DOM either way, so a screen
  // reader still reads it in full; only keyboard focus is withheld from what is invisible.
  // Restored (tabIndex removed) the instant the block expands or stops overflowing.
  React.useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const focusables = el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    for (const node of focusables) {
      if (!expanded && overflows && node.offsetTop + node.offsetHeight > COLLAPSED_MAX_HEIGHT_PX) {
        node.setAttribute('tabindex', '-1')
      } else {
        node.removeAttribute('tabindex')
      }
    }
  }, [expanded, overflows, context])

  return (
    <div className={className}>
      <div ref={contentRef} id={contentId} className={cn('relative', !expanded && COLLAPSED_CLASS)}>
        <Markdown id={id} text={context} className="text-xs text-muted-foreground [&_*:last-child]:mb-0" />
        {!expanded && overflows && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background to-transparent"
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          className={cn(mutedLinkClassName, 'mt-1 inline-block')}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show full brief (${extraLines} more line${extraLines === 1 ? '' : 's'})`}
        </button>
      )}
    </div>
  )
}
