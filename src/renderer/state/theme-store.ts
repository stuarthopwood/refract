import { create } from 'zustand'
import { toast } from 'sonner'
import { isThemeId } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'
import type { CustomTheme, RejectedTheme } from '../../shared/ipc-themes'
import { applyTokens, clearTokens } from '../lib/themeTokens'
import { notify } from './notify'

interface ThemeState {
 theme: ThemeId
 customId: string | null
 customThemes: CustomTheme[]
 rejected: RejectedTheme[]
 save(id: ThemeId): Promise<boolean>
 saveCustom(id: string | null): Promise<boolean>
 refreshCustomThemes(): Promise<void>
 resetToDark(): Promise<boolean>
 setTheme(theme: ThemeId, customId?: string | null): void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
 theme: 'dark',
 customId: null,
 customThemes: [],
 rejected: [],

 save: async (id) => {
  try {
   const result = await window.refract.theme.set(id)
   if (result.ok) {
    set({ theme: result.value.theme })
    // Picking a built-in preset leaves any custom theme.
    if (get().customId !== null) return get().saveCustom(null)
    return true
   }
   notify(result.error)
   return false
  } catch (err: unknown) {
   console.error('theme.set threw', err)
   notify({ code: 'unsupported', message: 'Could not save theme.' })
   return false
  }
 },

 saveCustom: async (id) => {
  const result = await window.refract.themes.setCustom(id)
  if (result.ok) {
   set({ customId: result.value.customTheme ?? null })
   if (id !== null) toast.info('Custom theme applied. If it is hard to read, press Ctrl+Shift+0 to reset to Dark.')
   return true
  }
  notify(result.error)
  return false
 },

 refreshCustomThemes: async () => {
  const result = await window.refract.themes.list()
  if (result.ok) set({ customThemes: result.value.themes, rejected: result.value.rejected })
  else notify(result.error)
 },

 setTheme: (theme, customId) => set(customId === undefined ? { theme } : { theme, customId }),

 resetToDark: async () => {
  const ok = await get().save('dark')
  if (ok) notify({ code: 'unsupported', message: 'Theme reset to Dark.' })
  return ok
 }
}))

/** The custom theme the user has active, or null when a built-in is showing. */
export function activeCustomTheme(state: Pick<ThemeState, 'customId' | 'customThemes'>): CustomTheme | null {
 return state.customThemes.find((t) => t.id === state.customId) ?? null
}

/** A custom theme follows its base preset for Mermaid and Shiki (#1474 derives them from tokens). */
export function activeThemeId(state: Pick<ThemeState, 'theme' | 'customId' | 'customThemes'>): ThemeId {
 const custom = activeCustomTheme({ customId: state.customId, customThemes: state.customThemes })
 if (custom) return custom.base
 return isThemeId(state.theme) ? state.theme : 'dark'
}

/** `document.documentElement`'s class is always exactly this, replacing the old hardcoded */
export function themeClassName(id: ThemeId): string {
 return `theme-${id}`
}

let appliedProps: string[] = []

function applyTheme(state: Pick<ThemeState, 'theme' | 'customId' | 'customThemes'>): void {
 const next = themeClassName(activeThemeId(state))
 const root = document.documentElement
 for (const cls of Array.from(root.classList)) {
  if (cls.startsWith('theme-') && cls !== next) root.classList.remove(cls)
 }
 root.classList.add('dark', next)
 clearTokens(root, appliedProps)
 const custom = activeCustomTheme(state)
 appliedProps = custom ? applyTokens(root, custom.tokens) : []
}

useThemeStore.subscribe((state) => {
 applyTheme(state)
})

/** Seeds this store from the synchronous bootstrap and applies the matching class and tokens. */
export function initThemeStore(theme: ThemeId, custom?: CustomTheme | null): void {
 useThemeStore.setState({ theme, customId: custom?.id ?? null, customThemes: custom ? [custom] : [] })
 applyTheme(useThemeStore.getState())
}

/** Convenience hook for a component that only needs to know what to render/highlight right now */
export function useActiveThemeId(): ThemeId {
 return useThemeStore(activeThemeId)
}
