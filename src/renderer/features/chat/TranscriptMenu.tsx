import * as React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { actionMenuItem } from '@/features/palette/menuItems'
import { cn } from '@/lib/utils'
import { copyLinkText } from './linkClipboard'
import './transcriptActions'

interface TranscriptMenuProps {
  /** The surface's own items; Copy selection is added in front when text inside is selected. */
  items: React.ReactNode
  /** No menu (a streaming or running surface); the tree stays the same so nothing remounts. */
  disabled?: boolean
  className?: string
  children: React.ReactNode
}

function selectionWithin(root: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) return ''
  return selection.toString()
}

// The one right-click / Shift+F10 / Menu key menu for transcript surfaces (#471). The webview
// raises `contextmenu` on the focused element for the keys, and an inner surface's handler marks
// the event handled so an outer one never opens a second menu. Focus returns to the opener on close.
export function TranscriptMenu({ items, disabled = false, className, children }: TranscriptMenuProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const openerRef = React.useRef<HTMLElement | null>(null)
  const [selected, setSelected] = React.useState('')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled} className="select-text">
        <div
          ref={rootRef}
          className={cn('group/transcript-menu', className)}
          onContextMenu={(event) => {
            if (event.defaultPrevented || disabled) return
            const active = document.activeElement
            const focused = active instanceof HTMLElement && rootRef.current?.contains(active) ? active : null
            // A keyboard-raised event carries no pointer position, so re-raise it at the focused element.
            if (event.clientX === 0 && event.clientY === 0 && event.target instanceof Element) {
              event.preventDefault()
              const rect = (focused ?? event.target).getBoundingClientRect()
              event.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: Math.max(rect.bottom, 1) }))
              return
            }
            openerRef.current = focused
            setSelected(selectionWithin(rootRef.current))
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current
          openerRef.current = null
          if (opener?.isConnected) {
            event.preventDefault()
            opener.focus()
          }
        }}
      >
        {selected !== '' && (
          <>
            {actionMenuItem('transcript.copy-selection', { onSelect: () => void copyLinkText(selected, 'Selection copied', 'Nothing to copy: the selection only contains hidden characters') })}
            <ContextMenuSeparator />
          </>
        )}
        {items}
      </ContextMenuContent>
    </ContextMenu>
  )
}
