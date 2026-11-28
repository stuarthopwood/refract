import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { addToChat, askAgent } from './terminalAgent'

// Right-click, Shift+F10 or the Menu key on the terminal. Both items act on the developer's own click and nothing here
// runs by itself (spec 144 FR-018 to FR-021).

type Action = 'add' | 'ask'

interface TerminalContextMenuProps {
  sessionId: string
  tabId: string
  /** The text selected in the terminal now; read when the menu opens, since the menu takes focus away. */
  getSelection(): string
  focusTerminal(): void
  children: ReactNode
}

export function TerminalContextMenu({ sessionId, tabId, getSelection, focusTerminal, children }: TerminalContextMenuProps) {
  const [hasSelection, setHasSelection] = useState(false)
  const selectionRef = useRef('')
  const pendingRef = useRef<Action | null>(null)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) return
        selectionRef.current = getSelection()
        setHasSelection(selectionRef.current.trim() !== '')
      }}
    >
      <ContextMenuTrigger asChild>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Terminal actions"
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          // The shell keeps the keyboard: the menu is a detour, and focus returns to the terminal before the action runs.
          event.preventDefault()
          focusTerminal()
          const action = pendingRef.current
          pendingRef.current = null
          if (action === 'add') addToChat(sessionId, selectionRef.current)
          else if (action === 'ask') void askAgent(sessionId, tabId, selectionRef.current)
        }}
      >
        {/* aria-disabled keeps the item in the menu's keyboard order and announced as unavailable, where `disabled` would drop it. */}
        <ContextMenuItem
          aria-disabled={!hasSelection}
          className={hasSelection ? undefined : 'opacity-50'}
          onSelect={(event) => {
            if (hasSelection) pendingRef.current = 'add'
            else event.preventDefault()
          }}
        >
          Add to chat
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => (pendingRef.current = 'ask')}>Ask agent about this</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
