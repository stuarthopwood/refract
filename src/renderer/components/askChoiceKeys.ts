/** Digit keys address the first nine options only; later ones are click or Tab only. */
export const MAX_DIGIT_OPTIONS = 9

interface ChoiceKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat: boolean
  defaultPrevented: boolean
  nativeEvent: { isComposing: boolean }
  target: EventTarget | null
}

/** Typing into a box owns every printable key, so a digit there is text, not a shortcut. */
function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  const tag = element?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true
}

/** The zero-based option a bare 1-9 key press addresses, or null when the press is not a choice shortcut. */
export function choiceDigitIndex(event: ChoiceKeyEvent, optionCount: number): number | null {
  if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey || isTextTarget(event.target)) return null
  if (!/^[1-9]$/.test(event.key)) return null
  const index = Number(event.key) - 1
  return index < Math.min(optionCount, MAX_DIGIT_OPTIONS) ? index : null
}

/** Enter on an option row that nothing else claimed (the recommended row does), which acts like the primary button. */
export function isRowEnter(event: ChoiceKeyEvent): boolean {
  if (event.key !== 'Enter' || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return false
  const role = (event.target as HTMLElement | null)?.getAttribute?.('role')
  return role === 'radio' || role === 'checkbox'
}

/** Moves focus to the option row a digit just changed, so assistive tech reads its new state. */
export function focusChoiceRow(container: ParentNode | null, index: number): void {
  container?.querySelectorAll<HTMLElement>('[role=radio], [role=checkbox]')[index]?.focus()
}
