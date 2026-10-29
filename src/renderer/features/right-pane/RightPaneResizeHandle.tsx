// The right pane's resize handle (spec 013 FR-025, WCAG 2.5.7). react-resizable-panels already
// gives it Arrow-key steps, Home/End jumps to the limits and double-click to reset to the panel's
// default size; this adds the current width to its accessible name and a context menu (right-click,
// Shift+F10 or the menu key all fire `contextmenu`) offering the preset widths.
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResizableHandle } from '@/components/ui/resizable'
import { useRightPaneStore } from '@/state'
import { PaneWidthContextMenuItems } from './PaneWidthMenu'

export function RightPaneResizeHandle({ disabled }: { disabled: boolean }) {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  const open = useRightPaneStore((s) => s.open)
  const name = open ? `Resize right pane, ${Math.round(widthPx)} pixels wide` : 'Resize right pane, collapsed'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <ResizableHandle withHandle noDragHit aria-label={name} disabled={disabled} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PaneWidthContextMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  )
}
