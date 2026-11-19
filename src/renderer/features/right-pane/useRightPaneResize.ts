import { useCallback, type RefObject } from 'react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'
import { rightPaneResizeAction } from './chat-layout'
import { resumeHostedPanels, suspendHostedPanels } from './hosted-panel-actions'

/** The right panel's `onResize`: applies `rightPaneResizeAction` to the store and the hosted panels. */
export function useRightPaneResize(chatPanelRef: RefObject<PanelImperativeHandle | null>) {
  return useCallback(
    (size: PanelSize, _id: string | number | undefined, prevSize: PanelSize | undefined) => {
      const paneState = useRightPaneStore.getState()
      const action = rightPaneResizeAction({
        sizePx: size.inPixels,
        prevSizePx: prevSize?.inPixels,
        view: useViewStore.getState().view,
        open: paneState.open,
        chatCollapsed: paneState.chatCollapsed,
        hasSession: useSplitStore.getState().paneSessionIds.length > 0,
        chatPanelCollapsed: chatPanelRef.current?.isCollapsed() === true
      })
      switch (action.kind) {
        case 'resume':
          resumeHostedPanels(paneState.openPanelIds)
          break
        case 'sync-width':
          paneState.setWidth(action.widthPx)
          break
        case 'suspend':
          suspendHostedPanels(paneState.openPanelIds)
          if (action.syncClosed) paneState.syncRenderedState(false, paneState.widthPx)
          break
        case 'sync-open':
          paneState.syncRenderedState(true, action.widthPx)
          resumeHostedPanels(paneState.openPanelIds)
          break
        case 'none':
          break
      }
    },
    [chatPanelRef]
  )
}
