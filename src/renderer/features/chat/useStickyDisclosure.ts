import * as React from 'react'
import { useStageToggleStore } from '@/state'

/** The auto-open latch lives in LOCAL component state only (never persisted: recomputing it fresh on every mount is already correct, since a freshly-mounted row re-reads its own live status regardless); only a user's own manual override needs to survive a remount, so that alone is held in `useStageToggleStore`, keyed by session id + row id. */
export function useStickyDisclosure(
  sessionId: string | null,
  rowId: string | null,
  autoOpen: boolean
): { open: boolean; onOpenChange: (next: boolean) => void } {
  // A Stage/chain row's own key is normally stable for its whole mount, so this almost never
  // actually fires; it exists so a future caller that reuses one hook instance across different
  // rows (list virtualization, for example) can never leak one row's own latch into another's.
  const identityKey = `${sessionId}:${rowId}`
  const [latchedIdentityKey, setLatchedIdentityKey] = React.useState(identityKey)
  const [latchedAutoOpen, setLatchedAutoOpen] = React.useState(autoOpen)
  const [localManualOpen, setLocalManualOpen] = React.useState<boolean | undefined>(undefined)
  if (identityKey !== latchedIdentityKey) {
    setLatchedIdentityKey(identityKey)
    setLatchedAutoOpen(autoOpen)
    setLocalManualOpen(undefined)
  }
  React.useEffect(() => {
    if (autoOpen) setLatchedAutoOpen(true)
  }, [autoOpen])

  const storedManualOpen = useStageToggleStore((s) => (sessionId != null && rowId != null ? s.bySession[sessionId]?.[rowId] : undefined))
  const setManualOpen = useStageToggleStore((s) => s.setManualOpen)

  const manualOpen = sessionId != null && rowId != null ? storedManualOpen : localManualOpen
  // ORing in the CURRENT `autoOpen` closes that one-render lag; the effect still matters for the
  // case this read alone cannot cover -- holding `true` on a LATER render where `autoOpen` has
  // already swung back to `false` again.
  const open = manualOpen ?? (latchedAutoOpen || autoOpen)

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (sessionId != null && rowId != null) setManualOpen(sessionId, rowId, next)
      else setLocalManualOpen(next)
    },
    [sessionId, rowId, setManualOpen]
  )

  return { open, onOpenChange }
}
