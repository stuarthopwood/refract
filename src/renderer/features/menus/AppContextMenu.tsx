import { useCallback, useRef, useState } from 'react'
import { CopyIcon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { textEditItems, type TextEditAction } from '@/features/palette/menuItems'
import { copySelection, runTextFieldAction, type TextField } from './textFieldActions'
import { useBlockNativeContextMenu } from './useBlockNativeContextMenu'

type Target = { kind: 'field'; hasSelection: boolean; editable: boolean; hasText: boolean } | { kind: 'selection' }

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

function textFieldOf(node: EventTarget | null): TextField | null {
  const field = node instanceof Element ? node.closest('input, textarea') : null
  if (field instanceof HTMLTextAreaElement) return field
  return field instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(field.type) ? field : null
}

/**
 * The one themed menu for every right-click no other Refract menu handles: text fields get
 * Cut/Copy/Paste/Select all, selected read-only text gets Copy, anything else gets nothing.
 * Mounted once at the renderer root; it re-dispatches the event at a hidden trigger so Radix
 * positions the menu at the pointer.
 */
export function AppContextMenu() {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const fieldRef = useRef<TextField | null>(null)
  const pendingRef = useRef<TextEditAction | null>(null)
  const copyTextRef = useRef('')
  const [target, setTarget] = useState<Target | null>(null)

  const onUnhandled = useCallback((event: MouseEvent) => {
    const field = textFieldOf(event.target)
    let next: Target | null = null
    if (field) {
      const secret = field instanceof HTMLInputElement && field.type === 'password'
      next = {
        kind: 'field',
        hasSelection: !secret && field.selectionStart !== field.selectionEnd,
        editable: !field.readOnly && !field.disabled,
        hasText: field.value !== ''
      }
    } else if (window.getSelection()?.toString()) {
      next = { kind: 'selection' }
    }
    fieldRef.current = field
    copyTextRef.current = !field
      ? (window.getSelection()?.toString() ?? '')
      : next?.kind === 'field' && next.hasSelection
        ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
        : ''
    if (!next || !triggerRef.current) return
    setTarget(next)
    let { clientX, clientY } = event
    // A keyboard-raised event (Shift+F10, Menu key) carries no pointer position.
    if (clientX === 0 && clientY === 0 && event.target instanceof Element) {
      const rect = event.target.getBoundingClientRect()
      clientX = rect.left
      clientY = rect.bottom
    }
    triggerRef.current.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }))
  }, [])
  useBlockNativeContextMenu(onUnhandled)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span ref={triggerRef} aria-hidden className="pointer-events-none fixed left-0 top-0 size-0" />
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Text editing"
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const field = fieldRef.current
          const action = pendingRef.current
          pendingRef.current = null
          field?.focus()
          if (field && action) void runTextFieldAction(field, action, copyTextRef.current)
          else if (!field && action === 'copy') void copySelection(copyTextRef.current)
        }}
      >
        {target?.kind === 'field' ? (
          textEditItems({ ...target, onSelect: (action) => (pendingRef.current = action) })
        ) : (
          <ContextMenuItem icon={CopyIcon} onSelect={() => (pendingRef.current = 'copy')}>
            Copy
            <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
