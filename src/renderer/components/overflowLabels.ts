// Pure helpers behind `LabelOverflow` (#1873): which labels a row shows, and the chip's accessible name.

/** The first `max` labels are shown and the rest are hidden behind the chip; a negative `max` counts as 0. */
export function splitOverflowLabels<T>(labels: readonly T[], max: number): { shown: T[]; hidden: T[] } {
  const cap = Math.max(0, max)
  return { shown: labels.slice(0, cap), hidden: labels.slice(cap) }
}

/** Starts with the visible "+N" (WCAG 2.5.3) and then names every hidden label, e.g. "+3 more labels: a, b, c". */
export function overflowChipName(hidden: readonly { name: string }[]): string {
  const noun = hidden.length === 1 ? 'label' : 'labels'
  return `+${hidden.length} more ${noun}: ${hidden.map((label) => label.name).join(', ')}`
}
