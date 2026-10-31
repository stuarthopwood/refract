import { toast } from 'sonner'
import { useThemeStore, useActiveThemeId } from '@/state'
import { THEMES } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'

export interface ThemeEntry {
  key: string
  name: string
  swatch: string
  swatchPrimary: string
  builtin: ThemeId | null
  customId: string | null
}

const BUILTINS: ThemeEntry[] = Object.values(THEMES).map((t) => ({ key: t.id, name: t.name, swatch: t.swatch, swatchPrimary: t.swatchPrimary, builtin: t.id, customId: null }))

/** Built-in and custom theme entries plus active-state and choose logic, shared by Settings > Appearance and the profile menu. */
export function useThemeEntries() {
  const activeBuiltin = useActiveThemeId()
  const storedCustomId = useThemeStore((s) => s.customId)
  const customThemes = useThemeStore((s) => s.customThemes)
  const customId = customThemes.some((t) => t.id === storedCustomId) ? storedCustomId : null
  const customs: ThemeEntry[] = customThemes.map((t) => {
    const base = THEMES[t.base]
    return { key: `custom-${t.id}`, name: t.name, swatch: t.tokens.background ?? base.swatch, swatchPrimary: t.tokens.primary ?? base.swatchPrimary, builtin: null, customId: t.id }
  })
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

  return { builtins: BUILTINS, customs, customThemes, customId, isActive, choose }
}
