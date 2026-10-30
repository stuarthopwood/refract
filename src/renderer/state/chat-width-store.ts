import { create } from 'zustand'
import type { ChatWidth } from '../../shared/chatWidth'
import { notify } from './notify'

interface ChatWidthState {
  chatWidth: ChatWidth
  /** Non-null only while an unsaved Appearance preview is open; never written to `settings.json`. */
  previewing: ChatWidth | null
  preview(width: ChatWidth | null): void
  save(width: ChatWidth): Promise<boolean>
  cancelPreview(): void
  /** Syncs the persisted value without touching the local unsaved `previewing` state. */
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

/** Takes a plain `{ chatWidth, previewing }` shape so it also works as a zustand selector. */
export function activeChatWidth(state: Pick<ChatWidthState, 'chatWidth' | 'previewing'>): ChatWidth {
  return state.previewing ?? state.chatWidth
}

/** Re-renders only when the derived width changes, not on every store update. */
export function useActiveChatWidth(): ChatWidth {
  return useChatWidthStore(activeChatWidth)
}
