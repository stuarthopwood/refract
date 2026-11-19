// The resize handle stops being focusable while chat is hidden (spec 137 FR-024), so a drag or arrow-key
// step that hides chat while the handle has focus would strand it; the rail Chat pane toggle takes it.

/** Whether the handle holds focus. A blur that arrives because the handle just became disabled is not the user leaving it. */
export function nextHandleFocus(hadFocus: boolean, event: 'focus' | 'blur', handleDisabled: boolean): boolean {
  if (event === 'focus') return true
  return handleDisabled ? hadFocus : false
}

/** True when the handle went disabled while it held focus: the one case the focus must be moved. */
export function shouldRescueHandleFocus(input: { handleDisabled: boolean; hadFocus: boolean }): boolean {
  return input.handleDisabled && input.hadFocus
}
