import * as React from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { actionMenuItem, menuSeparator, type MenuKind } from '@/features/palette/menuItems'
import { cn } from '@/lib/utils'
import { copyLinkText } from './linkClipboard'
import './transcriptActions'

interface TranscriptMenuProps {
  /** The surface's own items, built only while a menu is open; Copy selection is added in front when text inside is selected. */
  items: (kind: MenuKind) => React.ReactNode
  /** No menu (a streaming or running surface); the tree stays the same so nothing remounts. */
  disabled?: boolean
  /** Fires on the first pointer or focus entry, so a surface can mount its hover controls lazily. */
  onArm?: () => void
  className?: string
  children: React.ReactNode
}

/** Renders items only while its menu content is mounted, so a closed menu costs nothing per row. */
function MenuItems({ items, kind }: { items: (kind: MenuKind) => React.ReactNode; kind: MenuKind }) {
  return <>{items(kind)}</>
}

/** The visible More actions trigger for the same items a right-click shows (#1454). */
export function TranscriptKebab({ items, label = 'More actions', className }: { items: (kind: MenuKind) => React.ReactNode; label?: string; className?: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={label} className={cn('shrink-0 text-muted-foreground', className)}>
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <MenuItems items={items} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function selectionWithin(root: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) return ''
  return selection.toString()
}

// The one right-click / Shift+F10 / Menu key menu for transcript surfaces (#471). The webview
// raises `contextmenu` on the focused element for the keys, and an inner surface's handler marks
// the event handled so an outer one never opens a second menu. Focus returns to the opener on close.
export function TranscriptMenu({ items, disabled = false, onArm, className, children }: TranscriptMenuProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const openerRef = React.useRef<HTMLElement | null>(null)
  const [selected, setSelected] = React.useState('')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled} className="select-text">
        <div
          ref={rootRef}
          className={cn('group/transcript-menu', className)}
          onPointerEnter={onArm}
          onFocusCapture={onArm}
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
            {menuSeparator('context')}
          </>
        )}
        <MenuItems items={items} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}
