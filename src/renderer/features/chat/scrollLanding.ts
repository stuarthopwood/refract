import type { SessionScrollState } from '@/state/scroll-store'

/** Issue #485: how far (in px) from the true bottom still counts as "at the end" when recording
 * or restoring a Session's scroll position -- a little slack absorbs sub-pixel rounding and a
 * `content-visibility:auto` row's placeholder-to-real height settle, without miscounting a
 * developer who is genuinely reading a few rows up as "at the end". */
export const SCROLL_END_TOLERANCE_PX = 48

/** How many consecutive animation frames the just-applied content's `scrollHeight` must stay
 * unchanged before the landing effect stops re-asserting the target `scrollTop` (a
 * `content-visibility:auto` row settling from its placeholder height to its real one can still be
 * in flight right after commit). */
export const SCROLL_LANDING_STABLE_FRAMES = 2

/** Upper bound on animation frames the landing effect polls for, so a layout that never truly
 * settles cannot poll forever. */
export const SCROLL_LANDING_MAX_FRAMES = 20

export interface ViewportMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pure so the decision is unit-testable without a DOM: true when `metrics` is within
 * `tolerance` px of the true bottom. */
export function isAtScrollEnd(metrics: ViewportMetrics, tolerance: number = SCROLL_END_TOLERANCE_PX): boolean {
  const distanceFromEnd = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distanceFromEnd <= tolerance
}

/** The `scrollTop` to land a (re)applied Session/Conversation view on (issue #485): the end when
 * there is no memory yet (a never-visited Session, or a Session whose Conversation just changed,
 * `useChatScrollStore`'s `clear`) or the memory says the developer left at the end, otherwise the
 * exact offset they left at. */
export function resolveLandingScrollTop(memory: SessionScrollState | undefined, scrollHeight: number): number {
  if (!memory || memory.atEnd) return scrollHeight
  return memory.scrollTop
}
