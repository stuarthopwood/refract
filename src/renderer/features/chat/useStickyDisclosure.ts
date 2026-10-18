import * as React from 'react'
import { useStageToggleStore } from '@/state'

/** Shared upward-only disclosure for a Stage row and the per-turn Subagent chain row (issue
 * #991 gate round 1: ui-architect-v3 + code-reviewer + test-reviewer, unanimous -- fold the
 * duplicated toggle logic into one hook; research.md decision 18 covers the full rationale for
 * the upward-only rule itself). `autoOpen` is the caller's own computed "should this be open
 * automatically right now" (`isOpenByDefault`/`isUnsettled`): the returned `open` only ever
 * rises on its own, never falls back closed by itself -- only the user's own `onOpenChange` can
 * lower it, and once they do, that choice wins permanently over any LATER `autoOpen` swing too
 * (issue #991 gate round 1, item 8, decided: a Stage the user closed stays closed even if it
 * later fails -- the failure still surfaces elsewhere, the chain row and the toast/announcer).
 * The auto-open latch lives in LOCAL component state only (never persisted: recomputing it
 * fresh on every mount is already correct, since a freshly-mounted row re-reads its own live
 * status regardless); only a user's own manual override needs to survive a remount, so that
 * alone is held in `useStageToggleStore`, keyed by session id + row id. A `null` `sessionId` or
 * `rowId` (no session yet, or the chain row's own brief window before its first Stage exists --
 * that window never renders any interactive trigger a user could toggle anyway, since the chain
 * row itself returns `null` whenever it has fewer than two Stages) falls back to local-only
 * state for that component's lifetime, never persisted -- dropped on purpose once the row
 * actually mounts with a real key, by design, not a bug. */
export function useStickyDisclosure(
  sessionId: string | null,
  rowId: string | null,
  autoOpen: boolean
): { open: boolean; onOpenChange: (next: boolean) => void } {
  // Gate round 2 fix (issue #991, item 5, LOW, code-reviewer): reset synchronously DURING
  // render when the identity this latch tracks changes (the "adjusting state during rendering"
  // pattern), not in an effect -- an effect-only reset would still show one stale frame of the
  // PREVIOUS row's own latched value before committing the reset. A Stage/chain row's own key
  // is normally stable for its whole mount, so this almost never actually fires; it exists so a
  // future caller that reuses one hook instance across different rows (list virtualization,
  // for example) can never leak one row's own latch into another's.
  const identityKey = `${sessionId}:${rowId}`
  const [latchedIdentityKey, setLatchedIdentityKey] = React.useState(identityKey)
  const [latchedAutoOpen, setLatchedAutoOpen] = React.useState(autoOpen)
  if (identityKey !== latchedIdentityKey) {
    setLatchedIdentityKey(identityKey)
    setLatchedAutoOpen(autoOpen)
  }
  React.useEffect(() => {
    if (autoOpen) setLatchedAutoOpen(true)
  }, [autoOpen])

  const storedManualOpen = useStageToggleStore((s) => (sessionId != null && rowId != null ? s.bySession[sessionId]?.[rowId] : undefined))
  const setManualOpen = useStageToggleStore((s) => s.setManualOpen)
  const [localManualOpen, setLocalManualOpen] = React.useState<boolean | undefined>(undefined)

  const manualOpen = sessionId != null && rowId != null ? storedManualOpen : localManualOpen
  // Gate round 2 fix (issue #991, item 5, LOW, code-reviewer): `latchedAutoOpen || autoOpen`,
  // not `latchedAutoOpen` alone -- the effect above only commits `setLatchedAutoOpen(true)` on
  // the render AFTER `autoOpen` first turns true (effects run post-commit), so reading the latch
  // alone showed one stale closed frame the instant a Stage started running. ORing in the
  // CURRENT `autoOpen` closes that one-render lag; the effect still matters for the case this
  // read alone cannot cover -- holding `true` on a LATER render where `autoOpen` has already
  // swung back to `false` again.
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
