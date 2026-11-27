import { useCallback, useEffect, useRef, useState } from 'react'
import { HistoryIcon, PlusIcon } from 'lucide-react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { IconButton } from '@/components/IconButton'
import { DialogError } from '@/components/DialogError'
import { InlineStatus } from '@/components/InlineStatus'
import { cn } from '@/lib/utils'
import { formatByteSize } from '@/lib/formatBytes'
import { notify, useChatScrollStore, useSessionsStore } from '@/state'
import type { ConversationInfo } from '../../../shared/model'
import { applySnapshot } from './applySnapshot'
import { ConversationRow } from './ConversationRow'
import { conversationTitle, historySummary } from './conversationDelete'
import { useConversationDelete } from './useConversationDelete'

export function ConversationSwitcher({ sessionId }: { sessionId: string }) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const opening = useSessionsStore((s) => s.openingIds.has(sessionId))
  const idle = status === 'idle' || status === 'stopped'
  const canSwitch = idle && !opening
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [conversations, setConversations] = useState<ConversationInfo[]>([])
  // Where focus goes once a deleted row has left the list: a neighbouring row's file, or null for the heading.
  const pendingFocus = useRef<{ file: string | null } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const findRow = (file: string) => Array.from(listRef.current?.children ?? []).find((row) => (row as HTMLElement).dataset.conversationFile === file) as HTMLElement | undefined
  const remove = useConversationDelete(sessionId, idle, setConversations, (file) => {
    const row = findRow(file)
    const active = document.activeElement
    // Only take focus when it was on the deleted row (or lost); the delete runs in the background.
    if (!row || !(row.contains(active) || active === document.body)) return
    const neighbour = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null
    pendingFocus.current = { file: neighbour?.dataset.conversationFile ?? null }
  })

  useEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    pendingFocus.current = null
    const openButton = pending.file === null ? null : findRow(pending.file)?.querySelector<HTMLElement>('[data-choice-item]')
    ;(openButton ?? headingRef.current)?.focus()
  }, [conversations])

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
    remove.clearNotice()
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

  const handleOpenConversation = useCallback(
    async (file: string) => {
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
    },
    [sessionId]
  )

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
            <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
              Conversation history
            </DialogTitle>
          </DialogHeader>
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earlier Conversations.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{historySummary(conversations)}</p>
              <ul ref={listRef} className="flex min-w-0 flex-col gap-1">
                {conversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.file}
                    conversation={conversation}
                    openDisabled={!canSwitch || switching || conversation.isCurrent}
                    deleting={remove.deleting.has(conversation.file)}
                    onOpen={handleOpenConversation}
                    onDelete={remove.ask}
                  />
                ))}
              </ul>
            </>
          )}
          <InlineStatus tone="notice" density="compact" className={cn('p-0', !remove.status && 'sr-only')}>
            {remove.status}
          </InlineStatus>
          <DialogError message={remove.failure} />
        </DialogContent>
      </Dialog>
      <ConfirmAlertDialog
        open={remove.target !== null}
        busy={false}
        title={remove.refusal ? 'This Conversation cannot be deleted' : `Delete “${remove.target ? conversationTitle(remove.target) : ''}”?`}
        description={
          remove.refusal ??
          `This removes the Conversation's history file and its attachments (${formatByteSize(remove.target?.sizeBytes ?? 0)}). It cannot be undone.`
        }
        confirmLabel={remove.refusal ? undefined : 'Delete'}
        tone="destructive"
        onCancel={remove.cancel}
        onConfirm={() => void remove.confirm()}
        onCloseAutoFocus={() => false}
      />
    </div>
  )
}
