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

/** Set on the wrapper of each listed option when notes are on, so the key handler can tell which option a focused control (row, Note button, Edit, remove) belongs to. */
export const ASK_OPTION_ATTRIBUTE = 'data-ask-option'

/** A bare N or n, the note shortcut: never typed text, a chord, a held key or IME composition. */
export function isNoteShortcut(event: ChoiceKeyEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return false
  if (event.ctrlKey || event.metaKey || event.altKey || isTextTarget(event.target)) return false
  return event.key === 'n' || event.key === 'N'
}

/** The zero-based listed option the focused element belongs to, or null (the Other row and everything outside the options have none). */
export function focusedOptionIndex(container: ParentNode | null, target: EventTarget | null): number | null {
  const wrapper = target instanceof Element ? target.closest(`[${ASK_OPTION_ATTRIBUTE}]`) : null
  if (!container || !wrapper) return null
  const index = Array.from(container.querySelectorAll(`[${ASK_OPTION_ATTRIBUTE}]`)).indexOf(wrapper)
  return index < 0 ? null : index
}

/** What opening a note on an option must do first, so the N key and the Note button agree: nothing when it is already picked, else pick it the way its group does (select on single-choice, tick on multi-select). */
export function pickBeforeNote(multi: boolean, picked: boolean): 'select' | 'toggle' | null {
  if (picked) return null
  return multi ? 'toggle' : 'select'
}

/** The attribute a row sets when it handles Enter itself, so the card-level Enter skips it. */
export const ACCEPTS_ENTER_ATTRIBUTE = 'data-ask-accepts-enter'

/** Enter with no modifier, not held and not confirming IME text. */
export function isPlainEnter(event: Pick<ChoiceKeyEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'nativeEvent'>): boolean {
  return event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.nativeEvent.isComposing
}

/**
 * Enter on an option row acts like the primary button. Radix prevents default on Enter in every row, so defaultPrevented cannot mean "claimed";
 * a row that accepts Enter itself (the recommended one) marks itself and is skipped here.
 */
export function isRowEnter(event: ChoiceKeyEvent): boolean {
  if (!isPlainEnter(event)) return false
  const target = event.target instanceof Element ? event.target : null
  const role = target?.getAttribute('role')
  return (role === 'radio' || role === 'checkbox') && !target?.hasAttribute(ACCEPTS_ENTER_ATTRIBUTE)
}

/** Moves focus to the option row a digit just changed, so assistive tech reads its new state. */
export function focusChoiceRow(container: ParentNode | null, index: number): void {
  container?.querySelectorAll<HTMLElement>('[role=radio], [role=checkbox]')[index]?.focus()
}
