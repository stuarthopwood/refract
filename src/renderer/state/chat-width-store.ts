import { create } from 'zustand'
import type { ChatWidth } from '../../shared/chatWidth'
import { notify } from './notify'

interface ChatWidthState {
  chatWidth: ChatWidth
  save(width: ChatWidth): Promise<boolean>
  setChatWidth(chatWidth: ChatWidth): void
}

export const useChatWidthStore = create<ChatWidthState>((set) => ({
  chatWidth: 'full',

  save: async (width) => {
    try {
      const result = await window.refract.settings.setChatWidth(width)
      if (result.ok) {
        set({ chatWidth: result.value.chatWidth })
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

  setChatWidth: (chatWidth) => set({ chatWidth })
}))

/** Takes a plain `{ chatWidth }` shape so it also works as a zustand selector. */
export function activeChatWidth(state: Pick<ChatWidthState, 'chatWidth'>): ChatWidth {
  return state.chatWidth
}

/** Re-renders only when the derived width changes, not on every store update. */
export function useActiveChatWidth(): ChatWidth {
  return useChatWidthStore(activeChatWidth)
}
