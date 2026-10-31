import { create } from 'zustand'
import type { ChatWidth } from '../../shared/chatWidth'
import { notify } from './notify'

interface ChatWidthState {
  chatWidth: ChatWidth
  save(width: ChatWidth): Promise<boolean>
  setChatWidth(chatWidth: ChatWidth): void
}

let latestSaveId = 0

export const useChatWidthStore = create<ChatWidthState>((set, get) => ({
  chatWidth: 'full',

  save: async (width) => {
    const requestId = ++latestSaveId
    const previous = get().chatWidth
    // Optimistic so a fast A -> B -> A arrow sequence always lands on the last choice.
    set({ chatWidth: width })
    const rollback = () => {
      if (requestId === latestSaveId) set({ chatWidth: previous })
    }
    try {
      const result = await window.refract.settings.setChatWidth(width)
      if (result.ok) {
        // A newer choice is in flight; applying this older result would flip the picker back.
        if (requestId !== latestSaveId) return true
        set({ chatWidth: result.value.chatWidth })
        return true
      }
      rollback()
      notify(result.error)
      return false
    } catch (err: unknown) {
      rollback()
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
