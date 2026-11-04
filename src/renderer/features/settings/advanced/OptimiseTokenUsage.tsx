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
    try {
      await resetAll()
      const failure = useTokenGuardStore.getState().error
      if (failure) {
        setError('Could not reset the settings. Try again.')
        useTokenGuardStore.setState({ error: null })
      } else setOpen(false)
    } catch {
      setError('Could not reset the settings. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            aria-disabled={alreadyOptimised || undefined}
            aria-describedby={alreadyOptimised ? 'optimise-disabled-reason' : undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!alreadyOptimised) setOpen(true)
            }}
          >
            Optimise token usage
          </Button>
        </TooltipTrigger>
        {alreadyOptimised && <TooltipContent>Already optimised: every setting is at its default.</TooltipContent>}
      </Tooltip>
      {alreadyOptimised && (
        <span id="optimise-disabled-reason" className="sr-only">
          Already optimised: every token setting is at its default.
        </span>
      )}
      <ConfirmAlertDialog
        open={open}
        busy={busy}
        title="Optimise token usage?"
        description="Replaces your values for the settings below with the defaults. New Sessions use them; running Sessions and all other settings are unchanged."
        confirmLabel={`Reset ${rows.length} ${rows.length === 1 ? 'setting' : 'settings'}`}
        busyLabel="Resetting…"
        size="md"
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
        <ul className="grid gap-2 text-sm">
          {rows.map((row) => (
            <li key={row.key} className="grid gap-0.5">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="[overflow-wrap:anywhere]">
                {row.from}
                <span className="whitespace-nowrap">
                  {' '}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only"> to </span>{' '}
                </span>
                {row.to}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmAlertDialog>
    </>
  )
}
