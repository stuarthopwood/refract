import { useMemo } from 'react'
import { toast } from 'sonner'
import { useThemeStore, useActiveThemeId } from '@/state'
import { THEMES, isLightTheme } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'
import type { CustomTheme } from '../../shared/ipc-themes'

export interface ThemeEntry {
  key: string
  name: string
  swatch: string
  swatchPrimary: string
  builtin: ThemeId | null
  customId: string | null
}

const toEntry = (t: (typeof THEMES)[ThemeId]): ThemeEntry => ({ key: t.id, name: t.name, swatch: t.swatch, swatchPrimary: t.swatchPrimary, builtin: t.id, customId: null })

export interface BuiltinGroup {
  label: string
  entries: ThemeEntry[]
}

const THEME_LIST = Object.values(THEMES)

/** Light then dark, each in `THEMES` order (#2172); the picker and profile menu render the groups, arrow keys walk `builtins`. */
export const BUILTIN_GROUPS: BuiltinGroup[] = [
  { label: 'Light', entries: THEME_LIST.filter((t) => isLightTheme(t.id)).map(toEntry) },
  { label: 'Dark', entries: THEME_LIST.filter((t) => !isLightTheme(t.id)).map(toEntry) }
]

const BUILTINS: ThemeEntry[] = BUILTIN_GROUPS.flatMap((g) => g.entries)

export interface ThemeEntries {
  builtins: ThemeEntry[]
  builtinGroups: BuiltinGroup[]
  customs: ThemeEntry[]
  /** Built-ins then customs, in display order. */
  all: ThemeEntry[]
  customThemes: CustomTheme[]
  customId: string | null
  isActive(e: ThemeEntry): boolean
  choose(e: ThemeEntry): Promise<boolean>
}

/** Built-in and custom theme entries plus active-state and choose logic, shared by Settings > Appearance and the profile menu. */
export function useThemeEntries(): ThemeEntries {
  const activeBuiltin = useActiveThemeId()
  const storedCustomId = useThemeStore((s) => s.customId)
  const customThemes = useThemeStore((s) => s.customThemes)
  const customId = customThemes.some((t) => t.id === storedCustomId) ? storedCustomId : null
  const customs = useMemo<ThemeEntry[]>(
    () =>
      customThemes.map((t) => {
        const base = THEMES[t.base]
        return { key: `custom-${t.id}`, name: t.name, swatch: t.tokens.background ?? base.swatch, swatchPrimary: t.tokens.primary ?? base.swatchPrimary, builtin: null, customId: t.id }
      }),
    [customThemes]
  )
  const all = useMemo(() => [...BUILTINS, ...customs], [customs])
  const isActive = (e: ThemeEntry) => (e.customId !== null ? e.customId === customId : customId === null && e.builtin === activeBuiltin)

  /** Resolves true when a save happened; choosing the active entry is a no-op so `save` doesn't round-trip over IPC. */
  async function choose(e: ThemeEntry): Promise<boolean> {
    if (isActive(e)) return false
    const { save, saveCustom } = useThemeStore.getState()
    try {
      if (e.customId !== null) return await saveCustom(e.customId)
      return e.builtin ? await save(e.builtin) : false
    } catch (err: unknown) {
      console.error('theme choose threw', err)
      toast.error('Could not change theme.')
      return false
    }
  }

  return { builtins: BUILTINS, builtinGroups: BUILTIN_GROUPS, customs, all, customThemes, customId, isActive, choose }
}
