// A Settings button that opens a preview of what a cleanup would delete, waits for confirmation, runs it
// and reports the space freed (#2161, FR-189b/d, FR-190). Nothing is deleted before the confirm.
import { useState } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { Button } from '@/components/ui/button'
import type { Result } from '../../../shared/ipc'
import { previewSummary, runSummary, type CleanupPreviewData, type CleanupRunData } from './cleanupPreview'

type Phase = { kind: 'closed' } | { kind: 'loading' } | { kind: 'ready'; data: CleanupPreviewData } | { kind: 'running'; data: CleanupPreviewData } | { kind: 'done'; text: string }

interface CleanupPreviewButtonProps {
  buttonLabel: string
  title: string
  /** Singular noun for the counts: "Conversation", "log folder". */
  noun: string
  confirmLabel: string
  disabled?: boolean
  describedBy?: string
  load(): Promise<Result<CleanupPreviewData>>
  run(): Promise<Result<CleanupRunData>>
}

export function CleanupPreviewButton({ buttonLabel, title, noun, confirmLabel, disabled, describedBy, load, run }: CleanupPreviewButtonProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' })
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setError(null)
    setPhase({ kind: 'loading' })
    const result = await load()
    if (!result.ok) {
      setError(result.error.message)
      setPhase({ kind: 'closed' })
      return
    }
    setPhase({ kind: 'ready', data: result.value })
  }

  async function confirm() {
    if (phase.kind !== 'ready') return
    const { data } = phase
    setError(null)
    setPhase({ kind: 'running', data })
    const result = await run()
    if (!result.ok) {
      setError(result.error.message)
      setPhase({ kind: 'ready', data })
      return
    }
    setPhase({ kind: 'done', text: runSummary(result.value, noun) })
  }

  const data = phase.kind === 'ready' || phase.kind === 'running' ? phase.data : null
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        aria-describedby={describedBy}
        aria-disabled={disabled || phase.kind === 'loading'}
        className="aria-disabled:opacity-50"
        onClick={() => {
          if (!disabled && phase.kind !== 'loading') void open()
        }}
      >
        {buttonLabel}
      </Button>
      {phase.kind === 'closed' && error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
      <ConfirmAlertDialog
        open={data !== null || phase.kind === 'done'}
        busy={phase.kind === 'running'}
        title={title}
        description={phase.kind === 'done' ? phase.text : data ? previewSummary(data, noun) : ''}
        confirmLabel={data && data.items.length > 0 ? confirmLabel : undefined}
        busyLabel="Deleting…"
        tone="destructive"
        error={error}
        onCancel={() => setPhase({ kind: 'closed' })}
        onConfirm={() => void confirm()}
        onCloseAutoFocus={() => false}
      >
        {data && data.items.length > 0 && (
          <ul className="max-h-60 overflow-y-auto text-sm">
            {data.items.map((item) => (
              <li key={item.key} className="flex min-w-0 flex-col py-1">
                <span className="truncate">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </ConfirmAlertDialog>
    </div>
  )
}
