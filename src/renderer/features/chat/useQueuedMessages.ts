// Queued-message chip state shared by the Queued panel and the composer's Enter-sends-queued rule
// (issues #540, #591, #598, #1067, #1145). Moved unchanged from MessageInput.tsx: chip identity
// comes ONLY from the real `followUp`/`steering` arrays via `deriveQueuedChips`; `inFlight`
// single-flights Send now/Remove per chip key; the delegated focus handlers plus the layout
// effect restore focus after a real `queue_update` reorders or removes rows. One instance per
// ChatPane, passed to both consumers, so they never disagree on chip keys or busy state.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, RefObject } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { EMPTY_QUEUE, notify, useDraftStore, useQueueStore } from '@/state'
import { queuedChipRpcText } from './imageOnlySend'
import { deriveQueuedChips, EMPTY_CHIP_POOL, type ChipPoolState, type DerivedChip } from './queuedChips'

interface QueuedPanelCollapseState {
  collapsedBySession: Record<string, boolean>
  setCollapsed(sessionId: string, collapsed: boolean): void
}

/** Per-Session collapse state for the Queued panel; in memory only, like the Todo panel's. */
export const useQueuedPanelCollapseStore = create<QueuedPanelCollapseState>((set, get) => ({
  collapsedBySession: {},
  setCollapsed: (sessionId, collapsed) => set({ collapsedBySession: { ...get().collapsedBySession, [sessionId]: collapsed } })
}))

export interface QueuedMessages {
  sessionId: string
  chips: DerivedChip[]
  inFlight: ReadonlyMap<string, 'send' | 'remove'>
  imageOnlyNames: readonly string[] | undefined
  listRef: RefObject<HTMLUListElement | null>
  onFocus: (event: ReactFocusEvent<HTMLUListElement>) => void
  onBlur: (event: ReactFocusEvent<HTMLUListElement>) => void
  sendNow: (chip: DerivedChip) => Promise<void>
  remove: (chip: DerivedChip) => Promise<void>
}

function announce(sessionId: string, message: string): void {
  useDraftStore.getState().announceAttachment(sessionId, message)
}

function focusComposer(sessionId: string): void {
  document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"] [aria-label="Message"]`)?.focus()
}

