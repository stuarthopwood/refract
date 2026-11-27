import { useRef, useState } from 'react'
import { GitBranchIcon } from 'lucide-react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { DialogError } from '@/components/DialogError'
import { IconButton } from '@/components/IconButton'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { CHECKBOX_BOX_ONLY_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { notifyInfo, useChatScrollStore, useDraftStore, useSessionsStore } from '@/state'
import type { ConversationTree, ConversationTreeEntry } from '../../../shared/model'
import { applySnapshot } from './applySnapshot'
import { ConversationTreeRow } from './ConversationTreeRow'
import { FILES_NOT_CHANGED, NOT_IDLE_TREE_REASON, composerTextAfterRewind, saveEntryLabel, treeActionMessage, treeDepths } from './conversationTree'

const REASON_ID = 'conversation-tree-reason'

/** Opens the current Conversation's tree: label an entry, Rewind to it, or Fork a new Conversation from it (#696). */
export function ConversationTreeDialog({ sessionId }: { sessionId: string }) {
  const idle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'idle')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tree, setTree] = useState<ConversationTree | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rewindTarget, setRewindTarget] = useState<ConversationTreeEntry | null>(null)
  const [summarize, setSummarize] = useState(false)
  const [working, setWorking] = useState<'rewind' | 'fork' | null>(null)
  const [actionError, setActionError] = useState<{ entryId: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const focusComposerOnClose = useRef(false)
  const busy = working !== null

  async function loadTree() {
    setLoading(true)
    setLoadError(null)
    const result = await window.refract.conversations.tree(sessionId)
    setLoading(false)
    if (result.ok) setTree(result.value)
    else setLoadError(treeActionMessage(result.error))
  }

  function handleOpenChange(next: boolean) {
    if (!next && busy) return
    setOpen(next)
    if (!next) return
    setActionError(null)
    setNotice(null)
    void loadTree()
  }

  async function handleFork(entry: ConversationTreeEntry) {
    if (busy) return
    setWorking('fork')
    setActionError(null)
    setNotice(null)
    // Cleared before awaiting, like opening a Conversation: the new transcript must not land on the old scroll position.
    const previousScroll = useChatScrollStore.getState().bySession[sessionId]
    useChatScrollStore.getState().clear(sessionId)
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.fork(sessionId, entry.id)
      if (!result.ok) {
        useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
        setActionError({ entryId: entry.id, message: treeActionMessage(result.error) })
        return
      }
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value.snapshot)
      notifyInfo('Forked into a new Conversation. The original stays in the history.')
      setOpen(false)
    } finally {
      setWorking(null)
      useChatScrollStore.getState().setInFlight(sessionId, false)
    }
  }

  async function handleRewind() {
    if (busy || !rewindTarget) return
    const target = rewindTarget
    setWorking('rewind')
    setActionError(null)
    useChatScrollStore.getState().setInFlight(sessionId, true)
    try {
      const result = await window.refract.conversations.rewind(sessionId, target.id, summarize)
      if (!result.ok) {
        setActionError({ entryId: target.id, message: treeActionMessage(result.error) })
        return
      }
      setRewindTarget(null)
      if (result.value.cancelled) {
        setNotice('The summary was cancelled. The Conversation was not changed.')
        return
      }
      useChatScrollStore.getState().clear(sessionId)
      applySnapshot(sessionId, result.value.snapshot)
      const drafts = useDraftStore.getState()
      drafts.setText(sessionId, composerTextAfterRewind(drafts.bySession[sessionId]?.text ?? '', result.value.editorText))
      focusComposerOnClose.current = true
      setOpen(false)
    } finally {
      setWorking(null)
      useChatScrollStore.getState().setInFlight(sessionId, false)
    }
  }

  async function handleLabel(entry: ConversationTreeEntry, draft: string): Promise<string | null> {
    const failure = await saveEntryLabel(window.refract.conversations.label, sessionId, entry, draft)
    if (failure) return failure
    const label = draft.trim() === '' ? null : draft.trim()
    setTree((current) => (current ? { ...current, entries: current.entries.map((e) => (e.id === entry.id ? { ...e, label } : e)) } : current))
    return null
  }

  const depths = tree ? treeDepths(tree.entries) : null

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <IconButton label="Conversation tree">
            <GitBranchIcon />
          </IconButton>
        </DialogTrigger>
        <DialogContent
          className="max-h-[70vh] overflow-x-hidden overflow-y-auto sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            if (!focusComposerOnClose.current) return
            focusComposerOnClose.current = false
            event.preventDefault()
            document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"] [aria-label="Message"]`)?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Conversation tree</DialogTitle>
            <DialogDescription>Rewind continues this Conversation from a message. Fork copies the Conversation up to a message into a new one. {FILES_NOT_CHANGED}</DialogDescription>
          </DialogHeader>
          {!idle && (
            <InlineStatus tone="notice" density="compact" id={REASON_ID} className="p-0">
              {NOT_IDLE_TREE_REASON}
            </InlineStatus>
          )}
          {loading ? (
            <InlineStatus tone="loading" density="compact">Loading…</InlineStatus>
          ) : loadError ? (
            <DialogError message={loadError} />
          ) : tree && tree.entries.length === 0 ? (
            <InlineStatus density="compact">No messages in this Conversation yet.</InlineStatus>
          ) : tree && depths ? (
            <ul aria-label="Messages" className="flex min-w-0 flex-col gap-1">
              {tree.entries.map((entry) => (
                <ConversationTreeRow
                  key={entry.id}
                  entry={entry}
                  depth={depths.get(entry.id) ?? 0}
                  isLeaf={entry.id === tree.leafId}
                  actionsDisabled={!idle || busy}
                  reasonId={REASON_ID}
                  actionError={actionError?.entryId === entry.id ? actionError.message : null}
                  onRewind={(target) => {
                    setSummarize(false)
                    setActionError(null)
                    setRewindTarget(target)
                  }}
                  onFork={(target) => void handleFork(target)}
                  onLabel={handleLabel}
                />
              ))}
            </ul>
          ) : null}
          <InlineStatus tone="notice" density="compact" className={notice ? 'p-0' : 'sr-only'}>
            {notice ?? ''}
          </InlineStatus>
        </DialogContent>
      </Dialog>
      <ConfirmAlertDialog
        open={rewindTarget !== null}
        busy={working === 'rewind'}
        title="Rewind to here?"
        description={`The Conversation continues from this message and the messages after it leave the transcript. ${FILES_NOT_CHANGED}`}
        confirmLabel="Rewind"
        busyLabel={summarize ? 'Rewinding and summarising…' : 'Rewinding…'}
        error={actionError && actionError.entryId === rewindTarget?.id ? actionError.message : null}
        bodyLabel="Rewind options"
        onCancel={() => setRewindTarget(null)}
        onConfirm={() => void handleRewind()}
        onCloseAutoFocus={() => false}
      >
        <label className="flex items-center gap-2 text-sm">
          <CheckboxItem checked={summarize} aria-disabled={working === 'rewind'} className={CHECKBOX_BOX_ONLY_CLASS} onCheckedChange={(next) => !busy && setSummarize(next === true)}>
            <CheckboxIndicator />
          </CheckboxItem>
          Summarise the abandoned branch
        </label>
        {working === 'rewind' && summarize && (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void window.refract.conversations.abortSummary(sessionId)}>
            Cancel summary
          </Button>
        )}
      </ConfirmAlertDialog>
    </>
  )
}
