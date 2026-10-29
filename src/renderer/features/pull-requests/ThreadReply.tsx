// A review thread's Reply and Resolve controls (spec 038 FR-009). Reply is a ghost toggle that
// opens the compact MarkdownEditor under the thread; the draft lives in PullRequestDetail (so it survives
// a tab switch), not in the editor, so Esc or Cancel keeps it. Ctrl+Enter sends; a failure shows the exact error inline.
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MarkdownEditor } from '@/components/markdown-editor'
import type { ReviewThread } from '../../../shared/github'
import { PREVIEW_PROPS } from './prImages'

interface ThreadActionsProps {
  repositoryId: string
  number: number
  thread: ReviewThread
  /** The unsent reply draft, owned by PullRequestDetail so it survives an Overview/Changes switch. */
  draft: string
  onDraftChange(value: string): void
  onChanged(): void
}

export function ThreadActions({ repositoryId, number, thread, draft, onDraftChange, onChanged }: ThreadActionsProps) {
  const [replyOpen, setReplyOpen] = useState(draft !== '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const replyButtonRef = useRef<HTMLButtonElement>(null)
  const location = `${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`

  function openReply(): void {
    setError(null)
    setReplyOpen(true)
  }

  function closeReply(): void {
    setError(null)
    setReplyOpen(false)
    replyButtonRef.current?.focus()
  }

  async function handleReply(): Promise<void> {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    const result = await window.refract.pullRequests.replyToThread(repositoryId, number, thread.id, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onDraftChange('')
    closeReply()
    onChanged()
  }

  async function handleToggleResolve(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = thread.resolved
      ? await window.refract.pullRequests.unresolveThread(repositoryId, number, thread.id)
      : await window.refract.pullRequests.resolveThread(repositoryId, number, thread.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onChanged()
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-end gap-1">
        {/* The path (and line) disambiguates identical "Reply"/"Resolve" names across threads; the
            visible word stays "Reply" (aria-expanded carries the open state). */}
        <Button
          ref={replyButtonRef}
          size="sm"
          variant="ghost"
          aria-label={`Reply to ${location}`}
          aria-expanded={replyOpen}
          onClick={() => (replyOpen ? closeReply() : openReply())}
        >
          Reply
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label={`${thread.resolved ? 'Unresolve' : 'Resolve'} thread on ${location}`}
          onClick={() => void handleToggleResolve()}
          disabled={busy}
        >
          {thread.resolved ? 'Unresolve' : 'Resolve'}
        </Button>
      </div>
      {replyOpen && (
        <MarkdownEditor
          size="compact"
          value={draft}
          onChange={onDraftChange}
          onSubmit={() => void handleReply()}
          onCancel={closeReply}
          placeholder="Reply to this thread"
          ariaLabel={`Reply to the review thread on ${thread.path}`}
          disabled={busy}
          autoFocus
          className="mt-2"
          previewProps={PREVIEW_PROPS}
          footer={
            <>
              <Button size="sm" variant="outline" onClick={closeReply} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                aria-label={`Send reply on ${location}`}
                onClick={() => void handleReply()}
                disabled={busy || !draft.trim()}
              >
                {busy ? 'Replying…' : 'Reply'}
              </Button>
            </>
          }
        />
      )}
      {/* Always mounted so a late error is announced. */}
      <p role="alert" className={cn('mt-1 text-xs text-destructive', !error && 'sr-only')}>
        {error ?? ''}
      </p>
    </div>
  )
}