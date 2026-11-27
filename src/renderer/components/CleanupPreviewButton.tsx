// A button that opens a preview of what a bulk deletion would remove, waits for confirmation, runs it
// and reports the outcome. Nothing is deleted before the confirm. Callers shape their own data into
// `CleanupPreview` and the run result into one summary line.
import { useEffect, useRef, useState } from 'react'
import { CompactList, type CompactListItem } from '@/components/CompactList'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { Button } from '@/components/ui/button'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'
import type { Result } from '../../shared/ipc'

export interface CleanupPreview {
  summary: string
  items: CompactListItem[]
}

type Phase = { kind: 'closed' } | { kind: 'loading' } | { kind: 'ready'; preview: CleanupPreview } | { kind: 'running'; preview: CleanupPreview } | { kind: 'done'; summary: string }

interface CleanupPreviewButtonProps {
  buttonLabel: string
  title: string
  /** Names the list of items for assistive tech. */
  listLabel: string
  confirmLabel: string
  disabled?: boolean
  describedBy?: string
  load(): Promise<Result<CleanupPreview>>
  /** Resolves to the one-line outcome shown once the run finishes. */
  run(): Promise<Result<string>>
}

export function CleanupPreviewButton({ buttonLabel, title, listLabel, confirmLabel, disabled, describedBy, load, run }: CleanupPreviewButtonProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' })
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // The confirm button unmounts when the run ends, so focus would fall to the page without this.
  useEffect(() => {
    if (phase.kind === 'done') closeRef.current?.focus()
  }, [phase.kind])

  async function open() {
    setError(null)
    setPhase({ kind: 'loading' })
    const result = await load()
    if (!result.ok) {
      setError(result.error.message)
      setPhase({ kind: 'closed' })
      return
    }
    setPhase({ kind: 'ready', preview: result.value })
  }

  async function confirm() {
    if (phase.kind !== 'ready') return
    const { preview } = phase
    setError(null)
    setPhase({ kind: 'running', preview })
    const result = await run()
    if (!result.ok) {
      setError(result.error.message)
      setPhase({ kind: 'ready', preview })
      return
    }
    setPhase({ kind: 'done', summary: result.value })
  }

  const preview = phase.kind === 'ready' || phase.kind === 'running' ? phase.preview : null
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
        open={preview !== null || phase.kind === 'done'}
        busy={phase.kind === 'running'}
        title={title}
        description={phase.kind === 'done' ? 'Cleanup finished.' : (preview?.summary ?? '')}
        confirmLabel={preview && preview.items.length > 0 ? confirmLabel : undefined}
        busyLabel="Deleting…"
        tone="destructive"
        error={error}
        cancelRef={closeRef}
        onCancel={() => setPhase({ kind: 'closed' })}
        onConfirm={() => void confirm()}
        onCloseAutoFocus={() => false}
      >
        {preview && preview.items.length > 0 && (
          <div tabIndex={0} className={cn('max-h-60 overflow-y-auto', INSET_FOCUS_OUTLINE_CLASS)}>
            <CompactList label={listLabel} items={preview.items} />
          </div>
        )}
        <p role="status" className={cn('text-sm', phase.kind !== 'done' && 'sr-only')}>
          {phase.kind === 'done' ? phase.summary : ''}
        </p>
      </ConfirmAlertDialog>
    </div>
  )
}
