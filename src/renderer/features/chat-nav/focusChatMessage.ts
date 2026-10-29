const FOCUS_WAIT_MAX_FRAMES = 90

/** Moves keyboard focus to a message's row in the Session's chat pane once it is mounted (a jump
 * into a windowed-out turn mounts it a few frames later). Gives up quietly after about 1.5 s. */
export function focusChatMessage(sessionId: string, messageId: string): void {
  let frames = 0
  const attempt = () => {
    const pane = document.querySelector(`[data-session-pane="${CSS.escape(sessionId)}"]`)
    const row = pane?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (row) {
      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1')
      row.focus({ preventScroll: true })
      return
    }
    frames += 1
    if (frames < FOCUS_WAIT_MAX_FRAMES) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}
