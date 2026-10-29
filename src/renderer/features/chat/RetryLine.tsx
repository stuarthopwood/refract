// #1284 (spec 040 FR-001): the Retry line shown while OMP retries a failing model call
// ("Retrying, attempt N of M") with a Stop button that aborts the turn. OMP emits
// `auto_retry_start`/`auto_retry_end` for retryable errors, which Rust folds into `readout.retry`
// (`readout_activity.rs`); the Session row reads the same field. The current-work banner leaves
// the retry text to this line so only one retry line shows. Built on the shared `StatusBanner`
// (patterns.md, Status channel), which is `aria-live="off"`: the end of the retry is announced once.
import * as React from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { StatusBanner } from '@/components/StatusBanner'
import { focusSessionPane } from '@/lib/focus'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'
import { stopAndRestore } from './restoreQueue'

export function RetryLine({ sessionId }: { sessionId: string }) {
  const retry = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.retry)
  const announce = useChatAreaAnnouncer((s) => s.announce)
  const wasRetrying = React.useRef(false)
  const focusInside = React.useRef(false)
  const stopping = React.useRef(false)

  React.useEffect(() => {
    if (retry && !wasRetrying.current) announce(`Retrying, attempt ${retry.attempt} of ${retry.maxAttempts}`)
    if (wasRetrying.current && !retry) {
      announce('Retry finished')
      if (focusInside.current) {
        focusInside.current = false
        focusSessionPane(sessionId)
      }
    }
    wasRetrying.current = !!retry
  }, [retry, announce, sessionId])

  async function handleStop() {
    if (stopping.current) return
    stopping.current = true
    try {
      if (await stopAndRestore(sessionId, () => focusSessionPane(sessionId))) focusSessionPane(sessionId)
    } finally {
      stopping.current = false
    }
  }

  return (
    <div
      onFocus={() => {
        focusInside.current = true
      }}
      onBlur={(event) => {
        // A button removed with focus fires blur on a disconnected target: keep the flag then.
        if (event.target instanceof Node && event.target.isConnected) focusInside.current = false
      }}
    >
      <StatusBanner
        label="Retrying"
        testId="retry-line"
        items={
          retry
            ? [
                {
                  id: 'retry',
                  status: (
                    <span className="flex items-center gap-2 text-severity-warning">
                      <TriangleAlertIcon aria-hidden className="size-4" />
                      Retrying
                    </span>
                  ),
                  text: `Attempt ${retry.attempt} of ${retry.maxAttempts}`,
                  action: { label: 'Stop', ariaLabel: 'Stop retrying', variant: 'text', onClick: () => void handleStop() }
                }
              ]
            : []
        }
      />
    </div>
  )
}
