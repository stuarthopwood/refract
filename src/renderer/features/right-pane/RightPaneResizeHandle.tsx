// The right pane's resize handle (spec 013 FR-025, WCAG 2.5.7). react-resizable-panels already
// gives it Arrow-key steps, Home/End jumps to the limits and double-click to reset to the panel's
// default size; this adds the current width to its accessible name and a context menu (right-click,
// Shift+F10 or the menu key all fire `contextmenu`) offering the preset widths and Hide/Show chat.
// While chat is hidden the handle is disabled but its menu stays, so "Show chat" is reachable (spec 137 FR-024).
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResizableHandle } from '@/components/ui/resizable'
import { useRightPaneStore } from '@/state'
import { PaneWidthContextMenuItems } from './PaneWidthMenu'
import { resizeHandleName } from './pane-width-model'
import { useChatPaneHidden } from './toggle-chat-pane'

export function RightPaneResizeHandle({ disabled }: { disabled: boolean }) {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  const open = useRightPaneStore((s) => s.open)
  const chatHidden = useChatPaneHidden()
  const name = resizeHandleName({ open, chatHidden, widthPx })
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <ResizableHandle withHandle noDragHit aria-label={name} disabled={disabled || chatHidden} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PaneWidthContextMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  )
}
