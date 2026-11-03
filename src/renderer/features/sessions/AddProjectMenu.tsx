// "Add project" menu (spec 054, #867; UI ruling from ui-architect-v3): one trigger, two text-only
// items -- Local folder… and Clone from GitHub… -- shared by the session list footer and the
// first-run screen. Owns both dialogs so a caller only picks a `variant`.
import { useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, CloudDownloadIcon, FolderOpenIcon, FolderPlusIcon } from 'lucide-react'
import { SIDEBAR_NAV_BUTTON_CLASS } from '@/components/sidebarNavButtonClass'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { AddProjectDialog } from './AddProjectDialog'
import { CloneProjectDialog } from './CloneProjectDialog'

export interface AddProjectMenuProps {
  /** `footer`: ghost, full width, menu opens upward. `first-run`: the screen's primary button. `toolbar`: a ghost button in a section's action row (Home). */
  variant: 'footer' | 'first-run' | 'toolbar'
  side?: 'top' | 'bottom'
  disabled?: boolean
  className?: string
}

const TRIGGER_STYLE: Record<AddProjectMenuProps['variant'], { variant: 'ghost' | 'default'; size?: 'sm'; className: string }> = {
  footer: { variant: 'ghost', className: cn(SIDEBAR_NAV_BUTTON_CLASS, 'w-full text-muted-foreground hover:text-foreground') },
  toolbar: { variant: 'ghost', size: 'sm', className: '' },
  'first-run': { variant: 'default', className: 'flex-1' }
}

export function AddProjectMenu({ variant, side, disabled = false, className }: AddProjectMenuProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openingDialogRef = useRef(false)
  const footer = variant === 'footer'
  const style = TRIGGER_STYLE[variant]
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
            variant={style.variant}
            size={style.size}
            disabled={disabled}
            aria-disabled={disabled}
            data-readiness-primary={variant === 'first-run' ? '' : undefined}
            className={cn(style.className, className)}
          >
            {footer && <FolderPlusIcon aria-hidden className="size-4" />}
            <span className={cn(footer && 'min-w-0 flex-1 truncate text-left')}>Add project</span>
            <Chevron aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={menuSide}
          align="start"
          onCloseAutoFocus={(event) => {
            // Only a menu item that opens a dialog takes focus away; Esc or an outside click lets
            // Radix put it back on the trigger.
            if (openingDialogRef.current) {
              event.preventDefault()
              openingDialogRef.current = false
            }
          }}
        >
          <DropdownMenuItem
            icon={FolderOpenIcon}
            onSelect={() => {
              openingDialogRef.current = true
              setLocalOpen(true)
            }}
          >
            Local folder…
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={CloudDownloadIcon}
            onSelect={() => {
              openingDialogRef.current = true
              setCloneOpen(true)
            }}
          >
            Clone from GitHub…
          </DropdownMenuItem>
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
