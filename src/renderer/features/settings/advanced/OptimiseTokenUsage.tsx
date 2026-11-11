// "Optimise token usage" (#1581): the Advanced page's primary action. Confirms with the list of
// rows that will change, then resets every token guard value to its default in one write.
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { useTokenGuardStore } from '@/state/token-guard-store'
import type { ChangedRow } from './changedRows'

const RESET_ERROR = 'Could not reset the settings. Try again.'
const ALREADY_OPTIMISED = 'Already optimised: every setting is at its default.'

export function OptimiseTokenUsage({ rows }: { rows: ChangedRow[] }) {
  const resetAll = useTokenGuardStore((s) => s.resetAll)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // Frozen at open so a store update from resetAll() can't empty or reshuffle the list mid-close.
  const [snapshot, setSnapshot] = useState<ChangedRow[]>([])
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
        setError(RESET_ERROR)
        useTokenGuardStore.setState({ error: null })
      } else setOpen(false)
    } catch {
      setError(RESET_ERROR)
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
              if (!alreadyOptimised) {
                setSnapshot(rows)
                setOpen(true)
              }
            }}
          >
            Optimise token usage
          </Button>
        </TooltipTrigger>
        {alreadyOptimised && <TooltipContent>{ALREADY_OPTIMISED}</TooltipContent>}
      </Tooltip>
      {alreadyOptimised && (
        <span id="optimise-disabled-reason" className="sr-only">
          {ALREADY_OPTIMISED}
        </span>
      )}
      <ConfirmAlertDialog
        open={open}
        busy={busy}
        title="Optimise token usage?"
        description="Replaces your values for the settings below with the defaults. Running Sessions pick up the ones that apply live; the rest apply to new Sessions. Settings not listed are unchanged."
        confirmLabel={`Reset ${snapshot.length} ${snapshot.length === 1 ? 'setting' : 'settings'}`}
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
          {snapshot.map((row) => (
            <li key={row.key} className="grid gap-1">
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
