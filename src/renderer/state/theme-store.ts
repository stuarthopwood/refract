import { create } from 'zustand'
import { isThemeId } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'
import { notify } from './notify'

interface ThemeState {
 theme: ThemeId
 previewing: ThemeId | null
 preview(id: ThemeId | null): void
 save(id: ThemeId): Promise<boolean>
 cancelPreview(): void
 setTheme(theme: ThemeId): void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
 theme: 'dark',
 previewing: null,

 preview: (id) => {
  const normalized = id !== null && id === get().theme ? null : id
  set({ previewing: normalized })
  window.refract.theme.preview(normalized).then(
   (result) => {
    if (!result.ok) notify(result.error)
   },
   (err: unknown) => console.error('theme.preview threw', err)
  )
 },

 save: async (id) => {
  try {
   const result = await window.refract.theme.set(id)
   if (result.ok) {
    set((s) => ({ theme: result.value.theme, previewing: s.previewing === id ? null : s.previewing }))
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

 cancelPreview: () => {
  if (get().previewing === null) return
  get().preview(null)
 },

 setTheme: (theme) => set({ theme })
}))

/** Data-model.md's derived `activeThemeId`: */
export function activeThemeId(state: Pick<ThemeState, 'theme' | 'previewing'>): ThemeId {
 if (state.previewing) return state.previewing
 return isThemeId(state.theme) ? state.theme : 'dark'
}

/** `document.documentElement`'s class is always exactly this, replacing the old hardcoded */
export function themeClassName(id: ThemeId): string {
 return `theme-${id}`
}

function applyThemeClass(id: ThemeId): void {
 const next = themeClassName(id)
 const root = document.documentElement
 for (const cls of Array.from(root.classList)) {
  if (cls.startsWith('theme-') && cls !== next) root.classList.remove(cls)
 }
 root.classList.add('dark', next)
}

useThemeStore.subscribe((state) => {
 applyThemeClass(activeThemeId(state))
})

/** Seeds this store from the one real `theme:bootstrap` IPC round trip and applies the matching */
export function initThemeStore(theme: ThemeId): void {
 useThemeStore.setState({ theme })
 applyThemeClass(activeThemeId(useThemeStore.getState()))
}

/** Convenience hook for a component that only needs to know what to render/highlight right now */
export function useActiveThemeId(): ThemeId {
 return useThemeStore(activeThemeId)
}
