// The right pane's resize handle (spec 013 FR-025, WCAG 2.5.7). react-resizable-panels already
// gives it Arrow-key steps, Home/End jumps to the limits and double-click to reset to the panel's
// default size; this adds the current width to its accessible name and a context menu (right-click,
// Shift+F10 or the menu key all fire `contextmenu`) offering the preset widths and Hide/Show chat.
// While chat is hidden the handle is disabled, so its menu is pointer-only (right-click) there; "Show chat" stays
// reachable from the keyboard through the rail Chat pane toggle, the palette and Ctrl+Shift+H (spec 137 FR-024).
import { useEffect, useRef } from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResizableHandle } from '@/components/ui/resizable'
import { useRightPaneStore } from '@/state'
import { PaneWidthContextMenuItems } from './PaneWidthMenu'
import { resizeHandleName } from './pane-width-model'
import { nextHandleFocus, shouldRescueHandleFocus } from './resize-handle-focus'
import { useChatPaneHidden } from './toggle-chat-pane'

export function RightPaneResizeHandle({ disabled }: { disabled: boolean }) {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  const open = useRightPaneStore((s) => s.open)
  const chatHidden = useChatPaneHidden()
  const name = resizeHandleName({ open, chatHidden, widthPx })
  const handleDisabled = disabled || chatHidden
  const hadFocus = useRef(false)
  const disabledRef = useRef(handleDisabled)
  disabledRef.current = handleDisabled
  // A drag or arrow key that hides chat disables the handle under focus; the rail toggle that brings chat back takes it.
  useEffect(() => {
    if (!shouldRescueHandleFocus({ handleDisabled, hadFocus: hadFocus.current })) return
    hadFocus.current = false
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-chat-toggle]')?.focus())
  }, [handleDisabled])
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <ResizableHandle
          withHandle
          noDragHit
          aria-label={name}
          disabled={handleDisabled}
          onFocus={() => { hadFocus.current = nextHandleFocus(hadFocus.current, 'focus', disabledRef.current) }}
          onBlur={() => { hadFocus.current = nextHandleFocus(hadFocus.current, 'blur', disabledRef.current) }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PaneWidthContextMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  )
}
