// Side chat panel (spec 014): the fourth right-pane tenant.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { EraserIcon, MessageCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ComposerActions,
  ComposerBox,
  ComposerField,
  ComposerFooter,
  ComposerSendButton,
  ComposerStopButton,
  ComposerTextarea
} from '@/components/ComposerBox'
import { CopyButton } from '@/components/ui/copy-button'
import { Kbd } from '@/components/ui/kbd'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinkContext, Markdown } from '@/features/chat/Markdown'
import { COMPOSER_MARKDOWN_TEXTAREA_CLASS, ComposerMarkdownMirror, useComposerMarkdownSegments } from '@/features/chat/composerMarkdownMirror'
import { SIDE_CHAT_LOADING_HINT, useRightPaneStore, useSessionsStore, useSideChatStore } from '@/state'
import type { SideChatRecord } from '../../../../shared/frames'

// Stable reference: a fresh `[]` per render fails zustand's equality check and loops (React #185).
const EMPTY_RECORDS: SideChatRecord[] = []

/** Text for the polite live region, announced once when a record settles, never per streamed token (FR-012); `null` means nothing to announce. */
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
  /** The Session this thread follows: whichever one the chat pane shows. */
  sessionId: string | null
  /** Wired to the store's `ask`; the draft clears only after it resolves, so a rejected `ask` never loses the question. */
  onSend: (question: string) => Promise<void>
}

