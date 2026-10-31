import { create } from 'zustand'
import { toast } from 'sonner'
import { CSS_VARIABLES_SYNTAX_THEME, THEMES, isThemeId } from '../../shared/themes'
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
   if (id !== null) toast.info('Custom theme applied. If it is hard to read, press Ctrl+Shift+0 to reset to Dark.', { id: 'custom-theme-applied' })
   return true
  }
  notify(result.error)
  return false
 },

 refreshCustomThemes: async () => {
  const result = await window.refract.themes.list()
  if (!result.ok) {
   notify(result.error)
   return
  }
  const { themes, rejected } = result.value
  const known = new Set(get().rejected.map((r) => r.file))
  const fresh = rejected.filter((r) => !known.has(r.file))
  if (fresh.length > 0 && listedOnce) {
   toast.error(`Couldn't load ${fresh.length === 1 ? fresh[0]?.file : `${fresh.length} theme files`}. See Settings > Appearance.`, { id: 'theme-rejected' })
  }
  listedOnce = true
  set({ customThemes: themes, rejected })
 },

 setTheme: (theme, customId) => set(customId === undefined ? { theme } : { theme, customId }),

 resetToDark: async () => {
  const ok = await get().save('dark')
  if (ok) toast.success('Theme reset to Dark.', { id: 'theme-reset' })
  return ok
 }
}))

let listedOnce = false

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

function sameCustom(a: CustomTheme | null, b: CustomTheme | null): boolean {
 return a === b || (a !== null && b !== null && a.id === b.id && a.base === b.base && JSON.stringify(a.tokens) === JSON.stringify(b.tokens))
}

useThemeStore.subscribe((state, prev) => {
 if (state.theme === prev.theme && state.customId === prev.customId && sameCustom(activeCustomTheme(state), activeCustomTheme(prev))) return
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

/** Changes whenever the applied theme's colours change (preset, custom pick, or custom token edit). */
export function useThemeKey(): string {
 return useThemeStore((s) => `${s.theme}|${s.customId ?? ''}|${JSON.stringify(activeCustomTheme(s)?.tokens ?? {})}`)
}

/** Shiki theme for code blocks: a custom theme that overrides any syntax token needs the CSS-variables theme. */
export function useSyntaxTheme(): string {
 return useThemeStore((s) => {
  const tokens = activeCustomTheme(s)?.tokens ?? {}
  const overridden = Object.keys(tokens).some((k) => k === 'code-block-fg' || k.startsWith('syntax-'))
  return overridden && activeThemeId(s) !== 'dark-high-contrast' ? CSS_VARIABLES_SYNTAX_THEME : THEMES[activeThemeId(s)].syntaxTheme
 })
}
