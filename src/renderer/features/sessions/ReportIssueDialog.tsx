// Report an issue (issue #503, spec 049): files a GitHub issue scoped to one repository, from the
// Repository group's "…" menu. Title, collapsed duplicate check, Description (shared Markdown
// editor with Preview), Labels. Everything the user types stays on screen after a failure. All
// GitHub access goes through `window.refract.issues` (Rust, argv-array `gh`, Principle V).
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { MarkdownEditor } from '@/components/markdown-editor'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PREVIEW_PROPS } from '@/features/pull-requests/prImages'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/state/accounts'
import type { CreatedIssue } from '../../../shared/ipc-issues'
import type { Repository } from '../../../shared/model'
import { IssueCreatedPanel } from './IssueCreatedPanel'
import { IssueDuplicates } from './IssueDuplicates'
import { IssueLabelPicker } from './IssueLabelPicker'
import { githubRemoteSlug } from './remoteDisplay'
import { ISSUE_TITLE_MAX, submitIssue, useDuplicateIssues, useIssueLabels } from './useReportIssue'
import type { IssueFormState } from './useReportIssue'

const EMPTY_FORM: IssueFormState = { title: '', body: '', labels: [] }

interface ReportIssueDialogProps {
  repository: Repository
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where focus goes once the dialog has closed (the "…" menu trigger that opened it). */
  onCloseFocus: () => void
  /** The dialog heading; the Issues page says New issue. */
  title?: string
  /** Called once the issue exists, before the result panel is shown. */
  onCreated?: (issue: CreatedIssue) => void
}

export function ReportIssueDialog({ repository, open, onOpenChange, onCloseFocus, title = 'Report an issue', onCreated }: ReportIssueDialogProps) {
  const login = useAccountsStore((state) => state.github.find((account) => account.active)?.login)
  const [form, setForm] = useState<IssueFormState>(EMPTY_FORM)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedIssue | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const showForm = open && created === null
  const { labels, failed: labelsFailed } = useIssueLabels(repository.id, open && Boolean(login))
  const matches = useDuplicateIssues(repository.id, form.title, showForm && Boolean(login))

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM)
      setSubmitted(false)
      setError(null)
      setCreated(null)
      setBusy(false)
    }
  }, [open])

  const dirty = form.title.trim() !== '' || form.body.trim() !== ''
  const titleError = submitted && form.title.trim() === '' ? 'Enter a title.' : null
  const slug = githubRemoteSlug(repository.remote) ?? repository.name

  function requestClose(next: boolean): void {
    if (next) return onOpenChange(true)
    if (busy) return
    if (showForm && dirty) setConfirmDiscard(true)
    else onOpenChange(false)
  }

  async function handleSubmit(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (busy) return
    setSubmitted(true)
    if (form.title.trim() === '') {
      titleRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const outcome = await submitIssue(repository.id, form)
    setBusy(false)
    if (outcome.ok) {
      setCreated(outcome.issue)
      onCreated?.(outcome.issue)
    } else {
      setError(outcome.message)
      // The submit button was disabled while busy, so focus fell to the body; put it back.
      requestAnimationFrame(() => submitRef.current?.focus())
    }
  }

  function reportAnother(): void {
    setForm(EMPTY_FORM)
    setSubmitted(false)
    setError(null)
    setCreated(null)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent
          className="sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onCloseFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{login ? `${slug} · as @${login}` : slug}</DialogDescription>
          </DialogHeader>
          {!login ? (
            <>
              <p className="text-sm">Sign in to GitHub from the profile menu to file an issue in this project's GitHub repository.</p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : created ? (
            <IssueCreatedPanel issue={created} onClose={() => onOpenChange(false)} onReportAnother={reportAnother} inApp={onCreated !== undefined} />
          ) : (
            <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
              <div className="flex flex-col gap-2">
                <label htmlFor="report-issue-title" className="text-sm">
                  Title
                </label>
                <Input
                  id="report-issue-title"
                  ref={titleRef}
                  value={form.title}
                  maxLength={ISSUE_TITLE_MAX}
                  autoFocus
                  disabled={busy}
                  aria-required
                  aria-invalid={titleError !== null}
                  aria-describedby={titleError ? 'report-issue-title-error' : undefined}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
                {titleError && (
                  <p id="report-issue-title-error" className="text-sm text-destructive">
                    {titleError}
                  </p>
                )}
              </div>
              <IssueDuplicates matches={matches} />
              <div className="flex flex-col gap-2">
                <span id="report-issue-body-label" className="text-sm">
                  Description
                </span>
                <MarkdownEditor
                  value={form.body}
                  onChange={(body) => setForm({ ...form, body })}
                  onSubmit={() => void handleSubmit()}
                  ariaLabel="Description"
                  placeholder="What happened, and what did you expect? Markdown is supported."
                  disabled={busy}
                  previewProps={PREVIEW_PROPS}
                />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-sm">Labels</span>
                <IssueLabelPicker
                  labels={labels}
                  selected={form.labels}
                  onChange={(next) => setForm({ ...form, labels: next })}
                  disabled={busy}
                  unavailable={labelsFailed}
                />
              </div>
              <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
                {error ? `Error: ${error}` : ''}
              </p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => requestClose(false)}>
                  Cancel
                </Button>
                <Button ref={submitRef} type="submit" disabled={busy}>
                  {busy ? 'Creating…' : error ? 'Retry' : 'Create issue'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmAlertDialog
        open={confirmDiscard}
        busy={false}
        tone="destructive"
        title="Discard this draft?"
        description="Your title and description have not been filed and will be lost."
        confirmLabel="Discard draft"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false)
          onOpenChange(false)
        }}
        onCloseAutoFocus={() => titleRef.current?.focus()}
      />
    </>
  )
}
