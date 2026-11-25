/**
 * Whether Esc cancels the whole form. While typing in a text box Esc is left alone, so a stray
 * press never throws away what the user just wrote; elsewhere inside the card it cancels.
 */
export function escapeCancelsForm(key: string, composing: boolean, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (key !== 'Escape' || composing) return false
  if (target?.isContentEditable) return false
  const tag = target?.tagName?.toUpperCase()
  return tag !== 'INPUT' && tag !== 'TEXTAREA'
}

interface EnterTarget {
  tagName?: string
  getAttribute?: (name: string) => string | null
}

/**
 * Whether a bare Enter submits the whole form: from a text box or an option row, never from a textarea
 * (where it breaks the line) or a button, dropdown or other control that already acts on Enter itself.
 */
export function enterSubmitsForm(key: string, composing: boolean, repeat: boolean, target: EnterTarget | null): boolean {
  if (key !== 'Enter' || composing || repeat) return false
  const role = target?.getAttribute?.('role')
  return target?.tagName?.toUpperCase() === 'INPUT' || role === 'radio' || role === 'checkbox'
}
