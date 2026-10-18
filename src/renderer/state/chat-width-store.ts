import { create } from 'zustand'
import type { ChatWidth } from '../../shared/chatWidth'
import { notify } from './notify'

interface ChatWidthState {
  /** Mirrors `Settings.chatWidth`. Seeded with the plain `'full'` default below (the same
   * default-then-fill convention every other store in this app already uses, `initStores`) and
   * kept in sync afterward by `init-stores.ts`'s `onSettingsChanged` handler (a save from this
   * renderer, or -- once a later spec adds one -- a second window), the same dual-store pattern
   * `theme-store.ts` uses for `theme`. */
  chatWidth: ChatWidth
  /** Non-null only while an unsaved preview (the Appearance section) is open; never written to
   * `settings.json`. */
  previewing: ChatWidth | null
  /** Issue #554: live-only preview. Unlike `theme.preview`, this never calls into IPC -- there is
   * no main-process effect to apply for a reading-width preview (no title-bar overlay or similar
   * OS-level surface it needs to move, unlike theme's historical one), so a preview is purely
   * this store's own local state; every consumer (`Transcript.tsx`) reads it through
   * `useActiveChatWidth()` below. Choosing the already-saved width is normalized to `null`
   * (`ThemePicker`'s own FR-002/FR-006 deviation note 2a): otherwise Save/Cancel would stay
   * wrongly enabled for a no-op change. */
  preview(width: ChatWidth | null): void
  /** Persists `width` as the app's lasting choice and clears any open preview. Returns whether it
   * actually succeeded, the same contract `theme-store.ts`'s own `save` uses. */
  save(width: ChatWidth): Promise<boolean>
  /** Cancel, Esc, or navigating away from Settings without saving -- all three are the same one
   * call, matching `theme-store.ts`'s own `cancelPreview`. A genuine no-op when nothing is being
   * previewed. */
  cancelPreview(): void
  /** `init-stores.ts`'s `onSettingsChanged` handler calls this to stay in sync with the
   * persisted value -- never touches `previewing`, this renderer's own local, unsaved UI state. */
  setChatWidth(chatWidth: ChatWidth): void
}

export const useChatWidthStore = create<ChatWidthState>((set, get) => ({
  chatWidth: 'full',
  previewing: null,

  preview: (width) => {
    const normalized = width !== null && width === get().chatWidth ? null : width
    set({ previewing: normalized })
  },

  save: async (width) => {
    try {
      const result = await window.refract.settings.setChatWidth(width)
      if (result.ok) {
        // Quality-gate remediation precedent (theme-store.ts, HIGH, race): choosing a DIFFERENT
        // width while this save is still in flight must not have its newer, still-open preview
        // silently clobbered once this earlier save resolves -- only clear `previewing` if it
        // still equals the width this call actually saved.
        set((s) => ({ chatWidth: result.value.chatWidth, previewing: s.previewing === width ? null : s.previewing }))
        return true
      }
      notify(result.error)
      return false
    } catch (err: unknown) {
      console.error('settings.setChatWidth threw', err)
      notify({ code: 'unsupported', message: 'Could not save chat width.' })
      return false
    }
  },

  cancelPreview: () => {
    if (get().previewing === null) return
    get().preview(null)
  },

  setChatWidth: (chatWidth) => set({ chatWidth })
}))

/** Derived active value: `previewing` while a preview is open, else the saved `chatWidth`. Takes
 * a plain `{ chatWidth, previewing }` shape (not the whole store) so it also works as a zustand
 * selector, the same convention `theme-store.ts`'s own `activeThemeId` uses. */
export function activeChatWidth(state: Pick<ChatWidthState, 'chatWidth' | 'previewing'>): ChatWidth {
  return state.previewing ?? state.chatWidth
}

/** Convenience hook for a component that only needs to know what to render right now
 * (`ChatWidthPicker`, `Transcript.tsx`) -- re-renders only when the derived value itself changes,
 * not on every unrelated store update. */
export function useActiveChatWidth(): ChatWidth {
  return useChatWidthStore(activeChatWidth)
}
