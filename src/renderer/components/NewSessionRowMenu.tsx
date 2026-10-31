import { useRef, type ReactNode } from 'react'
import { PlayIcon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { requestSessionFromItem } from '@/features/sessions/startSessionRequest'
import type { ItemRef } from '@/features/sessions/startSessionFromItem'

/** Right-click / Shift+F10 / Menu key on a list row: "New session from issue" or "New session from pull request" (#1310). */
export function NewSessionRowMenu({ item, children }: { item: ItemRef; children: ReactNode }) {
  const openerRef = useRef<HTMLElement | null>(null)
  const label = item.kind === 'issue' ? 'New session from issue' : 'New session from pull request'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onContextMenu={(event) => {
            const active = document.activeElement
            openerRef.current = active instanceof HTMLElement && event.currentTarget.contains(active) ? active : null
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
        <ContextMenuItem icon={PlayIcon} onSelect={() => void requestSessionFromItem(item)}>
          {label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
