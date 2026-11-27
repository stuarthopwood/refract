/** Test helper: true when `token` is a whole class in `classes`, so `bg-popover/50` never reads as `bg-popover`. */
export function hasClassToken(classes: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<!\\S)${escaped}(?!\\S)`).test(classes)
}
