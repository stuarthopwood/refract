// Issue #941 grill item 4, gate round 1 fix: a Stage's own captured batch context, rendered
// Markdown, visually capped to about 6 lines with a REAL expand/collapse control (not just a
// CSS clamp with no way to read the rest) -- shown only when the content genuinely overflows
// the cap, measured after mount (the cap is a fixed 144px, about 6 lines of this text's own
// 24px line height). The overflowing tail stays `inert` while collapsed: nothing below the
// visible fold is keyboard-reachable until the "Show full brief" control expands it.
import * as React from 'react'
import { cn } from '@/lib/utils'
import { LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'

const COLLAPSED_CLASS = 'max-h-36 overflow-hidden'

export function StageContextBrief({ id, context }: { id: string; context: string }) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [overflows, setOverflows] = React.useState(false)
  const contentId = React.useId()

  // Measured once: `context` is static for this Stage's whole life (captured at construction,
  // `groupSubagentStages.ts`), so there is nothing to re-measure on a later render.
  React.useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [])

  return (
    // Grill item 1: the brief (and the sibling "Uses:" line, `StageUsesLine`) sit in the same
    // label column every Spine member's own expanded body starts at, never flush at the left
    // edge of the expanded content area.
    <div className={cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2')}>
      <div
        ref={contentRef}
        id={contentId}
        // The clipped-out tail must not be keyboard-reachable while visually hidden; `inert`
        // drops the WHOLE block from focus/AT while collapsed (a short prose brief carries
        // nothing meaningfully interactive to lose by this) and is removed entirely on expand.
        inert={!expanded && overflows ? true : undefined}
        className={cn('relative text-xs text-muted-foreground [&_*:last-child]:mb-0', !expanded && COLLAPSED_CLASS)}
      >
        <Markdown id={id} text={context} className="text-muted-foreground" />
        {!expanded && overflows && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent"
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show full brief'}
        </button>
      )}
    </div>
  )
}