export function SideChatPanel({ sessionId, onSend }: SideChatPanelProps) {
  const unavailableHintId = useId()
  const [draft, setDraft] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mdSegments = useComposerMarkdownSegments(draft, true) // #1170
  const mdMirrorRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (mdSegments && mdMirrorRef.current && textareaRef.current) mdMirrorRef.current.scrollTop = textareaRef.current.scrollTop
  }, [mdSegments, draft])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevStatusesRef = useRef<Record<string, SideChatRecord['status']>>({})
  const announceTimersRef = useRef<{ clear?: number; pending?: number }>({})
  // `seenIdsRef` lets a record that arrives already-terminal be announced, while old history rows (seeded below) are not.
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
  const clearDisplayedThread = useSideChatStore((s) => s.clearDisplayedThread)
  // Retries `loadHistory` when the Session status changes: a load before the agent starts throws `agent-not-running` and leaves `loaded` false.
  const sessionStatus = useSessionsStore((s) => s.sessions.find((session) => session.id === sessionId)?.status)
  const sideChatFocusRequestId = useRightPaneStore((s) => s.sideChatFocusRequestId)

  // FR-004: `get_btw_history` once per Session per app run.
  useEffect(() => {
    if (!sessionId || loaded) return
    void loadHistory(sessionId)
  }, [sessionId, loaded, sessionStatus, loadHistory])

  // Seeds `seenIdsRef` with history rows once per Session so reopening never announces them; must precede the announcement effect.
  useEffect(() => {
    if (!sessionId) return
    // A Conversation change drops `loaded`; re-arm seeding so the reloaded history isn't announced as new (WCAG 4.1.3).
    if (!loaded) {
      seededSessionsRef.current.delete(sessionId)
      return
    }
    if (seededSessionsRef.current.has(sessionId)) return
    seededSessionsRef.current.add(sessionId)
    records.forEach((record) => seenIdsRef.current.add(record.id))
  }, [sessionId, loaded, records])

  // FR-013: focus the composer whenever the panel is named (the request id bumps on every open). Deferred with
  // `setTimeout(0)` because child effects run before the shell's own focus effect, which would overwrite it.
  // The textarea is never disabled, so no `loaded` gate: it could defer focus indefinitely (WCAG 2.4.3/3.2.2).
  useEffect(() => {
    if (sideChatFocusRequestId === 0 || sideChatFocusRequestId === satisfiedFocusRef.current) return
    satisfiedFocusRef.current = sideChatFocusRequestId
    const timer = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [sideChatFocusRequestId])

  // Clear-first-then-set so a screen reader re-reads two identical announcements in a row (as `chatAreaAnnouncer.ts`).
  function announce(text: string): void {
    clearTimeout(announceTimersRef.current.clear)
    clearTimeout(announceTimersRef.current.pending)
    setAnnouncement('')
    announceTimersRef.current.pending = setTimeout(() => {
      setAnnouncement(text)
      announceTimersRef.current.clear = setTimeout(() => setAnnouncement(''), 6000)
    }, 0)
  }

  // Announces once per record that settles from `running`, or arrives already-terminal (an `ask` race or fast model);
  // `seenIdsRef` tells that apart from an old history row (FR-012).
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
    announce(text)
  }, [records])

  // Clear pending timers on unmount so none fires `setAnnouncement` afterwards.
  useEffect(() => {
    return () => {
      clearTimeout(announceTimersRef.current.pending)
      clearTimeout(announceTimersRef.current.clear)
    }
  }, [])

  // A new row always scrolls; other updates (status change, streamed growth) follow only when already within ~48px
  // of the bottom, so a user reading earlier answers isn't yanked down.
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
      // Chromium drops focus from the now-disabled Send to `<body>`; refocus the textarea.
      textareaRef.current?.focus()
    } catch {
      // Keep the draft: `ask` already toasted the failure.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      // Escape cancels a running question with an empty draft, else clears the draft like the main composer.
      if (running && !draft && sessionId) {
        void cancel(sessionId)
      } else {
        setDraft('')
      }
    }
  }

  function handleCancelClick(): void {
    if (!sessionId) return
    // Cancel unmounts when the record lands; focus the textarea first so focus doesn't drop to `<body>`.
    textareaRef.current?.focus()
    void cancel(sessionId)
  }

  function handleRetry(question: string): void {
    if (!sessionId || running || !loaded) return
    // Focus the textarea first so focus doesn't drop to `<body>`.
    textareaRef.current?.focus()
    void ask(sessionId, question).catch(() => {
      // `ask` already surfaces the failure via toast.
    })
  }

  function handleClearThread(): void {
    if (!sessionId) return
    // Clear thread disables itself once records hit 0; focus the textarea first so focus doesn't drop to `<body>`.
    textareaRef.current?.focus()
    clearDisplayedThread(sessionId)
    // A11y (WCAG 4.1.3): a silent clear has no visible confirmation for a screen-reader user.
    announce('Thread cleared.')
  }

  const clearBlocked = running || records.length === 0

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
      <div className="flex min-h-0 flex-1 flex-col">
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        <div ref={scrollContainerRef} data-side-chat-scroll-container className="min-h-0 flex-1 overflow-y-auto p-4">
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
                  <p className="text-right text-sm">
                    <span className="sr-only">You asked: </span>
                    {record.question}
                  </p>
                  {record.status === 'error' ? (
                    // Visible text plus icon, not colour alone; not `role="alert"` so old history errors don't announce assertively.
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <TriangleAlertIcon aria-hidden className="mt-1 size-4 shrink-0" />
                      <span>
                        <span className="sr-only">Answer: </span>
                        {record.error ?? 'The side question failed.'}
                      </span>
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
                    // `div`, not `span`: `Markdown` renders block content, invalid inside an inline span.
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="sr-only">Answer: </span>
                        <Markdown id={record.id} text={record.answer ?? ''} />
                      </div>
                      {record.answer && (
                        <CopyButton getText={() => record.answer ?? ''} label="Copy answer" announcement="Answer copied" className="shrink-0" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="no-drag-region shrink-0 border-t border-border p-2">
          <ComposerBox>
            <ComposerField>
              {mdSegments && <ComposerMarkdownMirror segments={mdSegments} text={draft} mirrorRef={mdMirrorRef} className={running ? 'pr-20' : 'pr-10'} />}
              <ComposerTextarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onScroll={(event) => { if (mdMirrorRef.current) mdMirrorRef.current.scrollTop = event.currentTarget.scrollTop }}
                className={mdSegments ? COMPOSER_MARKDOWN_TEXTAREA_CLASS : undefined}
                onKeyDown={handleKeyDown}
                placeholder="Ask a side question…"
                aria-label="Side chat question"
                aria-describedby={loaded ? undefined : unavailableHintId}
                actionCount={running ? 2 : 1}
              />
              <ComposerActions>
                {running && (
                  <ComposerStopButton label="Cancel side question" tooltip="Cancel" onClick={handleCancelClick} />
                )}
                <ComposerSendButton
                  blocked={!draft.trim() || running || !loaded}
                  onSend={() => void send()}
                  tooltip={<Kbd>Enter</Kbd>}
                  keyShortcuts="Enter"
                  describedBy={loaded ? undefined : unavailableHintId}
                />
              </ComposerActions>
            </ComposerField>
            <ComposerFooter>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear thread"
                    aria-disabled={clearBlocked}
                    className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60 focus-visible:aria-disabled:opacity-100"
                    onClick={() => {
                      if (clearBlocked) return
                      handleClearThread()
                    }}
                  >
                    <EraserIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {running
                    ? 'Wait for the answer to finish'
                    : records.length === 0
                      ? 'Nothing to clear'
                      : 'Hides this thread for now; the next question starts a fresh topic. History returns after a restart or switching conversations.'}
                </TooltipContent>
              </Tooltip>
            </ComposerFooter>
          </ComposerBox>
          {!loaded && (
            // Explains why Send is disabled while `!loaded` (WCAG 3.3.1); `loadError` and the shared hint pick the wording per case.
            <p id={unavailableHintId} className="mt-1 text-xs text-muted-foreground">
              {loadError
                ? 'Side chat history could not be loaded.'
                : sessionStatus === 'stopped'
                  ? 'Side chat is available once the Session is running.'
                  : SIDE_CHAT_LOADING_HINT}
            </p>
          )}
        </div>
      </div>
    </LinkContext.Provider>
  )
}
