// The bottom comment box (spec 038 FR-010): the full MarkdownEditor with a "Comment" primary
// action and, while the pull request is open or draft, a destructive-outline "Close pull request"
// at the footer's left edge that confirms through the shared ConfirmAlertDialog naming the pull
// request. The draft text lives in PullRequestDetail so it survives a tab switch. Only the latest
// error shows; the sr-only alert region keeps late errors announced (#1200).
import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { PREVIEW_PROPS } from './prImages'
import { MarkdownEditor } from '@/components/markdown-editor'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { cn } from '@/lib/utils'

interface CommentBoxProps {
  repositoryId: string
  number: number
  state: 'open' | 'draft' | 'closed' | 'merged'
  title: string
  prTitle: string
  /** The unsent comment, owned by PullRequestDetail so it survives an Overview/Changes switch. */
  text: string
  onTextChange(value: string): void
  /** Re-fetches the detail after a successful comment or close. */
  onChanged(): void
  headingRef: RefObject<HTMLElement | null>
}

export function CommentBox({ repositoryId, number, state, title, prTitle, text, onTextChange, onChanged, headingRef }: CommentBoxProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closed, setClosed] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  async function handleComment(): Promise<void> {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    const result = await window.refract.pullRequests.comment(repositoryId, number, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onTextChange('')
    onChanged()
  }

  async function handleClose(): Promise<void> {
    setCloseBusy(true)
    setError(null)
    const result = await window.refract.pullRequests.close(repositoryId, number)
    setCloseBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      setCloseOpen(false)
      return
    }
    setClosed(true)
    setCloseOpen(false)
    onChanged()
  }

  return (
    <div className="border-t border-border p-4">
      <MarkdownEditor
        value={text}
        onChange={onTextChange}
        onSubmit={() => void handleComment()}
        placeholder="Add a comment"
        ariaLabel="Add a comment to this pull request"
        disabled={busy}
        previewProps={PREVIEW_PROPS}
        footer={
          <div className="flex w-full items-center gap-2">
            {(state === 'open' || state === 'draft') && (
              <Button
                ref={closeButtonRef}
                size="sm"
                variant="destructive-outline"
                onClick={() => {
                  setError(null)
                  setCloseOpen(true)
                }}
                disabled={busy || closeBusy}
              >
                Close pull request
              </Button>
            )}
            <p role="alert" className={cn('min-w-0 flex-1 text-xs text-destructive', !error && 'sr-only')}>
              {error ?? ''}
            </p>
            <Button size="sm" className="shrink-0" onClick={() => void handleComment()} disabled={busy || !text.trim()}>
              {busy ? 'Commenting…' : 'Comment'}
            </Button>
          </div>
        }
      />
      <ConfirmAlertDialog
        open={closeOpen}
        busy={closeBusy}
        tone="destructive"
        title="Close this pull request?"
        description={`This closes "${prTitle}" (${title}) on GitHub without merging it. You can reopen it later on GitHub.${text.trim() ? ' Your unsent comment will not be posted.' : ''}`}
        confirmLabel="Close pull request"
        busyLabel="Closing…"
        onCancel={() => setCloseOpen(false)}
        onConfirm={() => void handleClose()}
        // The button vanishes once the pull request is closed, so fall back to the heading.
        onCloseAutoFocus={() => {
          if (closed) headingRef.current?.focus()
          else closeButtonRef.current?.focus()
        }}
      />
    </div>
  )
}
