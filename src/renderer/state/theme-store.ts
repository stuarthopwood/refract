import { create } from 'zustand'
import { isThemeId } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'
import { notify } from './notify'

interface ThemeState {
 /** Mirrors `Settings.theme`. Seeded with the plain `'dark'` default below -- the same
  * default-then-fill convention every other store in this app already uses (`initStores`) --
  * and then filled once, for real, by `initThemeStore` (called from `main.tsx`, the only place
  * that makes the actual synchronous `theme:bootstrap` IPC round trip). Kept in sync afterward
  * by `init-stores.ts`'s `onSettingsChanged` handler (a save from this renderer, or -- once a
  * later spec adds one -- a second window). */
 theme: ThemeId
 /** Non-null only while an unsaved preview (the Appearance section, or later spec 008's
  * profile Theme submenu) is open; never written to `settings.json`. */
 previewing: ThemeId | null
 /** FR-003: live-only preview. `null` reverts to the currently saved `theme`. Also calls
  * `theme.preview` over IPC so main moves the title-bar overlay colour to match -- every other
  * surface repaints from the module-level class subscription below, no round trip needed for
  * those. Choosing the already-saved theme id is normalized to `null` (FR-002/FR-006 deviation
  * note 2a): otherwise Save/Cancel would stay wrongly enabled for a no-op change. */
 preview(id: ThemeId | null): void
 /** FR-004: persists `id` as the app's lasting choice and clears any open preview. */
 save(id: ThemeId): Promise<void>
 /** FR-005: Cancel, Esc, or navigating away from Settings without saving -- all three are the
  * same one call (research.md decision 7), since the derived class already falls back to the
  * untouched `theme` the moment `previewing` clears. A genuine no-op when nothing is being
  * previewed (quality-gate remediation: the old version's own comment claimed this but the code
  * unconditionally called through to IPC regardless). */
 cancelPreview(): void
 /** `init-stores.ts`'s `onSettingsChanged` handler calls this to stay in sync with the
  * persisted value -- never touches `previewing`, which is this renderer's own local, unsaved
  * UI state. */
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
  const result = await window.refract.theme.set(id)
  if (result.ok) {
   // Quality-gate remediation (HIGH, race): choosing a DIFFERENT theme while this save is
   // still in flight must not have its newer, still-open preview silently clobbered once this
   // earlier save resolves -- only clear `previewing` if it still equals the id this call
   // actually saved.
   set((s) => ({ theme: result.value.theme, previewing: s.previewing === id ? null : s.previewing }))
  } else {
   notify(result.error)
  }
 },

 cancelPreview: () => {
  if (get().previewing === null) return
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
 return isThemeId(state.theme) ? state.theme : 'dark'
}

/** `document.documentElement`'s class is always exactly this, replacing the old hardcoded
 * `.dark` (data-model.md). Kept alongside the literal `dark` class (never removed --
 * `globals.css`'s `@custom-variant dark (&:is(.dark *))` drives every shadcn component's
 * `dark:` utility, both already-mounted and newly rendered; every built-in theme is dark-toned,
 * so that variant must always match). */
export function themeClassName(id: ThemeId): string {
 return `theme-${id}`
}

// CRITICAL remediation (independently confirmed by 3 reviewers + a direct grep): nothing in the
// entire renderer ever touched `<html>`'s class after the one-time bootstrap `main.tsx` used to
// set before React mounted -- `preview()`, `save()`, `cancelPreview()`, `setTheme()` all only
// ever updated this store's own state. Every CSS token keyed off `.theme-<id>` (backgrounds,
// cards, borders, composer, dialogs -- everything except the handful of surfaces that happen to
// read `useActiveThemeId()` directly, like Shiki/Mermaid/the title-bar overlay) stayed frozen on
// whatever theme the window booted with, forever, until a full restart.
//
// Fixed with a single module-level subscription (not a React effect/component -- the class must
// update even if no themed component happens to be mounted/rendered right now): applies exactly
// the derived active theme's class to `<html>`, removing whichever `theme-*` class was there
// before, every time the store's derived active id changes. `initThemeStore` (called once from
// `main.tsx`, replacing its own former direct `classList.add` call) both seeds `theme` from the
// real bootstrap value and applies the initial class from that same value, so the window is
// never shown with a mismatched or unthemed class on its very first paint (FR-012/SC-003) --
// `applyThemeClass` runs unconditionally there, not only on a subsequent change, since
// `useThemeStore.subscribe` only fires on an actual state change and the seeded value may equal
// the `'dark'` the store already defaulted to.
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

/** Seeds this store from the one real `theme:bootstrap` IPC round trip and applies the matching
 * `<html>` class immediately -- call exactly once, from `main.tsx`, before React mounts. Replaces
 * the former duplicate bootstrap call this store's own `create()` initializer used to make (on
 * module import, before `main.tsx`'s own explicit call ran), which doubled the blocking IPC round
 * trip for no benefit; every other store in this app seeds a plain default and fills it once via
 * `initStores`, and this now matches that same convention. */
export function initThemeStore(theme: ThemeId): void {
 useThemeStore.setState({ theme })
 applyThemeClass(activeThemeId(useThemeStore.getState()))
}

/** Convenience hook for a component that only needs to know what to render/highlight right now
 * (`ThemePicker`, `Markdown.tsx`'s code/Mermaid theming) -- re-renders only when the derived id
 * itself changes, not on every unrelated store update. */
export function useActiveThemeId(): ThemeId {
 return useThemeStore(activeThemeId)
}
