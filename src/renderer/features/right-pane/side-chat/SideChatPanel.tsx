// Side chat panel (spec 014, Slice 1 T006): the fourth right-pane tenant. This slice ships the
// shell only -- an empty-thread state and a working composer with a stub `onSend`, no RPC wiring
// yet (Slice 2 replaces the stub with `useSideChatStore`'s real `ask`, per tasks.md).
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MessageCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface SideChatPanelProps {
  /** The Session this thread follows -- side chat has no independent binding of its own (unlike
   * Subagents' rail-click ambiguity, FR-005): it always reflects whichever Session the chat pane
   * currently shows (issue://1: "follows the Session shown in its pane"). */
  sessionId: string | null
  /** Slice 1 stub; Slice 2 wires this to `useSideChatStore.getState().ask(sessionId, question)`
   * (tasks.md T017). */
  onSend?: (question: string) => void
}

export function SideChatPanel({ sessionId, onSend }: SideChatPanelProps) {
  const [draft, setDraft] = useState('')

  function send(): void {
    const question = draft.trim()
    if (!question || !sessionId) return
    onSend?.(question)
    setDraft('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto p-4 text-center">
        <MessageCircleIcon aria-hidden className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Ask the agent a side question without touching the main conversation.
        </p>
      </div>
      <div className="no-drag-region shrink-0 border-t border-border p-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a side question…"
          aria-label="Side chat question"
          disabled={!sessionId}
          className="min-h-16 resize-none"
        />
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" onClick={send} disabled={!draft.trim() || !sessionId}>
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
