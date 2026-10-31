import { Fragment, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { MoreVerticalIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface RowMenuEntry {
  id: string
  label: string
  icon?: LucideIcon
  destructive?: boolean
  onSelect(): void
}

/** A row's actions as one list behind a visible kebab; right-click on the row opens the same menu. */
export function RowKebabMenu({ entries, label, children }: { entries: readonly RowMenuEntry[]; label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const firstDestructive = entries.findIndex((e) => e.destructive)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        className="flex items-center gap-1"
        onContextMenu={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        {children}
        <DropdownMenuTrigger asChild>
          <IconButton label={label} size="icon-xs" className="shrink-0 text-muted-foreground aria-expanded:opacity-100">
            <MoreVerticalIcon aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end">
        {entries.map((e, i) => (
          <Fragment key={e.id}>
            {i === firstDestructive && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem icon={e.icon} variant={e.destructive ? 'destructive' : undefined} onSelect={e.onSelect}>
              {e.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
