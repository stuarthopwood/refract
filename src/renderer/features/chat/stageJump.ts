// Split out of `SubagentChainRow.tsx` (file-size baseline, #806 "no god files"): issue #1008
// item 2's "Go to Stage N" jump -- `ChainStageLine`'s own button handler, and the one shared DOM
// id `StageGroupRow`'s own `CollapsedLine` carries so this can find it.
import { useStageToggleStore } from '@/state'
import { SCROLL_LANDING_STABLE_FRAMES, SCROLL_PERTURBATION_TOLERANCE_PX } from './scrollLanding'

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

// Gate round 2 fix (issue #1008, item 2, HIGH -- falsified live): a turn that is still
// unsettled (a permanently failed Stage, FR-068) leaves `MessageScrollerProvider`'s own
// follow-bottom mode engaged (`Transcript.tsx`'s `autoScroll` prop is only ever suppressed by
// ITS OWN local state, which this plain function cannot reach -- see the jsdoc above re: no
// React ref). Opening the jumped-to Stage is itself a DOM mutation the vendored scroller
// observes and reacts to by re-snapping to the end, which a single `scrollTo` call loses the
// race against every time (confirmed live: `viewport.scrollTop` read back pinned at
// `scrollHeight - clientHeight` from the very first animation frame, never once reaching the
// row). `scrollLanding.ts`'s own doc already names this exact interaction ("`MessageScroller-
// Provider`'s own follow-bottom behaviour can keep nudging `scrollTop` away from the target") as
// the reason `Transcript.tsx`'s session-landing effect re-asserts its target every frame instead
// of once -- the same fix, scoped to just this jump's own short settle window, reusing that
// effect's stable-frame/perturbation-tolerance constants so both places agree on what "stuck"
// means. Recomputes the target each frame (not just the first) since `rowRect`/`viewportRect`
// can themselves shift while content above/below the row is still settling.
const JUMP_SETTLE_MAX_FRAMES = 60

function settleScrollToRow(viewport: HTMLElement, row: HTMLElement): void {
  let frame = 0
  let stableFrames = 0
  let lastAssigned = -1
  function step() {
    const rowRect = row.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const target = Math.max(0, viewport.scrollTop + (rowRect.top - viewportRect.top) - JUMP_SCROLL_TOP_MARGIN_PX)
    const notPerturbed = lastAssigned === -1 || Math.abs(viewport.scrollTop - lastAssigned) < SCROLL_PERTURBATION_TOLERANCE_PX
    const onTarget = Math.abs(target - viewport.scrollTop) < SCROLL_PERTURBATION_TOLERANCE_PX
    stableFrames = notPerturbed && onTarget ? stableFrames + 1 : 0
    viewport.scrollTop = target
    lastAssigned = target
    frame += 1
    if (stableFrames >= SCROLL_LANDING_STABLE_FRAMES || frame >= JUMP_SETTLE_MAX_FRAMES) return
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

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
 * focus-scrolling never fights the scroll this function already placed. Drops to a single
 * instant assignment under `prefers-reduced-motion` (matching `SideChatPanel.tsx`'s own
 * convention) -- **not independently exercised by the live check** (no reduced-motion CDP
 * emulation set up for this script; recorded in its own `notExercised`). Gate round 2 fix (issue
 * #1008, item 2, HIGH): every OTHER case runs `settleScrollToRow`'s short re-assertion loop
 * instead of one `scrollTo`, so the jump actually lands even on an unsettled turn (see that
 * function's own jsdoc). */
export function jumpToStage(sessionId: string | null, stageId: string): void {
  const row = document.getElementById(stageRowDomId(sessionId, stageId))
  if (!row) return
  if (sessionId != null) useStageToggleStore.getState().setManualOpen(sessionId, stageId, true)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const viewport = row.closest<HTMLElement>('[aria-label="Transcript"]')
  if (viewport) {
    if (reducedMotion) {
      const rowRect = row.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      viewport.scrollTop = Math.max(0, viewport.scrollTop + (rowRect.top - viewportRect.top) - JUMP_SCROLL_TOP_MARGIN_PX)
    } else {
      settleScrollToRow(viewport, row)
    }
  }
  row.focus({ preventScroll: true })
}

