// Shared initials for every avatar fallback (profile item, profile menu, chat transcript).
// Generational suffixes ("Jr", "III") are never a surname, so they are skipped when picking the
// last name's initial: "Ada Lovelace III" is AL, not AI. Deliberately limited to the unambiguous
// ones: a bare "V" or "MD" can be a real middle or family name.
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)$/i

/** First Unicode code point of `part` (quality-gate remediation, test-reviewer Medium): a plain
 *  `part[0]` takes one UTF-16 code UNIT, which splits an astral character (most emoji, and some
 *  rarer scripts) into its two surrogate halves -- `Array.from` iterates by code point instead,
 *  so a name starting with one of those still yields its real first character, not a broken
 *  half-glyph. Behaviour for plain ASCII/BMP names (the overwhelming common case) is unchanged. */
function firstCharacter(part: string): string {
  return Array.from(part)[0] ?? ''
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  let lastIndex = parts.length - 1
  while (lastIndex > 0 && NAME_SUFFIX.test(parts[lastIndex]!.replace(/\./g, ''))) lastIndex--
  const first = firstCharacter(parts[0]!)
  const last = lastIndex > 0 ? firstCharacter(parts[lastIndex]!) : ''
  return (first + last).toUpperCase()
}
