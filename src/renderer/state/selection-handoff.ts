// Where selection goes when a background refresh removes the selected row (#1589): the next row
// that survives, else the previous one, else none. An unlisted selection is left alone.
export function selectionAfterRefresh<T, S>(
  previous: T[],
  next: T[],
  selected: S | null,
  matches: (item: T, selected: S) => boolean,
  toSelection: (item: T) => S
): S | null {
  if (selected === null) return null
  if (next.some((item) => matches(item, selected))) return selected
  const index = previous.findIndex((item) => matches(item, selected))
  if (index < 0) return selected
  const survives = (item: T): boolean => next.some((candidate) => matches(candidate, toSelection(item)))
  const after = previous.slice(index + 1).find(survives)
  const before = previous.slice(0, index).reverse().find(survives)
  const target = after ?? before
  return target === undefined ? null : toSelection(target)
}
