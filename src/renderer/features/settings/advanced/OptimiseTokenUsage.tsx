// "Optimise token usage" (#1581): the Advanced page's primary action. Confirms with the list of
// rows that will change, then resets every token guard value to its default in one write.
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { useTokenGuardStore } from '@/state/token-guard-store'
import type { ChangedRow } from './changedRows'

export function OptimiseTokenUsage({ rows }: { rows: ChangedRow[] }) {
  const resetAll = useTokenGuardStore((s) => s.resetAll)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alreadyOptimised = rows.length === 0

  const confirm = async () => {
    setBusy(true)
    setError(null)
    useTokenGuardStore.setState({ error: null })
    await resetAll()
    setBusy(false)
    const failure = useTokenGuardStore.getState().error
    if (failure) setError(failure)
    else setOpen(false)
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            aria-disabled={alreadyOptimised || undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!alreadyOptimised) setOpen(true)
            }}
          >
            Optimise token usage
          </Button>
        </TooltipTrigger>
        {alreadyOptimised && <TooltipContent>Already optimised</TooltipContent>}
      </Tooltip>
      <ConfirmAlertDialog
        open={open}
        busy={busy}
        title="Optimise token usage?"
        description="These settings go back to their defaults. New Sessions use them; running Sessions are unchanged."
        confirmLabel="Optimise"
        cancelLabel="Cancel"
        error={error}
        bodyLabel="Settings that will change"
        onCancel={() => {
          setOpen(false)
          setError(null)
        }}
        onConfirm={() => void confirm()}
        onCloseAutoFocus={() => buttonRef.current?.focus()}
      >
        <ul className="grid gap-1 text-sm">
          {rows.map((row) => (
            <li key={row.key}>
              {row.label}: {row.from} → {row.to}
            </li>
          ))}
        </ul>
      </ConfirmAlertDialog>
    </>
  )
}
