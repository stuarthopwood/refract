// Side chat panel (spec 014): the fourth right-pane tenant. Slice 1 (T006) shipped the shell
// only; Slice 2 (T017) wired it to `useSideChatStore`'s real `ask`/`cancel`/`loadHistory`,
// replacing the stub `onSend` that previously discarded every question silently (gate finding,
// round 1: an inert composer with no RPC behind it violates the project's "an unbuilt feature
// must be hidden entirely" rule). Gate-fix round 2 (Code2/A11y2/Sec2/Verif2): single-flight
// guard, correct `running`/`activeTopicRecordId` tracking, a live region, focus management,
// Retry, and the question rendered right-aligned (spec.md User Story 1 Scenario 2).
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MessageCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { LinkContext, Markdown } from '@/features/chat/Markdown'
import { useRightPaneStore, useSessionsStore, useSideChatStore } from '@/state'
import type { SideChatRecord } from '../../../../shared/frames'

// Gate-fix (live verification, round 1): the zustand selector below used to fall back to a
// freshly-created `[]` literal when `bySession[sessionId]` is absent -- a new array reference on
// every render fails zustand's `useSyncExternalStore` equality check, which re-triggers the
// subscription's render-phase update every single commit, an infinite loop (React error #185,
// "Maximum update depth exceeded") that crashed this panel into its error boundary the instant
// it opened for a Session with no side-chat history loaded yet. A single stable constant fixes
// it: the same reference compares equal to itself across renders.
const EMPTY_RECORDS: SideChatRecord[] = []

/** Gate-fix (round 2, A11y2 HIGH): the text for the one always-mounted polite live region,
 * announced once when the newest transitioning record settles to a final state -- never per
 * streamed `btw_delta` token (FR-012). `null` means "no text for this transition" (nothing to
 * announce, e.g. a record that was never `running`). */
function announcementFor(status: SideChatRecord['status'], error: string | undefined): string | null {
  switch (status) {
    case 'complete':
      return 'Side answer ready'
    case 'cancelled':
      return 'Side question cancelled'
    case 'interrupted':
      return 'Side question interrupted'
    case 'error':
      return `Side question failed: ${error ?? 'unknown error'}`
    default:
      return null
  }
}

interface SideChatPanelProps {
  /** The Session this thread follows -- side chat has no independent binding of its own (unlike
   * Subagents' rail-click ambiguity, FR-005): it always reflects whichever Session the chat pane
   * currently shows (issue://1: "follows the Session shown in its pane"). */
  sessionId: string | null
  /** Wired to `useSideChatStore.getState().ask` (contracts/ipc.md "Side chat"). Required, not
   * optional: a composer must never silently discard a typed question just because nothing is
   * wired behind it (gate finding, round 1). The draft is cleared by the caller's own `send()`
   * ONLY after this resolves without throwing -- a rejected `ask` must never lose the question
   * the developer typed. */
  onSend: (question: string) => Promise<void>
}

