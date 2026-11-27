import { JUMP_SCROLL_TOP_MARGIN_PX } from '../chat/stageJump'

const FIND_BAR_GAP_PX = 24

// A held jump asks for the inset every frame. While no Find bar is mounted (nearly always) the answer
// is the plain margin, so a counter the bar maintains spares each frame a subtree query.
let openFindBars = 0

/** Called by the Find bar while it is mounted; returns the release. */
export function trackOpenFindBar(): () => void {
  openFindBars += 1
  return () => {
    openFindBars -= 1
  }
}

/** The distance from the viewport top where every chat-navigation jump lands its target: the
 * normal jump margin, or, while the find bar is open over the transcript, just below the bar's
 * bottom edge so the target is never hidden under it. One value for Previous/Next, Alt+Up/Down,
 * Outline, map and find results. */
export function jumpTopInset(viewport: HTMLElement): number {
  if (openFindBars === 0) return JUMP_SCROLL_TOP_MARGIN_PX
  const bar = viewport.closest('[data-session-pane]')?.querySelector('[data-chat-find]')
  if (!bar) return JUMP_SCROLL_TOP_MARGIN_PX
  const below = bar.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top
  return Math.max(JUMP_SCROLL_TOP_MARGIN_PX, Math.ceil(below) + FIND_BAR_GAP_PX)
}
