// New conversation + Conversation history (docs/DESIGN.md "Layout": "a Conversation switcher
// (history of that Session's Conversations)"; contracts/ipc.md "Conversations"). Both actions
// are available whenever the Session has no live process running a turn -- idle, or stopped
// after a failed reattach (issue #69, data-model.md "Reattach verification": "no message can be
// sent until the user chooses recover or another Conversation") -- never while working or
// needing the user. Opening a history entry applies the returned SessionSnapshot through
// ChatPane's `applySnapshot` so the transcript, queue, and pending requests reload.
import { useState } from 'react'
import { HistoryIcon, PlusIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { notify, useChatScrollStore, useSessionsStore } from '@/state'
import type { ConversationInfo } from '../../../shared/model'
import { applySnapshot } from './ChatPane'

export function ConversationSwitcher({ sessionId }: { sessionId: string }) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const opening = useSessionsStore((s) => s.openingIds.has(sessionId))
  const canSwitch = (status === 'idle' || status === 'stopped') && !opening
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [conversations, setConversations] = useState<ConversationInfo[]>([])

  async function handleNewConversation() {
    setCreating(true)
    setSwitching(true)
    try {
      const result = await window.refract.conversations.startNew(sessionId)
      if (!result.ok) {
        notify(result.error)
        return
      }
      // Issue #485: a Conversation switch always lands at the end, never reusing the
      // Session's remembered scroll offset from a since-replaced Conversation's own content.
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value)
    } finally {
      setCreating(false)
      setSwitching(false)
    }
  }

  async function handleOpenChange(open: boolean) {
    setHistoryOpen(open)
    if (!open) return
    setLoadingHistory(true)
    const result = await window.refract.conversations.list(sessionId)
    setLoadingHistory(false)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setConversations(result.value)
  }

  async function handleOpenConversation(file: string) {
    setSwitching(true)
    try {
      const result = await window.refract.conversations.open(sessionId, file)
      if (!result.ok) {
        notify(result.error)
        return
      }
      // Issue #485: same as `handleNewConversation` above.
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value)
      setHistoryOpen(false)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={!canSwitch || creating || switching}
        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        onClick={() => {
          if (!canSwitch || creating || switching) return
          void handleNewConversation()
        }}
      >
        <PlusIcon />
        New conversation
      </Button>
      <Dialog open={historyOpen} onOpenChange={(open) => void handleOpenChange(open)}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Conversation history">
            <HistoryIcon />
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[70vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conversation history</DialogTitle>
          </DialogHeader>
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earlier Conversations.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {conversations.map((conversation) => (
                <li key={conversation.file}>
                  <button
                    type="button"
                    aria-disabled={!canSwitch || switching || conversation.isCurrent}
                    aria-current={conversation.isCurrent}
                    onClick={() => {
                      if (!canSwitch || switching || conversation.isCurrent) return
                      void handleOpenConversation(conversation.file)
                    }}
                    data-choice-item
                    className="flex w-full flex-col gap-0.5 border-l-2 border-transparent px-2.5 py-2 text-left hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-[current=true]:border-l-active-indicator aria-[current=true]:bg-muted aria-[current=true]:opacity-100"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{conversation.title || 'Untitled conversation'}</span>
                      {conversation.isCurrent && <Badge variant="secondary">Current</Badge>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(conversation.createdAt).toLocaleString()}
                    </span>
                    {conversation.preview && (
                      <span className="truncate text-xs text-muted-foreground">{conversation.preview}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
