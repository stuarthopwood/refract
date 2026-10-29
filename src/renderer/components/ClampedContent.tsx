import * as React from 'react'
import { cn } from '@/lib/utils'
import { disclosureToggleClassName } from '@/features/chat/linkStyles'

const FADE_HEIGHT_PX = 24 // h-6, the bottom fade's own height
// A mask on the body (not a background-coloured overlay) so the fade works on any surface tint.
const FADE_MASK = `linear-gradient(to bottom, #000 calc(100% - ${FADE_HEIGHT_PX}px), transparent)`
const FOCUSABLE_SELECTOR = 'a[href], button, [tabindex]'

export interface ClampedContentProps {
  /** CSS length the body clamps to before the toggle appears (`8lh` follows the body's own
   *  line-height; `9rem` is a fixed cap). */
  maxHeight: string
  /** Paints a bottom fade over the cut. */
  fade?: boolean
  /** What happens when a focusable descendant sits past the cut while collapsed: `expand` opens the
   *  body when focus lands on it, `skip-tab` takes it out of the Tab order until expanded. */
  pastCutFocus?: 'expand' | 'skip-tab'
  /** Toggle text while collapsed; defaults to "Show more". */
  collapsedLabel?: (hiddenLines: number) => string
  className?: string
  children: React.ReactNode
}

// ADR 0003: the one clamp (a body cut to `maxHeight` behind a real Show more / Show less button,
// shown only when the content overflows). Re-measured on resize and DOM growth so a streaming or
// re-flowed body updates; the cut is read from the rendered box, so any CSS length works. The body
// is never `inert` (a screen reader still reads it in full). The wrapper's `-m-1 p-1` gives focus
// rings at the edges room inside the clip. The toggle uses the shared muted link look.
export function ClampedContent({
  maxHeight,
  fade = false,
  pastCutFocus = 'expand',
  collapsedLabel,
  className,
  children
}: ClampedContentProps) {
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const toggleRef = React.useRef<HTMLButtonElement>(null)
  const bodyId = React.useId()
  const [expanded, setExpanded] = React.useState(false)
  const [overflowing, setOverflowing] = React.useState(false)
  const [hiddenLines, setHiddenLines] = React.useState(0)
  const cutRef = React.useRef(0)
  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded
  const keepToggleInView = React.useRef(false)
  // Original `tabindex` (or null) of each descendant this component overrides, so restoring never
  // clobbers one the Markdown renderer set on purpose (a scrollable code block's `tabIndex=0`).
  const originalTabIndex = React.useRef(new WeakMap<HTMLElement, string | null>())

  const measure = React.useCallback(() => {
    const element = bodyRef.current
    if (!element) return
    if (!expandedRef.current) {
      cutRef.current = element.clientHeight
      const does = element.scrollHeight > cutRef.current + 1
      setOverflowing(does)
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20
      setHiddenLines(does ? Math.max(1, Math.ceil((element.scrollHeight - cutRef.current) / lineHeight)) : 0)
    }
    if (pastCutFocus !== 'skip-tab') return
    const collapsedAndOverflowing = !expandedRef.current && element.scrollHeight > cutRef.current + 1
    const limit = cutRef.current - (fade ? FADE_HEIGHT_PX : 0)
    const originals = originalTabIndex.current
    const top = element.getBoundingClientRect().top
    for (const node of element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      const bottom = node.getBoundingClientRect().bottom - top + element.scrollTop
      if (collapsedAndOverflowing && bottom > limit) {
        if (!originals.has(node)) originals.set(node, node.getAttribute('tabindex'))
        node.setAttribute('tabindex', '-1')
      } else if (originals.has(node)) {
        const original = originals.get(node) ?? null
        if (original === null) node.removeAttribute('tabindex')
        else node.setAttribute('tabindex', original)
        originals.delete(node)
      }
    }
  }, [fade, pastCutFocus])

  React.useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return
    measure()
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(element)
    // The collapsed box is pinned to the cut, so inner growth (async syntax highlighting, streaming
    // text) never resizes it; the mutation observer catches that.
    const mutationObserver = new MutationObserver(measure)
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [measure])

  React.useLayoutEffect(() => {
    measure()
    if (!expanded && keepToggleInView.current) {
      keepToggleInView.current = false
      toggleRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [expanded, measure])

  function handleFocusCapture(event: React.FocusEvent<HTMLDivElement>) {
    const element = bodyRef.current
    if (pastCutFocus !== 'expand' || expandedRef.current || !element || !(event.target instanceof HTMLElement)) return
    // The browser scrolls a focused clipped element into the box, so add `scrollTop` back to judge
    // it against the cut it started behind.
    const bottom = event.target.getBoundingClientRect().bottom - element.getBoundingClientRect().top + element.scrollTop
    const limit = cutRef.current + 1 - (fade ? FADE_HEIGHT_PX : 0)
    if (bottom > limit) setExpanded(true)
  }

  function handleToggle() {
    if (expanded) {
      keepToggleInView.current = true
      // Focus inside the body would be left in clipped content once it collapses.
      if (bodyRef.current?.contains(document.activeElement)) toggleRef.current?.focus()
    }
    setExpanded((value) => !value)
  }

  return (
    <div className={className}>
      <div
        ref={bodyRef}
        id={bodyId}
        className={cn('relative -m-1 p-1', !expanded && 'overflow-hidden')}
        style={{
          ...(expanded ? null : { maxHeight: `calc(${maxHeight} + 0.5rem)` }),
          ...(fade && !expanded && overflowing ? { maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK } : null)
        }}
        onFocusCapture={handleFocusCapture}
      >
        {children}
      </div>
      {overflowing && (
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={handleToggle}
          className={cn(disclosureToggleClassName, 'mt-1')}
        >
          {expanded ? 'Show less' : (collapsedLabel?.(hiddenLines) ?? 'Show more')}
        </button>
      )}
    </div>
  )
}
