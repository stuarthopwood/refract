import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useSessionListStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { ConversationInfo } from '../../../shared/model'
import { ConversationDeleteDialog } from '../chat/ConversationDeleteDialog'
import { startNewConversation, switchToConversation } from '../chat/conversationActions'
import { useConversationDelete } from '../chat/useConversationDelete'
import { SessionConversationListView, capConversations } from './SessionConversationListView'
import {
  conversationEntries,
  entryOf,
  focusNextSessionOpenButton,
  focusSessionOpenButton
} from './conversationTreeFocus'
import { decideConversationEntryKey } from './treeKeyDecision'
import { useSessionConversations } from './useSessionConversations'

const newestFirst = (a: ConversationInfo, b: ConversationInfo) => b.createdAt.localeCompare(a.createdAt)

/** Where focus goes once the entry it was on has changed: the focused element is gone, or a keyboard action revealed new ones. */
type PendingFocus =
  // The slot a deleted entry left, so its nearest neighbour (next, else previous) takes focus.
  | { kind: 'entry'; index: number }
  // The first Conversation "Show all" revealed.
  | { kind: 'file'; file: string }
  // The reload a keyboard "Retry" started: first entry once it loads.
  | { kind: 'retry' }

/** A Session's Conversations as a nested list under its row. */
export function SessionConversationTree({ session, tree, onSelect }: { session: SessionSummary; tree: boolean; onSelect(): void }) {
  const sessionId = session.id
  const open = useSessionListStore((state) => state.isConversationListOpen(sessionId))
  const toggle = useSessionListStore((state) => state.toggleConversationList)
  const opening = useSessionsStore((state) => state.openingIds.has(sessionId))
  const { conversations, setConversations, loading, error, reload } = useSessionConversations(sessionId, open)
  const idle = session.status === 'idle' || session.status === 'stopped'
  const [showAll, setShowAll] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const pendingFocus = useRef<PendingFocus | null>(null)

  const sorted = useMemo(() => [...conversations].sort(newestFirst), [conversations])
  // The row leaves the list at once rather than when the follow-up read lands, so it cannot be opened in between.
  const remove = useConversationDelete(sessionId, idle, setConversations, (file) => {
    const entries = conversationEntries(sessionId)
    const entry = entries.find((element) => element.dataset.conversationFile === file)
    const active = document.activeElement
    // Only take focus when it was on the deleted entry (or lost); the delete runs in the background.
    if (!entry || !(entry.contains(active) || active === document.body)) return
    pendingFocus.current = { kind: 'entry', index: entries.indexOf(entry) }
  })

  useEffect(() => {
    if (open && !loading && !error) setTotal(conversations.length)
  }, [open, loading, error, conversations])

  useEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    // A reload in flight decides where focus lands, so wait for it.
    if (pending.kind === 'retry' && loading) return
    pendingFocus.current = null
    const entries = conversationEntries(sessionId)
    if (pending.kind === 'retry' && error) {
      // Still failing: the Retry entry keeps focus unless it was lost.
      if (!entries.some((element) => element.contains(document.activeElement))) focusSessionOpenButton(sessionId)
      return
    }
    const next =
      pending.kind === 'file'
        ? entries.find((element) => element.dataset.conversationFile === pending.file)
        : pending.kind === 'entry'
          ? entries[Math.min(pending.index, entries.length - 1)]
          : entries[0]
    if (next) next.focus()
    else focusSessionOpenButton(sessionId)
  }, [conversations, loading, error, showAll, sessionId])

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

  // Activating "Show all" or "Retry" from the keyboard drops that entry, so focus is carried to what it produced.
  function trackKeyboardReveal(entry: HTMLElement): void {
    const action = entry.dataset.conversationAction
    if (action === 'retry') pendingFocus.current = { kind: 'retry' }
    else if (action === 'show-all') {
      const revealed = sorted[capConversations(sorted, false).visible.length]
      if (revealed) pendingFocus.current = { kind: 'file', file: revealed.file }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const entry = entryOf(event.target)
    const entries = conversationEntries(sessionId)
    const index = entry ? entries.indexOf(entry) : -1
    if (!entry || index === -1) return
    if (event.target === entry && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        trackKeyboardReveal(entry)
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

  const deleteInProgress = remove.deleting.size > 0
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
      {/* A closed list mounts none of this: every Session row has a tree, and most are never opened. */}
      {(open || deleteInProgress) && (
        <>
          <p role="status" className="sr-only">
            {remove.status}
          </p>
          <p role="alert" className="sr-only">
            {remove.failure}
          </p>
        </>
      )}
      {(remove.target !== null || deleteInProgress) && <ConversationDeleteDialog remove={remove} />}
    </>
  )
}
