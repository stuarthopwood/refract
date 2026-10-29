// The bottom comment box (spec 038 FR-010): the full MarkdownEditor with a "Comment" primary
// action and, while the pull request is open, an outlined destructive "Close pull request" that
// confirms through the shared AlertDialog naming the pull request and the exact action. Errors
// show inline; the sr-only alert region keeps late errors announced (#1200).
import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { MarkdownEditor } from '@/components/markdown-editor'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { cn } from '@/lib/utils'

interface CommentBoxProps {
  repositoryId: string
  number: number
  state: 'open' | 'draft' | 'closed' | 'merged'
  title: string
  /** Re-fetches the detail after a successful comment or close. */
  onChanged(): void
  headingRef: RefObject<HTMLElement | null>
}

export function CommentBox({ repositoryId, number, state, title, onChanged, headingRef }: CommentBoxProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
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
    setText('')
    onChanged()
  }

  async function handleClose(): Promise<void> {
    setCloseBusy(true)
    setCloseError(null)
    const result = await window.refract.pullRequests.close(repositoryId, number)
    setCloseBusy(false)
    if (!result.ok) {
      setCloseError(result.error.message)
      setCloseOpen(false)
      return
    }
    setClosed(true)
    setCloseOpen(false)
    onChanged()
  }

  const message = error ?? closeError
  return (
    <div className="border-t border-border p-4">
      <MarkdownEditor
        value={text}
        onChange={setText}
        onSubmit={() => void handleComment()}
        placeholder="Add a comment"
        ariaLabel="Add a comment to this pull request"
        disabled={busy}
        footer={
          <div className="flex items-center justify-between gap-2">
            <p role="alert" className={cn('text-xs text-destructive', !message && 'sr-only')}>
              {message ?? ''}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {state === 'open' && (
                <Button
                  ref={closeButtonRef}
                  size="sm"
                  variant="outline"
                  className="border-destructive text-destructive hover:text-destructive"
                  onClick={() => setCloseOpen(true)}
                  disabled={busy || closeBusy}
                >
                  Close pull request
                </Button>
              )}
              <Button size="sm" onClick={() => void handleComment()} disabled={busy || !text.trim()}>
                {busy ? 'Commenting…' : 'Comment'}
              </Button>
            </div>
          </div>
        }
      />
      <ConfirmAlertDialog
        open={closeOpen}
        busy={closeBusy}
        title="Close this pull request?"
        description={`This closes ${title} on GitHub without merging it. You can reopen it later on GitHub.`}
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
