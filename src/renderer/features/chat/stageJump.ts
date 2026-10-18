// Split out of `SubagentChainRow.tsx` (file-size baseline, #806 "no god files"): issue #1008
// item 2's "Go to Stage N" jump -- `ChainStageLine`'s own button handler, and the one shared DOM
// id `StageGroupRow`'s own `CollapsedLine` carries so this can find it.
import { useStageToggleStore } from '@/state'

/** The DOM id every Stage row's own `CollapsedLine` carries, and the one key `jumpToStage` below
 * looks it up by (`document.getElementById`, not a CSS selector -- a Stage's own `group.id` (e.g.
 * `stage:<itemId>`) is never parsed or escaped this way). */
export function stageRowDomId(stageId: string): string {
  return `stage-row:${stageId}`
}

/** "Go to Stage N": forces the target Stage open through the SAME persisted path
 * `useStickyDisclosure` reads (`useStageToggleStore`), so this counts as the user's own manual
 * open (issue #991), not a separate ad-hoc flag a later remount could forget -- `ChainStageLine`
 * is a SIBLING of the Stage row it targets, never its parent, so there is no React ref to use.
 * Every Stage in a chain row's own turn is already mounted real DOM (no virtualizer removes it;
 * `message-scroller.tsx`'s own `content-visibility:auto` only skips paint/layout, never removal)
 * by the time a user can click this button, so the lookup is synchronous, no effect/timeout
 * needed. A `null` sessionId has no persisted path to force open through (matches
 * `useStickyDisclosure`'s own null-session fallback; never hit for a real Stage). Drops the
 * smooth scroll under `prefers-reduced-motion`, matching `SideChatPanel.tsx`'s own convention. */
export function jumpToStage(sessionId: string | null, stageId: string): void {
  if (sessionId != null) useStageToggleStore.getState().setManualOpen(sessionId, stageId, true)
  const row = document.getElementById(stageRowDomId(stageId))
  if (!row) return
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  row.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' })
  row.focus()
}
