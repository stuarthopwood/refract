// #1284 (spec 040 FR-001): the Retry line shown while OMP retries a failing model call
// ("Retrying, attempt N of M") with a Stop button that aborts the turn. OMP emits
// `auto_retry_start`/`auto_retry_end` for retryable errors, which Rust folds into `readout.retry`
// (`readout_activity.rs`); the current-work banner and the Session row read the same field.
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { Button } from '@/components/ui/button'
import { PaneBanner } from '../../components/PaneBanner'
import { stopAndRestore } from './restoreQueue'

export function RetryLine({ sessionId }: { sessionId: string }) {
  const retry = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.retry)
  if (!retry) return null

  return (
    <PaneBanner
      severity="warning"
      role="status"
      title={`Retrying, attempt ${retry.attempt} of ${retry.maxAttempts}`}
      data-testid="retry-line"
      className="shrink-0 px-4 py-2"
    >
      <Button type="button" size="xs" variant="outline" onClick={() => void stopAndRestore(sessionId, () => undefined)}>
        Stop
      </Button>
    </PaneBanner>
  )
}