export function useQueuedMessages(sessionId: string): QueuedMessages {
  const { followUp, steering } = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const imageOnlyNames = useQueueStore((s) => s.imageOnlyBySession[sessionId])
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, 'send' | 'remove'>>(new Map())
  // Last-committed per-occurrence chip id pool: read during render, written only in the layout
  // effect after commit, so a discarded render can never advance it (#598). Reset on a Session
  // change, since ChatPane does not remount this hook per Session.
  const chipPoolRef = useRef<{ sessionId: string; pool: ChipPoolState }>({ sessionId, pool: EMPTY_CHIP_POOL })
  const focusedChipRef = useRef<{ key: string; action: 'send' | 'remove' } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const previousChipsRef = useRef<DerivedChip[]>([])
  const pendingBlurRafRef = useRef<number | null>(null)

  const chips = useMemo<DerivedChip[]>(() => {
    const pool = chipPoolRef.current.sessionId === sessionId ? chipPoolRef.current.pool : EMPTY_CHIP_POOL
    return deriveQueuedChips(followUp, steering, pool).chips
  }, [sessionId, followUp, steering])
  useLayoutEffect(() => {
    const pool = chipPoolRef.current.sessionId === sessionId ? chipPoolRef.current.pool : EMPTY_CHIP_POOL
    chipPoolRef.current = { sessionId, pool: deriveQueuedChips(followUp, steering, pool).nextPool }
  }, [sessionId, followUp, steering])

  // Sole focus-restoration mechanism for the list (#598): handles a user Remove and a
  // server-driven delivery uniformly. A reordered row is moved, not remounted, which Chromium
  // blurs to `<body>`. If the tracked chip survives, focus returns to the same action (falling
  // back to Remove); if it is gone, focus goes to the nearest surviving row's Remove button, or
  // to the composer once no rows remain.
  useLayoutEffect(() => {
    const previousChips = previousChipsRef.current
    previousChipsRef.current = chips
    const tracked = focusedChipRef.current
    if (!tracked) return
    const active = document.activeElement
    const stranded = active == null || active === document.body || !active.isConnected
    if (!stranded) return
    if (chips.some((chip) => chip.key === tracked.key)) {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-chip-key="${CSS.escape(tracked.key)}"]`)
      const target =
        tracked.action === 'send'
          ? (row?.querySelector<HTMLButtonElement>('button[data-chip-action="send"]') ??
            row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]'))
          : row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]')
      target?.focus()
      return
    }
    focusedChipRef.current = null
    if (chips.length === 0) {
      focusComposer(sessionId)
      return
    }
    const previousIndex = previousChips.findIndex((chip) => chip.key === tracked.key)
    const nearest = previousIndex === -1 ? chips[0]! : (chips[previousIndex] ?? chips[previousIndex - 1] ?? chips[0]!)
    const row = listRef.current?.querySelector<HTMLElement>(`[data-chip-key="${CSS.escape(nearest.key)}"]`)
    row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]')?.focus()
  }, [chips, sessionId])

  function onFocus(event: ReactFocusEvent<HTMLUListElement>) {
    const target = event.target as HTMLElement
    const key = target.closest<HTMLElement>('[data-chip-key]')?.getAttribute('data-chip-key')
    const action = target.getAttribute('data-chip-action')
    if (key && (action === 'send' || action === 'remove')) focusedChipRef.current = { key, action }
  }
  // Two causes of a null `relatedTarget`: a DOM move (already repaired by the layout effect
  // above, before any rAF) or a click on something unfocusable (cleared by the pointerdown
  // listener below, or by this deferred check once focus is still on `<body>`) (#598).
  function onBlur(event: ReactFocusEvent<HTMLUListElement>) {
    if (event.relatedTarget) {
      focusedChipRef.current = null
      return
    }
    const el = event.target as HTMLElement
    pendingBlurRafRef.current = requestAnimationFrame(() => {
      pendingBlurRafRef.current = null
      if (document.activeElement === document.body && el.isConnected) focusedChipRef.current = null
    })
  }

  useEffect(() => {
    function onDocumentPointerDown(event: PointerEvent) {
      if (listRef.current?.contains(event.target as Node)) return
      focusedChipRef.current = null
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      if (pendingBlurRafRef.current !== null) cancelAnimationFrame(pendingBlurRafRef.current)
    }
  }, [])

  function settle(chip: DerivedChip) {
    setInFlight((prev) => {
      const next = new Map(prev)
      next.delete(chip.key)
      return next
    })
  }

  // Single-flight per chip key (not text), so two chips sharing text never share a busy state.
  async function remove(chip: DerivedChip) {
    if (inFlight.has(chip.key)) return
    setInFlight((prev) => new Map(prev).set(chip.key, 'remove'))
    const result = await window.refract.chat.removeQueued(sessionId, queuedChipRpcText(chip), chip.queue)
    settle(chip)
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (!result.value.removed) {
      toast.warning('This message is already being delivered and can no longer be removed.')
      return
    }
    announce(sessionId, 'Queued message removed.')
  }

  async function sendNow(chip: DerivedChip) {
    if (inFlight.has(chip.key)) return
    setInFlight((prev) => new Map(prev).set(chip.key, 'send'))
    announce(sessionId, 'Sending now…')
    // `chat.sendNow` takes no `images`: OMP's `promote_queued_message` moves the queued message
    // (attachments included), so the composer's own pending images are never touched.
    const result = await window.refract.chat.sendNow(sessionId, queuedChipRpcText(chip))
    settle(chip)
    if (!result.ok) {
      notify(result.error)
      announce(sessionId, '')
      return
    }
    if (!result.value.promoted) {
      announce(sessionId, '')
      toast.info('This message is no longer queued; it may already have been sent.')
      return
    }
    // OMP promotes by text, FIFO, not by clicked occurrence, so the announcement names the
    // message, not a chip; the real `queue_update` frame moves it to steering.
    announce(sessionId, 'Message will be sent at the next step.')
  }

  return { sessionId, chips, inFlight, imageOnlyNames, listRef, onFocus, onBlur, sendNow, remove }
}
