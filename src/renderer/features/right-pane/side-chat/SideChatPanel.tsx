// Side chat panel (spec 014): the fourth right-pane tenant. Slice 1 (T006) shipped the shell
// only; this (Slice 2, T017) wires it to `useSideChatStore`'s real `ask`/`cancel`/`loadHistory`,
// replacing the stub `onSend` that previously discarded every question silently (gate finding,
// round 1: an inert composer with no RPC behind it violates the project's "an unbuilt feature
// must be hidden entirely" rule).
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MessageCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { LinkContext, Markdown } from '@/features/chat/Markdown'
import { useSideChatStore } from '@/state'

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
  const [draft, setDraft] = useState('')
  const loadedSessionRef = useRef<string | null>(null)
  const records = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.records ?? []) : []))
  const running = useSideChatStore((s) => (sessionId ? (s.bySession[sessionId]?.running ?? false) : false))
  const loadHistory = useSideChatStore((s) => s.loadHistory)
  const cancel = useSideChatStore((s) => s.cancel)

  // FR-004: `get_btw_history` once per Session per app run -- the first time this panel opens
  // for a Session it has not yet loaded history for.
  useEffect(() => {
    if (!sessionId || loadedSessionRef.current === sessionId) return
    loadedSessionRef.current = sessionId
    void loadHistory(sessionId)
  }, [sessionId, loadHistory])

  async function send(): Promise<void> {
    const question = draft.trim()
    if (!question || !sessionId) return
    try {
      await onSend(question)
      setDraft('')
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
      // Mirrors the main composer's own Escape behaviour (MessageInput.tsx).
      event.preventDefault()
      setDraft('')
    }
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                  <p className="text-sm font-medium">{record.question}</p>
                  {record.status === 'error' ? (
                    // Spec 014: visible text with an icon, never colour alone.
                    <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
                      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>{record.error ?? 'The side question failed.'}</span>
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
                    // Markdown/CodeBlock components the main transcript uses.
                    <Markdown id={record.id} text={record.answer ?? ''} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="no-drag-region shrink-0 border-t border-border p-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a side question…"
            aria-label="Side chat question"
            className="max-h-48 min-h-16 resize-none overflow-y-auto"
          />
          <div className="mt-2 flex justify-end gap-2">
            {running && (
              // Spec 014: Cancel issues `btw_cancel` for the running request.
              <Button type="button" variant="outline" size="sm" onClick={() => void cancel(sessionId)}>
                Cancel
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => void send()} disabled={!draft.trim()}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </LinkContext.Provider>
  )
}
