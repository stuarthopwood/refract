// Shared initials for every avatar fallback (profile item, profile menu, chat transcript).
// Generational suffixes ("Jr", "III") are never a surname, so they are skipped when picking the
// last name's initial: "Ada Lovelace III" is AL, not AI. Deliberately limited to the unambiguous
// ones: a bare "V" or "MD" can be a real middle or family name.
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)$/i

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  let lastIndex = parts.length - 1
  while (lastIndex > 0 && NAME_SUFFIX.test(parts[lastIndex]!.replace(/\./g, ''))) lastIndex--
  const first = parts[0]![0] ?? ''
  const last = lastIndex > 0 ? (parts[lastIndex]![0] ?? '') : ''
  return (first + last).toUpperCase()
}
