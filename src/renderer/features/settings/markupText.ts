/**
 * The visible text of a rendered markup fragment: its text nodes, joined, with every tag dropped.
 * It collects text between `>` and `<` instead of stripping tags with a replace, because a single-pass
 * tag-stripping regex is what CodeQL flags as incomplete multi-character sanitization. Test-only.
 */
export function markupText(fragment: string): string {
  // The sentinels let text at either end of the fragment, which has no tag beside it, match like the rest.
  return [...`>${fragment}<`.matchAll(/>([^<]*)</g)].map((m) => m[1] ?? '').join('')
}
