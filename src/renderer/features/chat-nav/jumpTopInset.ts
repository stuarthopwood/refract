import { JUMP_SCROLL_TOP_MARGIN_PX } from '../chat/stageJump'

const FIND_BAR_GAP_PX = 24

/** The distance from the viewport top where every chat-navigation jump lands its target: the
 * normal jump margin, or, while the find bar is open over the transcript, just below the bar's
 * bottom edge so the target is never hidden under it. One value for Previous/Next, Alt+Up/Down,
 * Outline, map and find results. */
export function jumpTopInset(viewport: HTMLElement): number {
  const bar = viewport.closest('[data-session-pane]')?.querySelector('[data-chat-find]')
  if (!bar) return JUMP_SCROLL_TOP_MARGIN_PX
  const below = bar.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top
  return Math.max(JUMP_SCROLL_TOP_MARGIN_PX, Math.ceil(below) + FIND_BAR_GAP_PX)
}
