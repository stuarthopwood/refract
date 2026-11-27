import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useSessionListStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { ConversationInfo } from '../../../shared/model'
import { ConversationDeleteDialog } from '../chat/ConversationDeleteDialog'
import { startNewConversation, switchToConversation } from '../chat/conversationActions'
import { useConversationDelete } from '../chat/useConversationDelete'
import { SessionConversationListView } from './SessionConversationListView'
import {
  conversationEntries,
  entryOf,
  focusNextSessionOpenButton,
  focusSessionOpenButton
} from './conversationTreeFocus'
import { decideConversationEntryKey } from './treeKeyDecision'
import { useSessionConversations } from './useSessionConversations'

// The delete hook also keeps its own list in the history dialog; here the list is re-read on the change event.
const ignoreConversations = () => undefined

const newestFirst = (a: ConversationInfo, b: ConversationInfo) => b.createdAt.localeCompare(a.createdAt)

/** A Session's Conversations as a nested list under its row (#472, FR-194 to FR-196). */
export function SessionConversationTree({ session, tree, onSelect }: { session: SessionSummary; tree: boolean; onSelect(): void }) {
  const sessionId = session.id
  const open = useSessionListStore((state) => state.isConversationListOpen(sessionId))
  const toggle = useSessionListStore((state) => state.toggleConversationList)
  const opening = useSessionsStore((state) => state.openingIds.has(sessionId))
  const { conversations, loading, error, reload } = useSessionConversations(sessionId, open)
  const idle = session.status === 'idle' || session.status === 'stopped'
  const [showAll, setShowAll] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  // Where focus goes once a deleted entry has left the list: a neighbouring Conversation's file, or null for the Session.
  const pendingFocus = useRef<{ file: string | null } | null>(null)

  const sorted = useMemo(() => [...conversations].sort(newestFirst), [conversations])
  const remove = useConversationDelete(sessionId, idle, ignoreConversations, (file) => {
    const entry = conversationEntries(sessionId).find((element) => element.dataset.conversationFile === file)
    const active = document.activeElement
    // Only take focus when it was on the deleted entry (or lost); the delete runs in the background.
    if (!entry || !(entry.contains(active) || active === document.body)) return
    const neighbour = (entry.nextElementSibling ?? entry.previousElementSibling) as HTMLElement | null
    pendingFocus.current = { file: neighbour?.dataset.conversationFile ?? null }
  })

  useEffect(() => {
    if (open && !loading && !error) setTotal(conversations.length)
  }, [open, loading, error, conversations])

  useEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    pendingFocus.current = null
    const next = pending.file === null ? undefined : conversationEntries(sessionId).find((element) => element.dataset.conversationFile === pending.file)
    if (next) next.focus()
    else focusSessionOpenButton(sessionId)
  }, [conversations, sessionId])

  const blockedReason = !idle ? 'The agent is working' : opening ? 'The Session is starting' : switching ? 'Switching conversation…' : null

  const run = useCallback(
    async (action: () => Promise<boolean>) => {
      setSwitching(true)
      try {
        if (await action()) onSelect()
      } finally {
        setSwitching(false)
      }
    },
    [onSelect]
  )
  const handleOpen = useCallback((file: string) => void run(() => switchToConversation(sessionId, file)), [run, sessionId])
  const handleNew = useCallback(() => void run(() => startNewConversation(sessionId)), [run, sessionId])

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const entry = entryOf(event.target)
    const entries = conversationEntries(sessionId)
    const index = entry ? entries.indexOf(entry) : -1
    if (!entry || index === -1) return
    if (event.target === entry && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        entry.querySelector<HTMLElement>('button')?.click()
        return
      }
      if (event.key === 'Delete') {
        const conversation = conversations.find((candidate) => candidate.file === entry.dataset.conversationFile)
        if (conversation) {
          event.preventDefault()
          remove.ask(conversation)
        }
        return
      }
    }
    const target = decideConversationEntryKey(event, index, entries.length)
    if (!target) return
    event.preventDefault()
    if (target.kind === 'entry') entries[target.index]?.focus()
    else if (target.kind === 'session') focusSessionOpenButton(sessionId)
    else focusNextSessionOpenButton(sessionId)
  }

  return (
    <>
      <SessionConversationListView
        sessionId={sessionId}
        sessionName={session.name}
        tree={tree}
        open={open}
        total={total}
        loading={loading}
        error={error}
        conversations={sorted}
        showAll={showAll}
        blockedReason={blockedReason}
        deleting={remove.deleting}
        onToggle={() => toggle(sessionId)}
        onReload={() => void reload()}
        onShowAll={() => setShowAll(true)}
        onNew={handleNew}
        onOpen={handleOpen}
        onDelete={remove.ask}
        onKeyDown={handleKeyDown}
      />
      <p role="status" className="sr-only">
        {remove.status}
      </p>
      <p role="alert" className="sr-only">
        {remove.failure}
      </p>
      <ConversationDeleteDialog remove={remove} />
    </>
  )
}
