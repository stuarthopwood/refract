import { create } from 'zustand'
import { THEMES } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'
import { notify } from './notify'

interface ThemeState {
  /** Mirrors `Settings.theme`; seeded once from the synchronous bootstrap call `main.tsx`
   * already made before React mounted (data-model.md "Held in memory: theme-store.ts"), so this
   * store's initial state matches the class already on `<html>` -- no flash, no mismatch. Kept
   * in sync afterward by `init-stores.ts`'s `onSettingsChanged` handler (a save from this
   * renderer, or -- once a later spec adds one -- a second window). */
  theme: ThemeId
  /** Non-null only while an unsaved preview (the Appearance section, or later spec 008's
   * profile Theme submenu) is open; never written to `settings.json`. */
  previewing: ThemeId | null
  /** FR-003: live-only preview. `null` reverts to the currently saved `theme`. Also calls
   * `theme.preview` over IPC so main moves the title-bar overlay colour to match -- every other
   * surface repaints from the derived class below, no round trip needed for those. */
  preview(id: ThemeId | null): void
  /** FR-004: persists `id` as the app's lasting choice and clears any open preview. */
  save(id: ThemeId): Promise<void>
  /** FR-005: Cancel, Esc, or navigating away from Settings without saving -- all three are the
   * same one call (research.md decision 7), since the derived class already falls back to the
   * untouched `theme` the moment `previewing` clears. */
  cancelPreview(): void
  /** `init-stores.ts`'s `onSettingsChanged` handler calls this to stay in sync with the
   * persisted value -- never touches `previewing`, which is this renderer's own local, unsaved
   * UI state. */
  setTheme(theme: ThemeId): void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: window.refract.themeBootstrap().theme,
  previewing: null,

  preview: (id) => {
    set({ previewing: id })
    window.refract.theme.preview(id).then(
      (result) => {
        if (!result.ok) notify(result.error)
      },
      (err: unknown) => console.error('theme.preview threw', err)
    )
  },

  save: async (id) => {
    const result = await window.refract.theme.set(id)
    if (result.ok) {
      set({ theme: result.value.theme, previewing: null })
    } else {
      notify(result.error)
    }
  },

  cancelPreview: () => {
    get().preview(null)
  },

  setTheme: (theme) => set({ theme })
}))

/** Data-model.md's derived `activeThemeId`: `previewing` while a preview is open, else `theme`
 * (falling back to `'dark'` if a corrupt/future value ever reached this far -- FR-013's real
 * fallback already runs in main/`SettingsStore.open`; this is a last-resort guard only). Takes a
 * plain `{ theme, previewing }` shape (not the whole store) so it also works as a zustand
 * selector. */
export function activeThemeId(state: Pick<ThemeState, 'theme' | 'previewing'>): ThemeId {
  if (state.previewing) return state.previewing
  return state.theme in THEMES ? state.theme : 'dark'
}

/** `document.documentElement`'s class is always exactly this, replacing the old hardcoded
 * `.dark` (data-model.md). Kept alongside the literal `dark` class (never removed --
 * `globals.css`'s `@custom-variant dark (&:is(.dark *))` drives every shadcn component's
 * `dark:` utility; every built-in theme is dark-toned, so that variant must always match). */
export function themeClassName(id: ThemeId): string {
  return `theme-${id}`
}

/** Convenience hook for a component that only needs to know what to render/highlight right now
 * (`ThemePicker`, `Markdown.tsx`'s code/Mermaid theming) -- re-renders only when the derived id
 * itself changes, not on every unrelated store update. */
export function useActiveThemeId(): ThemeId {
  return useThemeStore(activeThemeId)
}
