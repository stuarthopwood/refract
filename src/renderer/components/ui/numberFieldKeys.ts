// `type="number"` also accepts these, which no whole-number setting wants.
const BLOCKED_KEYS: Record<string, true> = { e: true, E: true, '+': true, '-': true }

interface NumberKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Whether a keypress must not reach a number input; `allowNegative` lets a leading `-` through for fields whose range dips below zero. */
export function blocksNumberKey(event: NumberKeyEvent, allowNegative: boolean): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (allowNegative && event.key === '-') return false
  return BLOCKED_KEYS[event.key] === true
}
