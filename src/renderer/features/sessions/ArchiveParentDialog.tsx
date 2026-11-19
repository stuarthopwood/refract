// The confirm dialog for archiving a Session that has live descendants (#1862, FR-010): the shared
// ConfirmAlertDialog with its secondary action, fed by `useArchiveSession`.
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import type { ArchiveDialogControls } from './useArchiveSession'

export function ArchiveParentDialog({ controls }: { controls: ArchiveDialogControls }) {
  const { model, open, busy, error, choose, close, onCloseAutoFocus } = controls
  if (!model) return null
  return (
    <ConfirmAlertDialog
      open={open}
      busy={busy}
      size="md"
      title={model.title}
      description={
        <>
          Archive all stops these Sessions&apos; agents. Archive parent only leaves them running. Archived Sessions can be restored.
          {model.nestedLine ? ` ${model.nestedLine}` : ''}
        </>
      }
      secondaryLabel="Archive parent only"
      confirmLabel="Archive all"
      busyLabel="Archiving..."
      error={error}
      onCancel={close}
      onSecondary={() => void choose(false)}
      onConfirm={() => void choose(true)}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {model.running.length > 0 && (
        <div className="grid gap-1 text-sm">
          <p className="text-muted-foreground">Running now:</p>
          <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4">
            {model.running.map((entry) => (
              <li key={entry.id} className="break-words [overflow-wrap:anywhere]">
                {entry.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConfirmAlertDialog>
  )
}
