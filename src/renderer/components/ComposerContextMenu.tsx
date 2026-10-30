import { useRef, useState, type ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { runTextFieldAction } from '@/features/menus/textFieldActions'
import { textEditItems, type TextEditAction } from '@/features/palette/menuItems'

type FieldAction = TextEditAction

interface FieldState {
  hasSelection: boolean
  editable: boolean
  hasText: boolean
}

/** Right-click / Shift+F10 / Menu key menu for a composer text field (#471): Cut, Copy, Paste,
 * Paste as plain text, Select all. Wraps the textarea without changing its layout. */
export function ComposerContextMenu({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<FieldAction | null>(null)
  const [state, setState] = useState<FieldState>({ hasSelection: false, editable: false, hasText: false })

  const field = () => boxRef.current?.querySelector('textarea') ?? null

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const el = field()
        if (!open || !el) return
        setState({ hasSelection: el.selectionStart !== el.selectionEnd, editable: !el.readOnly && !el.disabled, hasText: el.value !== '' })
      }}
    >
      <ContextMenuTrigger asChild>
        <div ref={boxRef} className="contents select-text">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Text editing"
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const el = field()
          const action = pendingRef.current
          pendingRef.current = null
          el?.focus()
          if (el && action) void runTextFieldAction(el, action)
        }}
      >
        {textEditItems({ ...state, onSelect: (action) => (pendingRef.current = action) })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
