import { Fragment, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { EllipsisVerticalIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { ExternalLink } from '@/components/ExternalLink'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface RowMenuEntry {
  id: string
  label: string
  icon?: LucideIcon
  destructive?: boolean
  disabled?: boolean
  /** Renders the entry as a new-tab link (`ExternalLink` opens https only) instead of calling `onSelect`; its own icon replaces `icon`. */
  href?: string
  onSelect?(): void
}

interface MenuParts {
  Item: ComponentType<{ asChild?: boolean; icon?: LucideIcon; disabled?: boolean; variant?: 'default' | 'destructive'; onSelect?(): void; children?: ReactNode }>
  Separator: ComponentType
}

/** The entries as menu items, shared by the kebab DropdownMenu and the pointer ContextMenu. Only https hrefs link; any other scheme renders a disabled item. */
function RowMenuItems({ entries, parts: { Item, Separator } }: { entries: readonly RowMenuEntry[]; parts: MenuParts }) {
  const firstDestructive = entries.findIndex((e) => e.destructive)
  return entries.map((e, i) => {
    const variant = e.destructive ? 'destructive' : undefined
    const linkable = e.href?.startsWith('https://') === true
    return (
      <Fragment key={e.id}>
        {i === firstDestructive && i > 0 && <Separator />}
        {e.href !== undefined && linkable && !e.disabled ? (
          <Item asChild variant={variant}>
            <ExternalLink href={e.href}>{e.label}</ExternalLink>
          </Item>
        ) : (
          <Item icon={e.icon} disabled={e.disabled || (e.href !== undefined && !linkable)} variant={variant} onSelect={e.onSelect}>
            {e.label}
          </Item>
        )}
      </Fragment>
    )
  })
}

const KEBAB_PARTS: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

/** A row's actions as one list behind a visible kebab; right-click on the row (not its `below` content, so that text stays selectable) opens the same items at the pointer. */
export function RowKebabMenu({ entries, label, children, below }: { entries: readonly RowMenuEntry[]; label: string; children: React.ReactNode; below?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="flex items-center gap-1"
              onContextMenu={(event) => {
                // A keyboard-raised event (Shift+F10) has no pointer position, so anchor on the kebab instead.
                if (event.clientX === 0 && event.clientY === 0) {
                  event.preventDefault()
                  setOpen(true)
                }
              }}
            >
              {children}
              <DropdownMenuTrigger asChild>
                <IconButton label={label} size="icon-xs" className="shrink-0 text-muted-foreground">
                  <EllipsisVerticalIcon aria-hidden />
                </IconButton>
              </DropdownMenuTrigger>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <RowMenuItems entries={entries} parts={CONTEXT_PARTS} />
          </ContextMenuContent>
        </ContextMenu>
        {below}
      </div>
      <DropdownMenuContent align="end">
        <RowMenuItems entries={entries} parts={KEBAB_PARTS} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
