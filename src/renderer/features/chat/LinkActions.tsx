import * as React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/ui/copy-button'
import { copyLinkText } from './linkClipboard'

export interface LinkAction {
  label: string
  onSelect: () => void
}

interface LinkActionsProps {
  /** Exactly what the Copy button and the menu's first item put on the clipboard. */
  copyText: string
  /** Menu label, button accessible name and toast (e.g. "Copy link" / "Copy path"). */
  copyLabel: string
  copiedMessage: string
  /** Items after the Copy item. */
  actions: LinkAction[]
  /** Wraps just the link (not the Copy slot), e.g. in an inline-code chip, so the slot sits outside the chip. */
  wrapLink?: (link: React.ReactNode) => React.ReactNode
  /** Layout-only, for a caller whose link sits in a flex row (e.g. `DiffView`'s truncating header). */
  wrapperClassName?: string
  children: React.ReactNode
}

// Issue #471, chat-links slice: the one wrapper that gives a FINISHED link a hover/focus ghost
// Copy button (not a Tab stop: keyboard users copy through the menu) and a right-click /
// Shift+F10 / Menu key context menu. Callers never render it for an inert, plain-text, nested or
// footnote link. `ContextMenuTrigger` is a plain span, so Radix would return focus to it (not
// focusable) when the menu closes; the focused link is remembered on open and refocused instead.
export function LinkActions({ copyText, copyLabel, copiedMessage, actions, wrapperClassName, wrapLink, children }: LinkActionsProps) {
  const wrapperRef = React.useRef<HTMLSpanElement>(null)
  const openerRef = React.useRef<HTMLElement | null>(null)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          ref={wrapperRef}
          className={cn('group/link select-text', wrapperClassName)}
          onContextMenu={() => {
            const active = document.activeElement
            openerRef.current = active instanceof HTMLElement && wrapperRef.current?.contains(active) ? active : null
          }}
        >
          {wrapLink ? wrapLink(children) : children}
          <CopyButton
            getText={() => copyText}
            label={copyLabel}
            announcement={copiedMessage}
            tabIndex={-1}
            className="pointer-events-none ml-1 size-5 align-middle text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-has-[:focus-visible]/link:pointer-events-auto group-has-[:focus-visible]/link:opacity-100 group-hover/link:pointer-events-auto group-hover/link:opacity-100 group-data-[state=open]/link:pointer-events-auto group-data-[state=open]/link:opacity-100 [&_svg:not([class*='size-'])]:size-3"
          />
        </span>
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
        <ContextMenuItem onSelect={() => void copyLinkText(copyText, copiedMessage)}>{copyLabel}</ContextMenuItem>
        {actions.map((action) => (
          <ContextMenuItem key={action.label} onSelect={action.onSelect}>
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