export function SideChatPanel({ sessionId, onSend }: SideChatPanelProps) {
  const unavailableHintId = useId()
  const [draft, setDraft] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevStatusesRef = useRef<Record<string, SideChatRecord['status']>>({})
  const announceTimersRef = useRef<{ clear?: number; pending?: number }>({})
  // Gate-fix (round 3, A11y3 Medium): a record that arrives ALREADY terminal -- `ask`'s own
  // `alreadyPatched` race, or a fast model settling before this panel ever rendered it as
  // `running` -- never passed through `prevStatusesRef`'s own "was running, now isn't"
  // transition, so it was silently never announced. `seenIdsRef` tracks every record id this
  // panel has ever observed (seeded once per Session from `loadHistory`'s own OLD rows below,
  // so reopening a Session with history never spuriously announces it); any record not yet in
  // it that arrives already-terminal is announced too, alongside the existing transition rule.
  const seenIdsRef = useRef<Set<string>>(new Set())
  const seededSessionsRef = useRef<Set<string>>(new Set())
  const satisfiedFocusRef = useRef(0)
  const records = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.records ?? EMPTY_RECORDS) : EMPTY_RECORDS))
  const running = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.running ?? false) : false))
  const loadError = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.loadError ?? false) : false))
  const loaded = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.loaded ?? false) : false))
  const loadHistory = useSideChatStore((s) => s.loadHistory)
  const ask = useSideChatStore((s) => s.ask)
  const cancel = useSideChatStore((s) => s.cancel)
  // Gate-fix (round 2, Code2/Sec2 Medium): retries `loadHistory` once the Session's own live
  // status changes (e.g. stopped -> idle) -- a load attempted before the agent started throws
  // `agent-not-running` and leaves `loaded` false specifically so this effect fires again.
  const sessionStatus = useSessionsStore((s) => s.sessions.find((session) => session.id === sessionId)?.status)
  const sideChatFocusRequestId = useRightPaneStore((s) => s.sideChatFocusRequestId)

  // FR-004: `get_btw_history` once per Session per app run -- the first time this panel opens
  // for a Session it has not yet loaded history for, retried if the Session was not running yet.
  useEffect(() => {
    if (!sessionId || loaded) return
    void loadHistory(sessionId)
  }, [sessionId, loaded, sessionStatus, loadHistory])

  // Gate-fix (round 3, A11y3 Medium): seeds `seenIdsRef` with this Session's OWN history rows
  // the instant `loadHistory` resolves for it, so reopening a Session with old side-chat history
  // never spuriously announces every one of those rows as if newly arrived -- runs once per
  // Session (never re-seeds on a later merge from a live `ask`/`applyPatch` update), and MUST be
  // declared before the announcement effect below so both run, in order, in the same commit.
  useEffect(() => {
    if (!sessionId || !loaded || seededSessionsRef.current.has(sessionId)) return
    seededSessionsRef.current.add(sessionId)
    records.forEach((record) => seenIdsRef.current.add(record.id))
  }, [sessionId, loaded, records])

  // FR-013: focus moves into this composer whenever the rail, the launcher, or `/btw` names this
  // panel (`sideChatFocusRequestId` bumps on every `openPanel('side-chat')` call, including while
  // it is already the active panel). Gate-fix (live re-verification, round 2): a parent/child
  // effect-ordering race -- React runs a child's own effects BEFORE its parent's in the same
  // commit, so a plain synchronous call here lost the race to `RightPaneShell.tsx`'s own
  // generic "focus the newly active panel's content region" effect, which ran straight after
  // and overwrote this with the `tabIndex=-1` wrapper `div` -- `setTimeout(0)` defers this call
  // to the next task, strictly after that effect flush. `satisfiedFocusRef` remembers the last
  // request id this effect actually delivered focus for, so a request is never re-delivered for
  // the same id twice. Gate-fix (round 5, A11y5 Medium): the textarea is NEVER disabled (only
  // Send is gated on `loaded`), so there is no "still-disabled, focus silently no-ops" case to
  // wait for any more -- an earlier round's own `if (!loaded) return` gate (needed when the
  // textarea WAS disabled, before that was removed) stayed behind it, long after the condition
  // it guarded against stopped existing. Left in place, it could defer a focus request
  // indefinitely (e.g. `/btw` on a stopped Session: `ask` fails, `loaded` stays `false`, focus
  // never moves into the panel at all -- then jumps there LATER, mid-task, the moment the
  // Session happens to start from the main composer instead), violating WCAG 2.4.3/3.2.2.
  useEffect(() => {
    if (sideChatFocusRequestId === 0 || sideChatFocusRequestId === satisfiedFocusRef.current) return
    satisfiedFocusRef.current = sideChatFocusRequestId
    const timer = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [sideChatFocusRequestId])

  // A11y (round 2, A11y2 HIGH, FR-012; round 3, A11y3 Medium): announces once per record that
  // settles from `running` to a final state, using the same clear-first-then-set shape as
  // `chatAreaAnnouncer.ts` so a screen reader re-reads even two textually-identical
  // announcements in a row. ALSO announces a record that arrives already-terminal without ever
  // being seen `running` first (`ask`'s own `alreadyPatched` race, or a fast model settling
  // before this panel's own render ever caught it mid-flight) -- `seenIdsRef` (seeded above)
  // distinguishes that case from an OLD history row the panel simply hasn't rendered yet.
  useEffect(() => {
    const prev = prevStatusesRef.current
    let transitioned: SideChatRecord | undefined
    for (const record of records) {
      const wasRunning = prev[record.id] === 'running'
      const neverSeen = !seenIdsRef.current.has(record.id)
      if (record.status !== 'running' && (wasRunning || neverSeen)) transitioned = record
      seenIdsRef.current.add(record.id)
    }
    prevStatusesRef.current = Object.fromEntries(records.map((record) => [record.id, record.status]))
    if (!transitioned) return
    const text = announcementFor(transitioned.status, transitioned.error)
    if (!text) return
    clearTimeout(announceTimersRef.current.clear)
    clearTimeout(announceTimersRef.current.pending)
    setAnnouncement('')
    announceTimersRef.current.pending = setTimeout(() => {
      setAnnouncement(text)
      announceTimersRef.current.clear = setTimeout(() => setAnnouncement(''), 6000)
    }, 0)
  }, [records])

  // Gate-fix (round 3, A11y3 Medium): clears both announcement timers on unmount -- without
  // this, a pending/clear timer from the effect above could still fire `setAnnouncement` after
  // the panel (and this component instance) is gone, a leaked timer with no visible effect but
  // wasted work.
  useEffect(() => {
    return () => {
      clearTimeout(announceTimersRef.current.pending)
      clearTimeout(announceTimersRef.current.clear)
    }
  }, [])

  // Gate-fix (round 4, A11y4 Medium, Verif4 Medium): a new or settling record was never scrolled
  // into view -- a new question (or its own settling answer) could land entirely below the
  // fold with no visible confirmation beyond the (screen-reader-only) live region. Deliberately
  // simple (no vendored scroller, no content-visibility concerns, unlike the main transcript):
  // this panel never virtualises and is rarely more than a handful of records, so a direct
  // `scrollTo` is enough. `prefers-reduced-motion` drops the smooth animation, matching the main
  // transcript's own convention. Gate-fix (round 5, A11y5 Low): also re-runs as a streaming
  // answer's own length grows (previously only `records.length`/the last record's `status` were
  // watched, so a long answer growing below the fold never pulled the view down to follow it).
  // A brand-new row (the developer just sent a question) always scrolls -- the same deliberate
  // action Send/`/btw` already is. For every OTHER update (a status change or streamed growth on
  // the SAME row count), it scrolls only when the developer was already within ~48px of the
  // bottom, so someone who has deliberately scrolled up to re-read an earlier answer is never
  // yanked back down by an unrelated later record settling or streaming.
  const lastRecord = records[records.length - 1]
  const prevRowCountRef = useRef(0)
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !lastRecord) return
    const rowCountChanged = records.length !== prevRowCountRef.current
    prevRowCountRef.current = records.length
    if (!rowCountChanged) {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceFromBottom > 48) return
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    container.scrollTo({ top: container.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [records.length, lastRecord?.status, lastRecord?.answer?.length])

  async function send(): Promise<void> {
    const question = draft.trim()
    if (!question || !sessionId || running || !loaded) return
    try {
      await onSend(question)
      setDraft('')
      // A11y (round 2, A11y2 HIGH): Send becomes `disabled` the instant the draft clears
      // (`disabled={!draft.trim() || ...}` below), and Chromium drops focus from a disabled
      // element straight to `<body>` -- refocus the textarea so focus never leaves the panel.
      textareaRef.current?.focus()
    } catch {
      // Keep the draft: `onSend` (the store's `ask`) already surfaced the failure via toast;
      // the question the developer typed must never vanish for a request that never completed.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      // A11y (round 2, A11y2 Medium, spec.md User Story 5 Scenario 1): Escape cancels a running
      // question with an empty draft (matching the Cancel button); otherwise it mirrors the main
      // composer's own Escape-clears-draft behaviour.
      if (running && !draft && sessionId) {
        void cancel(sessionId)
      } else {
        setDraft('')
      }
    }
  }

  function handleCancelClick(): void {
    if (!sessionId) return
    // A11y (round 2, A11y2 HIGH): the Cancel button only renders while `running`, so it unmounts
    // the instant the cancelled record lands -- focus the textarea BEFORE issuing the cancel so
    // focus never drops to `<body>` when the button disappears out from under it.
    textareaRef.current?.focus()
    void cancel(sessionId)
  }

  function handleRetry(question: string): void {
    if (!sessionId || running || !loaded) return
    // Gate-fix (round 3, A11y3 Medium): the Retry button's own `disabled` (below) matches Send's
    // `running || !loaded` (round 5, Code5/A11y5 Low: Retry used to ignore `!loaded`, so it
    // silently produced only an `agent-not-running` toast on a Session that was not running) --
    // focus the textarea BEFORE issuing the retry, same pattern as `handleCancelClick`, so focus
    // never drops to `<body>`.
    textareaRef.current?.focus()
    void ask(sessionId, question).catch(() => {
      // `ask` already surfaces the failure via toast.
    })
  }

  if (!sessionId) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No Session open</EmptyTitle>
          <EmptyDescription>Open a Session to ask a side question.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <LinkContext.Provider value={sessionId}>
      <div className="flex h-full flex-col">
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {records.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Ask a side question</EmptyTitle>
                <EmptyDescription>Without touching the main conversation.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-4">
              {records.map((record) => (
                <div key={record.id} className="flex flex-col gap-1">
                  <p className="text-right text-sm font-medium">
                    <span className="sr-only">You asked: </span>
                    {record.question}
                  </p>
                  {record.status === 'error' ? (
                    // Spec 014: visible text with an icon, never colour alone. Not `role="alert"`
                    // (gate-fix round 2, A11y2 Medium): an OLD error loaded from history must
                    // never announce assertively just because the panel opened -- only a NEW
                    // error transition is ever announced, through the live region above.
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>
                        <span className="sr-only">Answer: </span>
                        {record.error ?? 'The side question failed.'}
                      </span>
                      {/* FR-008: Retry only for a failure OMP's own contract allows resending --
                          a blank question never reaches OMP at all (rejected client-side before
                          any record exists), so every error record rendered here is resendable. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={running || !loaded}
                        onClick={() => handleRetry(record.question)}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : record.status === 'running' ? (
                    record.answer ? (
                      <Markdown id={record.id} text={record.answer} streaming />
                    ) : (
                      <p className="text-sm text-muted-foreground">Thinking…</p>
                    )
                  ) : record.status === 'cancelled' ? (
                    <p className="text-sm text-muted-foreground">Cancelled.</p>
                  ) : record.status === 'interrupted' ? (
                    <p className="text-sm text-muted-foreground">Interrupted.</p>
                  ) : (
                    // Spec 014: the answer is sanitised markdown through the same shared
                    // Markdown/CodeBlock components the main transcript uses. Gate-fix (round 3,
                    // A11y3 Low): `div`, not `span` -- `Markdown` renders block content
                    // (paragraphs, lists, code blocks), invalid inside an inline `span`.
                    <div>
                      <span className="sr-only">Answer: </span>
                      <Markdown id={record.id} text={record.answer ?? ''} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="no-drag-region shrink-0 border-t border-border p-2">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a side question…"
            aria-label="Side chat question"
            aria-describedby={loaded ? undefined : unavailableHintId}
            className="max-h-48 min-h-16 resize-none overflow-y-auto"
          />
          {!loaded && (
            // Gate-fix (round 4, A11y4 Medium): Send disables with no visible or announced
            // reason while `!loaded` (the Session's agent is not running yet, or a permanent
            // `get_btw_history` failure) -- WCAG 3.3.1/4.1.2. The textarea itself still accepts
            // typing (Enter silently no-ops in `send()`); this line explains why nothing happens.
            // Gate-fix (round 5, A11y5 Low): `loadError` (set by a genuine `get_btw_history`
            // failure, never by `agent-not-running`) picks the honest wording -- the original
            // text kept claiming side chat would become available "once the Session is
            // running" even for a Session that already WAS running when the load itself failed.
            <p id={unavailableHintId} className="mt-1 text-xs text-muted-foreground">
              {loadError ? 'Side chat history could not be loaded.' : 'Side chat is available once the Session is running.'}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            {running && (
              // Spec 014: Cancel issues `btw_cancel` for the running request.
              <Button type="button" variant="outline" size="sm" onClick={handleCancelClick}>
                Cancel
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => void send()} disabled={!draft.trim() || running || !loaded}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </LinkContext.Provider>
  )
}
