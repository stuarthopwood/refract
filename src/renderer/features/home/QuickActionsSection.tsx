// Home's Quick actions row (#869): New session (a Project picker menu, then the shared New session
// dialog on the chosen Project) and Add project (local or clone, the shared Add project menu).
import { useRef, useState } from 'react'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AddProjectMenu } from '@/features/sessions/AddProjectMenu'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { useRepositoriesStore } from '@/state'

function NewSessionMenu() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openingDialogRef = useRef(false)
  const picked = repositories.find((repository) => repository.id === pickedId)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={repositories.length === 0}>
            <PlusIcon aria-hidden className="size-4" />
            New session
            <ChevronDownIcon aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            // Picking a Project opens a dialog, which owns focus; Esc or an outside click lets Radix restore it.
            if (openingDialogRef.current) {
              event.preventDefault()
              openingDialogRef.current = false
            }
          }}
        >
          {repositories.map((repository) => (
            <DropdownMenuItem
              key={repository.id}
              onSelect={() => {
                openingDialogRef.current = true
                setPickedId(repository.id)
              }}
            >
              {repository.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {picked && (
        <NewSessionDialog
          key={picked.id}
          repository={picked}
          open
          onOpenChange={(next) => {
            if (next) return
            setPickedId(null)
            setTimeout(() => triggerRef.current?.focus(), 0)
          }}
        />
      )}
    </>
  )
}

export function QuickActionsSection() {
  return (
    <ScreenSection title="Quick actions">
      <div className="flex flex-wrap items-center gap-2">
        <NewSessionMenu />
        <AddProjectMenu variant="toolbar" />
      </div>
    </ScreenSection>
  )
}
