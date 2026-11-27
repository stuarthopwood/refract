import { THEMES, isLightTheme } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'

export interface ThemeEntry {
  key: string
  name: string
  swatch: string
  swatchPrimary: string
  builtin: ThemeId | null
  customId: string | null
}

export interface BuiltinGroup {
  label: string
  entries: ThemeEntry[]
}

const toEntry = (t: (typeof THEMES)[ThemeId]): ThemeEntry => ({ key: t.id, name: t.name, swatch: t.swatch, swatchPrimary: t.swatchPrimary, builtin: t.id, customId: null })

const THEME_LIST = Object.values(THEMES)

/** Light then dark, each in `THEMES` order (#2172); the picker and profile menu render the groups, arrow keys walk `builtins`. */
export const BUILTIN_GROUPS: BuiltinGroup[] = [
  { label: 'Light', entries: THEME_LIST.filter((t) => isLightTheme(t.id)).map(toEntry) },
  { label: 'Dark', entries: THEME_LIST.filter((t) => !isLightTheme(t.id)).map(toEntry) }
]

export const BUILTINS: ThemeEntry[] = BUILTIN_GROUPS.flatMap((g) => g.entries)

/** Index of each group's first row in the flat arrow-key order, so a row's focus index is `starts[g] + i`. */
export function groupStartOffsets(groups: ReadonlyArray<{ entries: readonly unknown[] }>): number[] {
  const starts: number[] = []
  let next = 0
  for (const group of groups) {
    starts.push(next)
    next += group.entries.length
  }
  return starts
}
