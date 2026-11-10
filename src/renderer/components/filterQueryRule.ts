/** Fewest characters (after trimming) a list filter needs before it narrows anything; the one place this rule lives (#1811). */
export const FILTER_MIN_CHARS = 3

/** The text a list should actually filter by: the trimmed query once it reaches `FILTER_MIN_CHARS`, otherwise '' (the full list). */
export function effectiveFilterQuery(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.length >= FILTER_MIN_CHARS ? trimmed : ''
}

/** Screen-reader and placeholder wording for the rule, so every filter states it the same way. */
export const FILTER_MIN_CHARS_HINT = `Type at least ${FILTER_MIN_CHARS} characters to filter`
