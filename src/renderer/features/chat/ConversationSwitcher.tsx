import { useState } from 'react'
import { HistoryIcon, PlusIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { notify, useChatScrollStore, useSessionsStore } from '@/state'
import type { ConversationInfo } from '../../../shared/model'
import { applySnapshot } from './applySnapshot'
import { IconButton } from '@/components/IconButton'

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
    // Snapshot first so a failed switch can put back exactly what it removed (only if nothing newer
    // has been recorded for this Session meanwhile).
    const previousScroll = useChatScrollStore.getState().bySession[sessionId]
    useChatScrollStore.getState().clear(sessionId)
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.startNew(sessionId)
      if (!result.ok) {
        useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
        notify(result.error)
        return
      }
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
    // Clear BEFORE awaiting below (not after), same reasoning as `handleNewConversation` above.
    useChatScrollStore.getState().clear(sessionId)
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.open(sessionId, file)
      if (!result.ok) {
        notify(result.error)
        return
      }
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value)
      setHistoryOpen(false)
    } finally {
      setSwitching(false)
      useChatScrollStore.getState().setInFlight(sessionId, false)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <HeaderActionButton
        icon={PlusIcon}
        text="New conversation"
        label="New conversation"
        aria-disabled={!canSwitch || creating || switching}
        className="aria-disabled:opacity-50"
        onClick={() => {
          if (!canSwitch || creating || switching) return
          void handleNewConversation()
        }}
      />
      <Dialog open={historyOpen} onOpenChange={(open) => void handleOpenChange(open)}>
        <DialogTrigger asChild>
          <IconButton label="Conversation history">
            <HistoryIcon />
          </IconButton>
        </DialogTrigger>
        <DialogContent className="max-h-[70vh] overflow-x-hidden overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conversation history</DialogTitle>
          </DialogHeader>
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earlier Conversations.</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-1">
              {conversations.map((conversation) => (
                <li key={conversation.file} className="min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild aria-describedby={undefined}>
                      <button
                        type="button"
                        aria-disabled={!canSwitch || switching || conversation.isCurrent}
                        aria-current={conversation.isCurrent}
                        onClick={() => {
                          if (!canSwitch || switching || conversation.isCurrent) return
                          void handleOpenConversation(conversation.file)
                        }}
                        data-choice-item
                        className="flex w-full min-w-0 flex-col gap-1 border-l-2 border-transparent px-2 py-2 text-left outline-none focus-visible:outline-hidden hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-[current=true]:border-l-active-indicator aria-[current=true]:bg-muted aria-[current=true]:opacity-100"
                      >
                        <span className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 truncate">{conversation.title || 'Untitled conversation'}</span>
                          {conversation.isCurrent && <Badge variant="secondary">Current</Badge>}
                        </span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {new Date(conversation.createdAt).toLocaleString()}
                        </span>
                        {conversation.preview && (
                          <span className="truncate text-xs text-muted-foreground">{conversation.preview}</span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      sideOffset={22}
                      collisionPadding={8}
                      className="flex-col items-start [overflow-wrap:anywhere] max-w-[min(20rem,var(--radix-tooltip-content-available-width))]"
                    >
                      <p>{conversation.title || 'Untitled conversation'}</p>
                      <p className="text-muted-foreground">{new Date(conversation.createdAt).toLocaleString()}</p>
                      {conversation.preview && <p className="text-muted-foreground">{conversation.preview}</p>}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
