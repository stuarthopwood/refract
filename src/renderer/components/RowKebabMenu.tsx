import { Fragment, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { EllipsisVerticalIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { MenuItemIcon } from '@/components/ui/menu-item-icon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface RowMenuEntry {
  id: string
  label: string
  icon?: LucideIcon
  destructive?: boolean
  disabled?: boolean
  /** Renders the entry as a new-tab link (http/https only is the caller's job) instead of calling `onSelect`. */
  href?: string
  onSelect?(): void
}

/** A row's actions as one list behind a visible kebab; right-click on the row (not its `below` content, so that text stays selectable) opens the same menu. */
export function RowKebabMenu({ entries, label, children, below }: { entries: readonly RowMenuEntry[]; label: string; children: React.ReactNode; below?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const firstDestructive = entries.findIndex((e) => e.destructive)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div>
        <div
          className="flex items-center gap-1"
          onContextMenu={(event) => {
            event.preventDefault()
            setOpen(true)
          }}
        >
          {children}
          <DropdownMenuTrigger asChild>
            <IconButton label={label} size="icon-xs" className="shrink-0 text-muted-foreground">
              <EllipsisVerticalIcon aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
        </div>
        {below}
      </div>
      <DropdownMenuContent align="end">
        {entries.map((e, i) => (
          <Fragment key={e.id}>
            {i === firstDestructive && i > 0 && <DropdownMenuSeparator />}
            {e.href && !e.disabled ? (
              <DropdownMenuItem asChild variant={e.destructive ? 'destructive' : undefined}>
                <a href={e.href} target="_blank" rel="noreferrer noopener">
                  {e.icon && <MenuItemIcon icon={e.icon} />}{e.label}<span className="sr-only"> (opens in browser)</span>
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={e.icon} disabled={e.disabled} variant={e.destructive ? 'destructive' : undefined} onSelect={e.onSelect}>
                {e.label}
              </DropdownMenuItem>
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
