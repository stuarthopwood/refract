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
import { applySnapshot } from './applySnapshot'

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
    // Quality-gate remediation (round 2, 2026-10-07): clear BEFORE awaiting below (not after),
    // matching `MessageInput.tsx`'s typed-`/new` fix -- main emits the reset patch synchronously
    // before replying (`PatchCoalescer.reset`, SessionAgent), so clearing only after `await` risks
    // the Transcript's landing effect already reading the stale pre-switch offset. Snapshot first
    // so a failed switch can put back exactly what it removed (only if nothing newer has been
    // recorded for this Session meanwhile).
    const previousScroll = useChatScrollStore.getState().bySession[sessionId]
    useChatScrollStore.getState().clear(sessionId)
    // Quality-gate finding (code review, High): also blocks `record()` for this Session for the
    // whole in-flight window below -- see `scroll-store.ts`'s own `inFlight` doc for why the
    // second `clear()` right before `applySnapshot` is no longer sufficient on its own.
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.startNew(sessionId)
      if (!result.ok) {
        useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
        notify(result.error)
        return
      }
      // Finding 4 (gate fixes 4): clears again, right before applying the snapshot -- a scroll
      // the developer made on the still-visible OLD Conversation while this call was in flight
      // would have recorded a detached position for `sessionId` in the gap after the clear
      // above, which the brand-new Conversation (about to render via `applySnapshot` below) would
      // then wrongly inherit as its own restore target (the #485 bug, in a smaller window).
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value)
    } finally {
      setCreating(false)
      setSwitching(false)
      useChatScrollStore.getState().setInFlight(sessionId, false)
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
    // Issue #485: clear BEFORE awaiting below (not after), same reasoning as
    // `handleNewConversation` above.
    useChatScrollStore.getState().clear(sessionId)
    // Quality-gate finding (code review, High): see `handleNewConversation`'s matching comment
    // above -- blocks `record()` for this Session for the whole in-flight window, including the
    // failed-switch recovery race the next comment describes.
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.open(sessionId, file)
      if (!result.ok) {
        // Finding 3 (gate fixes 4): deliberately does NOT call `restoreIfAbsent` here, unlike
        // `handleNewConversation`'s `conversations.startNew` failure above. `openConversation`'s
        // own failure path (`SessionAgent.recoverFromFailedSwitch`) is never a silent no-op the
        // way `startNewConversation`'s immediate `SessionNotIdleError` throw is: on a failed
        // reattach verification it ALSO re-switches back to the previous Conversation, reloads
        // its history, and flushes a fresh `transcript:patch` (a real re-landing) BEFORE this
        // `await` ever rejects -- or, if that recovery also fails, stops the process and emits
        // its own stopped/start-failed patch instead. Either way a landing effect driven by that
        // patch's generation bump runs (and records its own settled position) WHILE this
        // function is still suspended on the awaited promise, racing a `restoreIfAbsent` call
        // here in a way that depends on raw IPC timing: the landing's own `record()` call almost
        // always wins (same-tick in practice), silently making `restoreIfAbsent` a no-op. Rather
        // than ship a restore that only sometimes takes effect, the deterministic rule here is:
        // a failed `conversations.open` always lands at the end of wherever recovery leaves the
        // Session (the reloaded previous Conversation, or nothing if unrecoverable) -- documented
        // in docs/DESIGN.md's "Scroll landing" bullet, not silently restored.
        notify(result.error)
        return
      }
      // Finding 4 (gate fixes 4): see `handleNewConversation`'s matching comment above.
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value)
      setHistoryOpen(false)
    } finally {
      setSwitching(false)
      useChatScrollStore.getState().setInFlight(sessionId, false)
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
