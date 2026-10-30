import { cn } from '@/lib/utils'
import { STATUS_GLYPH, type StatusGlyphKey } from './statusGlyph'


export type RowStatus = 'running' | 'done' | 'error' | 'exited' | 'interrupted' | 'cancelled'

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function toolStatusLabel(status: RowStatus): string {
  return status === 'running'
    ? 'Running'
    : status === 'error'
      ? 'Failed'
      : status === 'exited'
        ? 'Agent exited'
        : status === 'interrupted'
          ? 'Interrupted'
          : status === 'cancelled'
            ? // Issue #911: a muted "Stopped" word, never "Failed"/"Cancelled" -- this is the
              // Reflects the user's own action, not a claim about the call; neutral wording, never red.
              'Stopped'
            : 'Done'
}

const GLYPH_KEY_BY_STATUS: Record<RowStatus, StatusGlyphKey> = {
  running: 'running',
  done: 'neutral-done',
  error: 'error',
  exited: 'neutral-muted',
  interrupted: 'neutral-muted',
  cancelled: 'cancelled'
}

export function StatusIcon({ status }: { status: RowStatus }) {
  const label = toolStatusLabel(status)
  const { Icon, className } = STATUS_GLYPH[GLYPH_KEY_BY_STATUS[status]]
  return (
    <>
      <Icon aria-hidden className={cn('size-4 shrink-0', className)} />
      <span className="sr-only">{label}</span>
    </>
  )
}
