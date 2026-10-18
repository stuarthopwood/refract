// Split out of `SubagentChainRow.tsx` (file-size baseline, #806 "no god files"): issue #1008
// item 2's "Go to Stage N" jump -- `ChainStageLine`'s own button handler, and the one shared DOM
// id `StageGroupRow`'s own `CollapsedLine` carries so this can find it.
import { useStageToggleStore } from '@/state'

/** The DOM id every Stage row's own `CollapsedLine` carries, and the one key `jumpToStage` below
 * looks it up by (`document.getElementById`, not a CSS selector -- a Stage's own `group.id` (e.g.
 * `stage:<itemId>`) is never parsed or escaped this way). Gate round 1 fix (issue #1008, item 4,
 * Medium): scoped by `sessionId` too -- a split pane can show two different Sessions at once,
 * each with its own Transcript tree; a bare `group.id` alone could collide with another
 * Session's own Stage id and produce an invalid duplicate DOM id (two elements with the same
 * `id` is a real HTML violation, not merely an ambiguous lookup). */
export function stageRowDomId(sessionId: string | null, stageId: string): string {
  return `stage-row:${sessionId ?? 'none'}:${stageId}`
}

// Gate round 1 fix (issue #1008, item 2, Medium): the small top margin the jumped-to row lands
// at, instead of dead-centring it -- Decided (Skippy, delegated by Stuart 2026-10-18): align to
// the top, matching how a reader's eye naturally starts reading a newly-revealed row from its
// own header down, not from its middle.
const JUMP_SCROLL_TOP_MARGIN_PX = 16

/** "Go to Stage N": forces the target Stage open through the SAME persisted path
 * `useStickyDisclosure` reads (`useStageToggleStore`), so this counts as the user's own manual
 * open (issue #991), not a separate ad-hoc flag a later remount could forget -- `ChainStageLine`
 * is a SIBLING of the Stage row it targets, never its parent, so there is no React ref to use.
 * Gate round 1 fix (issue #1008, item 1, High): the Stage row may genuinely not exist -- "Show
 * tool calls" off hides a settled Stage with no failed/cancelled/exited member entirely
 * (`transcriptRowVisibility.ts`'s own `rowVisibility`); `ChainStageLine` only renders this
 * button at all when that Stage's own row is currently `'visible'`, but a defensive `row` lookup
 * still gates `setManualOpen` here too, so a missing row can never silently persist a manual-open
 * flag for a Stage nothing can currently show. Gate round 1 fix (issue #1008, item 2, Medium):
 * scrolls ONLY the transcript's own scroll viewport (`[aria-label="Transcript"]`, the vendored
 * `MessageScrollerViewport`) by computing the row's own position relative to it and setting that
 * ONE element's `scrollTop` -- never a bare `scrollIntoView`, which walks up and scrolls EVERY
 * scrollable ancestor it finds (a real hazard in a split-pane layout, where a sibling pane's own
 * scroller could move too). Aligns the row's own top edge a small margin below the viewport's
 * top (not centred, Decided above). `row.focus({ preventScroll: true })` (the same pattern
 * `Transcript.tsx`'s own focus-restoration effects use) so the browser's own native
 * focus-scrolling never fights the scroll this function already placed. Drops to an instant
 * jump under `prefers-reduced-motion` (matching `SideChatPanel.tsx`'s own convention) --
 * **not independently exercised by the live check** (no reduced-motion CDP emulation set up for
 * this script; recorded in its own `notExercised`). */
export function jumpToStage(sessionId: string | null, stageId: string): void {
  const row = document.getElementById(stageRowDomId(sessionId, stageId))
  if (!row) return
  if (sessionId != null) useStageToggleStore.getState().setManualOpen(sessionId, stageId, true)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const viewport = row.closest<HTMLElement>('[aria-label="Transcript"]')
  if (viewport) {
    const rowRect = row.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const targetScrollTop = Math.max(0, viewport.scrollTop + (rowRect.top - viewportRect.top) - JUMP_SCROLL_TOP_MARGIN_PX)
    viewport.scrollTo({ top: targetScrollTop, behavior: reducedMotion ? 'auto' : 'smooth' })
  }
  row.focus({ preventScroll: true })
}
