// Where selection goes when a background refresh removes the selected row (#1589): the next row
// that survives, else the previous one, else none. An unlisted selection is left alone.
export interface RowKey {
  repositoryId: string
  number: number
}

const keyOf = (row: RowKey): string => `${row.repositoryId}#${row.number}`

export function selectionAfterRefresh<S extends RowKey>(previous: RowKey[], next: RowKey[], selected: S | null): RowKey | S | null {
  if (selected === null) return null
  const surviving = new Set(next.map(keyOf))
  const selectedKey = keyOf(selected)
  if (surviving.has(selectedKey)) return selected
  const index = previous.findIndex((row) => keyOf(row) === selectedKey)
  if (index < 0) return selected
  const survives = (row: RowKey): boolean => surviving.has(keyOf(row))
  const after = previous.slice(index + 1).find(survives)
  const before = previous.slice(0, index).reverse().find(survives)
  const target = after ?? before
  return target === undefined ? null : { repositoryId: target.repositoryId, number: target.number }
}
