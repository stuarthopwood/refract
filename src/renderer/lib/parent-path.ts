/** The parent folder of `path` (plain-string handling, either separator), or `null` when it has none. */
export function parentOf(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index <= 0) return null
  const parent = trimmed.slice(0, index)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}
