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
