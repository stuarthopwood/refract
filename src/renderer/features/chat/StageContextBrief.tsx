// Issue #941 grill item 4: a Stage's own captured batch context, rendered Markdown, visually
// capped to about 6 lines with a REAL expand/collapse control -- shown only when the content
// genuinely overflows the cap, continuously re-measured (gate round 2 fix, item 2: a
// `ResizeObserver`, not a one-shot mount-time read -- the pane resizing, a font/zoom change, or
// `context` itself changing can all flip whether it overflows; `DiffView.tsx`'s own identical
// pattern). Gate round 2 fix, item 3: the visible text is NEVER `inert` (a screen reader must
// still read it in full); only a focusable descendant (a link, a footnote backref, a task-list
// checkbox) whose own TOP edge sits PAST the visible fold is pulled out of the Tab order while
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
  // Carries the current `expanded` value into the `ResizeObserver` callback below without
  // re-subscribing the observer on every toggle.
  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded
  // Gate round 3 fix (item 2): the ORIGINAL `tabindex` attribute value (or `null` for "had
  // none") of every focusable descendant this component itself overrides, keyed by element, so
  // restoring it never clobbers an attribute the Markdown renderer set on purpose (a scrollable
  // code block's own `tabIndex=0`) -- a blind `removeAttribute` previously stripped that too.
  const originalTabIndexRef = React.useRef(new WeakMap<HTMLElement, string | null>())

  // Gate round 3 fix (item 1): overflow is measured against the FIXED collapsed-cap pixel
  // value, not `el.clientHeight` -- `clientHeight` itself shrinks to the full, uncapped content
  // height the instant `expanded` removes `COLLAPSED_CLASS`, so the old `scrollHeight >
  // clientHeight` check always read `false` once expanded, `overflows` flipped to `false`, and
  // the toggle (gated on `overflows`) unmounted out from under the user's own click, stranding
  // focus on `<body>` with no way left to re-collapse. `scrollHeight` itself is unaffected by
  // the element's own `overflow`/`max-height`, so comparing it to the constant cap holds
  // identically whether the element is currently capped or not.
  //
  // Gate round 3 fix (item 2, folded into this same pass): the Tab-order sweep runs every time
  // this measures -- on mount, on every real layout change the `ResizeObserver` reports, and
  // (via the second effect below) the instant `expanded` itself toggles -- so a reflow that
  // changes which descendants sit past the fold without the overall overflow BOOLEAN changing
  // can never leave a stale override in place. "Past the fold" is judged by the element's own
  // TOP edge only (`offsetTop > CAP`), not its bottom: an element straddling the fold boundary
  // is still at least partially visible, so it stays reachable.
  const measure = React.useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const does = el.scrollHeight > COLLAPSED_MAX_HEIGHT_PX + 1
    setOverflows(does)
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20
    setExtraLines(does ? Math.max(1, Math.ceil((el.scrollHeight - COLLAPSED_MAX_HEIGHT_PX) / lineHeight)) : 0)

    const collapsedAndOverflowing = !expandedRef.current && does
    const originals = originalTabIndexRef.current
    for (const node of el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      const pastFold = collapsedAndOverflowing && node.offsetTop > COLLAPSED_MAX_HEIGHT_PX
      if (pastFold) {
        if (!originals.has(node)) originals.set(node, node.getAttribute('tabindex'))
        node.setAttribute('tabindex', '-1')
      } else if (originals.has(node)) {
        const original = originals.get(node) ?? null
        if (original === null) node.removeAttribute('tabindex')
        else node.setAttribute('tabindex', original)
        originals.delete(node)
      }
    }
  }, [])

  React.useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [context, measure])

  // Toggling expand/collapse changes which descendants are "past the fold" immediately, without
  // waiting for the next resize -- re-run the same pass synchronously.
  React.useLayoutEffect(() => {
    measure()
  }, [expanded, measure])

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
          className={cn(mutedLinkClassName, 'mt-1 inline-block text-xs text-muted-foreground')}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show full brief (${extraLines} more line${extraLines === 1 ? '' : 's'})`}
        </button>
      )}
    </div>
  )
}
