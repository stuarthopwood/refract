import * as React from 'react'
import { useStageToggleStore } from '../../state/stage-toggle-store'

/** Shared upward-only disclosure for a Stage row and the per-turn Subagent chain row (issue
 * #991 gate round 1: ui-architect-v3 + code-reviewer + test-reviewer, unanimous -- fold the
 * duplicated toggle logic into one hook; research.md decision 18 covers the full rationale for
 * the upward-only rule itself). `autoOpen` is the caller's own computed "should this be open
 * automatically right now" (`isOpenByDefault`/`isUnsettled`): the returned `open` only ever
 * rises on its own, never falls back closed by itself -- only the user's own `onOpenChange` can
 * lower it. The auto-open latch lives in LOCAL component state only (never persisted:
 * recomputing it fresh on every mount is already correct, since a freshly-mounted row re-reads
 * its own live status regardless); only a user's own manual override needs to survive a remount,
 * so that alone is held in `useStageToggleStore`, keyed by session id + row id. A `null`
 * `sessionId` or `rowId` (no session yet, or the chain row's own brief window before its first
 * Stage exists) falls back to local-only state for that render's lifetime, never persisted. */
export function useStickyDisclosure(
  sessionId: string | null,
  rowId: string | null,
  autoOpen: boolean
): { open: boolean; onOpenChange: (next: boolean) => void } {
  const [latchedAutoOpen, setLatchedAutoOpen] = React.useState(autoOpen)
  React.useEffect(() => {
    if (autoOpen) setLatchedAutoOpen(true)
  }, [autoOpen])

  const storedManualOpen = useStageToggleStore((s) => (sessionId != null && rowId != null ? s.bySession[sessionId]?.[rowId] : undefined))
  const setManualOpen = useStageToggleStore((s) => s.setManualOpen)
  const [localManualOpen, setLocalManualOpen] = React.useState<boolean | undefined>(undefined)

  const manualOpen = sessionId != null && rowId != null ? storedManualOpen : localManualOpen
  const open = manualOpen ?? latchedAutoOpen

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (sessionId != null && rowId != null) setManualOpen(sessionId, rowId, next)
      else setLocalManualOpen(next)
    },
    [sessionId, rowId, setManualOpen]
  )

  return { open, onOpenChange }
}
