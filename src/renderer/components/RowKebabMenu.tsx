import type { LucideIcon } from 'lucide-react'
import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface RowMenuEntry {
  id: string
  label: string
  icon?: LucideIcon
  destructive?: boolean
  onSelect(): void
}

const DESTRUCTIVE = 'text-destructive focus:text-destructive'

/** A row's actions as one list behind a visible kebab and the same list on right-click. */
export function RowKebabMenu({ entries, label, children }: { entries: readonly RowMenuEntry[]; label: string; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-1">
          {children}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={label} className="shrink-0 text-muted-foreground aria-expanded:opacity-100">
                <MoreHorizontalIcon aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {entries.map((e) => (
                <DropdownMenuItem key={e.id} icon={e.icon} className={e.destructive ? DESTRUCTIVE : undefined} onSelect={e.onSelect}>
                  {e.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entries.map((e) => (
          <ContextMenuItem key={e.id} icon={e.icon} className={e.destructive ? DESTRUCTIVE : undefined} onSelect={e.onSelect}>
            {e.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
