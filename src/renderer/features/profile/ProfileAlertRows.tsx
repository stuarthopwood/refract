// Quiet alert rows (low memory, unverified omp version) after <ProfileItem/> (#560).
// Announced via `useChatAreaAnnouncer`, not a local live region: the collapsed nav column is `inert`.
// One effect joins both messages in the same commit, since two `announce()` calls clear each other.
// Dismiss redirects focus at the click site (a Tooltip's delayed Portal cleanup can outlast a retry).
// "Low memory" omits the Session count: `warning.liveAgents` counts non-stopped agents, Triage only idle ones.
import { useEffect, useRef, useState } from 'react'
import { focusProfileItemName, isFocusStranded } from '@/lib/focus'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useAlertDismissStore, useHealthStore, useMemoryStore } from '@/state'
import { AlertRow } from './AlertRow'
import { HealthCheckDialog } from './HealthCheckDialog'
import { MemoryTriageDialog } from './MemoryTriageDialog'
import { UpdateAlertRow, useUpdateRowShown } from './UpdateAlertRow'

export function ProfileAlertRows() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const memoryDismissed = useAlertDismissStore((state) => state.memoryDismissed)
  const ompVersionDismissed = useAlertDismissStore((state) => state.ompVersionDismissed)
  const memoryWasShown = useAlertDismissStore((state) => state.memoryWasShown)
  const ompVersionWasShown = useAlertDismissStore((state) => state.ompVersionWasShown)
  const dismissMemory = useAlertDismissStore((state) => state.dismissMemory)
  const dismissOmpVersion = useAlertDismissStore((state) => state.dismissOmpVersion)
  const setMemoryWasShown = useAlertDismissStore((state) => state.setMemoryWasShown)
  const setOmpVersionWasShown = useAlertDismissStore((state) => state.setOmpVersionWasShown)

  const [triageOpen, setTriageOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)

  const triageButtonRef = useRef<HTMLButtonElement>(null)
  const checkButtonRef = useRef<HTMLButtonElement>(null)
  const memoryRowRef = useRef<HTMLDivElement>(null)
  const ompVersionRowRef = useRef<HTMLDivElement>(null)

  const updateVersion = useUpdateRowShown()
  const memoryShown = warning !== null && !memoryDismissed
  const ompVersionShown = ompVersionWarning !== null && !ompVersionDismissed

  useEffect(() => {
    const memoryJustShown = memoryShown && !memoryWasShown
    const ompVersionJustShown = ompVersionShown && !ompVersionWasShown
    const memoryText = 'Low memory'
    const ompVersionText = ompVersionWarning ? `Agent ${ompVersionWarning.found} is an unverified version` : ''
    if (memoryJustShown && ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(`${memoryText}. ${ompVersionText}`)
    } else if (memoryJustShown) {
      useChatAreaAnnouncer.getState().announce(memoryText)
    } else if (ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(ompVersionText)
    }
    if (memoryShown !== memoryWasShown) setMemoryWasShown(memoryShown)
    if (ompVersionShown !== ompVersionWasShown) setOmpVersionWasShown(ompVersionShown)
  }, [memoryShown, ompVersionShown, memoryWasShown, ompVersionWasShown, ompVersionWarning, setMemoryWasShown, setOmpVersionWasShown])

  /** Redirects focus from a row that just disappeared to the other row's action, else the profile item name. */
  function redirectFocusFrom(hiddenRow: 'memory' | 'ompVersion'): void {
    const fallbackButton = hiddenRow === 'memory' ? checkButtonRef.current : triageButtonRef.current
    const fallbackShown = hiddenRow === 'memory' ? ompVersionShown : memoryShown
    if (fallbackShown && fallbackButton?.isConnected) {
      fallbackButton.focus()
      return
    }
    focusProfileItemName()
  }

  // A self-clearing row: Chromium fires `focusout` before detaching the node, so `isConnected` is
  // checked a frame later (same as FileExplorerPanel). A blank-space click never removes it.
  // Dismiss is handled at its click site below.
  useEffect(() => {
    const rowEl = memoryShown ? memoryRowRef.current : null
    if (!rowEl) return
    function handleFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null
      if (next && rowEl?.contains(next)) return
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!lost || lost.isConnected) return
        if (!isFocusStranded(document.activeElement, rowEl)) return
        redirectFocusFrom('memory')
      })
    }
    rowEl.addEventListener('focusout', handleFocusOut)
    return () => rowEl.removeEventListener('focusout', handleFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShown, ompVersionShown])

  useEffect(() => {
    const rowEl = ompVersionShown ? ompVersionRowRef.current : null
    if (!rowEl) return
    function handleFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null
      if (next && rowEl?.contains(next)) return
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!lost || lost.isConnected) return
        if (!isFocusStranded(document.activeElement, rowEl)) return
        redirectFocusFrom('ompVersion')
      })
    }
    rowEl.addEventListener('focusout', handleFocusOut)
    return () => rowEl.removeEventListener('focusout', handleFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShown, ompVersionShown])

  return (
    <div className={memoryShown || ompVersionShown || updateVersion ? 'flex flex-col gap-1 px-2 pb-2' : 'flex flex-col gap-1'}>
      {updateVersion && <UpdateAlertRow version={updateVersion} />}
      {memoryShown && warning && (
        <AlertRow
          containerRef={memoryRowRef}
          label="Low memory"
          actionRef={triageButtonRef}
          actionLabel="Triage"
          actionAriaLabel="Open memory triage"
          onAction={() => setTriageOpen(true)}
          dismissAriaLabel="Dismiss low memory alert"
          onDismiss={() => {
            redirectFocusFrom('memory')
            dismissMemory()
          }}
        />
      )}
      {ompVersionShown && ompVersionWarning && (
        <AlertRow
          containerRef={ompVersionRowRef}
          label={`Agent ${ompVersionWarning.found}: unverified version`}
          wrapLabel
          actionRef={checkButtonRef}
          actionLabel="Check"
          actionAriaLabel="Open Health check"
          onAction={() => setHealthOpen(true)}
          dismissAriaLabel="Dismiss unverified version alert"
          onDismiss={() => {
            redirectFocusFrom('ompVersion')
            dismissOmpVersion()
          }}
        />
      )}
      <MemoryTriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        onCloseFocus={() => {
          if (triageButtonRef.current?.isConnected) triageButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
      <HealthCheckDialog
        open={healthOpen}
        onOpenChange={setHealthOpen}
        onCloseFocus={() => {
          if (checkButtonRef.current?.isConnected) checkButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
    </div>
  )
}
