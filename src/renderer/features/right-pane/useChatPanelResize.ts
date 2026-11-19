import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'
import { chatPanelResizeAction, nextChatWidth } from './chat-layout'
import { syncChatCollapsedFromDrag } from './toggle-chat-pane'

interface ChatPanelResizeSetters {
  setChatWidthPx: Dispatch<SetStateAction<number | null>>
  setChatPanelCollapsed: (collapsed: boolean) => void
}

/** The chat panel's `onResize`: tracks its width and applies `chatPanelResizeAction` to the stored state. */
export function useChatPanelResize(chatPanelRef: RefObject<PanelImperativeHandle | null>, { setChatWidthPx, setChatPanelCollapsed }: ChatPanelResizeSetters) {
  return useCallback(
    (size: PanelSize, _id: string | number | undefined, prevSize: PanelSize | undefined) => {
      setChatWidthPx((prev) => nextChatWidth(prev, size.inPixels))
      setChatPanelCollapsed(size.inPixels <= 0)
      const paneState = useRightPaneStore.getState()
      const action = chatPanelResizeAction({
        sizePx: size.inPixels,
        prevSizePx: prevSize?.inPixels,
        view: useViewStore.getState().view,
        open: paneState.open,
        chatCollapsed: paneState.chatCollapsed,
        hasSession: useSplitStore.getState().paneSessionIds.length > 0
      })
      if (action === 'hide') syncChatCollapsedFromDrag(true)
      else if (action === 'show') syncChatCollapsedFromDrag(false)
      else if (action === 'restore') chatPanelRef.current?.expand()
    },
    [chatPanelRef, setChatWidthPx, setChatPanelCollapsed]
  )
}
