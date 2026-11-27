// The profile menu's one update entry (#137): the row content is `UpdateMenuEntryRow`; this wires the selection to `runUpdateMenuAction`.
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { updateMenuEntry } from '@/lib/updateStatus'
import { useUpdateStore } from '@/state'
import { checkForUpdates, downloadUpdate, runUpdateMenuAction } from './updateMenuActions'
import { UpdateMenuEntryRow } from './UpdateMenuEntryRow'

export function UpdateMenuItem({ onUpdateNow }: { onUpdateNow(): void }) {
  const updateState = useUpdateStore((state) => state.state)
  const entry = updateMenuEntry(updateState)
  const busy = entry.action === 'busy'
  return (
    <DropdownMenuItem
      aria-disabled={busy || undefined}
      onSelect={(event) => {
        const ran = runUpdateMenuAction(entry.action, {
          download: () => void downloadUpdate(),
          updateNow: onUpdateNow,
          check: () => void checkForUpdates()
        })
        if (!ran) event.preventDefault()
      }}
    >
      <UpdateMenuEntryRow entry={entry} />
    </DropdownMenuItem>
  )
}
