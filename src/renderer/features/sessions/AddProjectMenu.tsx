// "Add project" menu (spec 054, #867; UI ruling from ui-architect-v3): one trigger, two text-only
// items -- Local folder... and Clone from GitHub... -- shared by the session list footer and the
// first-run screen. Owns both dialogs so a caller only picks a `variant`.
import { useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, FolderPlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { AddProjectDialog } from './AddProjectDialog'
import { CloneProjectDialog } from './CloneProjectDialog'

export interface AddProjectMenuProps {
  /** `footer`: ghost, full width, menu opens upward. `first-run`: the screen's primary button. */
  variant: 'footer' | 'first-run'
  side?: 'top' | 'bottom'
  disabled?: boolean
  className?: string
}

export function AddProjectMenu({ variant, side, disabled = false, className }: AddProjectMenuProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const footer = variant === 'footer'
  const menuSide = side ?? (footer ? 'top' : 'bottom')
  const Chevron = menuSide === 'top' ? ChevronUpIcon : ChevronDownIcon

  // The dialogs open from a menu item that unmounts with the menu, so Radix has nothing to
  // return focus to; put it back on the trigger ourselves.
  function returnFocus(): void {
    setTimeout(() => triggerRef.current?.focus(), 0)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            variant={footer ? 'ghost' : 'default'}
            disabled={disabled}
            aria-disabled={disabled}
            data-readiness-primary={footer ? undefined : ''}
            className={cn(
              footer
                ? 'h-8 w-full justify-start gap-2 px-2 text-sm text-muted-foreground hover:text-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent'
                : 'flex-1',
              className
            )}
          >
            {footer && <FolderPlusIcon aria-hidden className="size-4" />}
            <span className={cn(footer && 'min-w-0 flex-1 truncate text-left')}>Add project</span>
            <Chevron aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={menuSide} align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuItem onSelect={() => setLocalOpen(true)}>Local folder...</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCloneOpen(true)}>Clone from GitHub...</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddProjectDialog
        open={localOpen}
        onOpenChange={(next) => {
          setLocalOpen(next)
          if (!next) returnFocus()
        }}
      />
      <CloneProjectDialog
        open={cloneOpen}
        onOpenChange={(next) => {
          setCloneOpen(next)
          if (!next) returnFocus()
        }}
      />
    </>
  )
}
