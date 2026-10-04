// The "Review" header action's entry point (specs/003-pull-request-management FR-015, FR-017,
// T020): offers all three verdicts (Comment, Approve, Request changes) with an optional body.
// Only Approve and Request changes go through an `AlertDialog` confirmation (`DeleteDialog.tsx`'s
// pattern) naming the pull request and the exact action first; Comment submits immediately, with
// no confirmation (FR-017 names only approve, request changes, and merge).
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ReviewVerdict } from '../../../shared/github'

export interface ReviewDialogProps {
  repositoryId: string
  number: number
  /** e.g. "pull request #95" -- named in both the compose header and the confirmation. */
  title: string
  open: boolean
  onOpenChange(open: boolean): void
  onSubmitted(): void
}

const VERDICTS: Array<{ value: ReviewVerdict; label: string }> = [
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'request-changes', label: 'Request changes' }
]

export function ReviewDialog({ repositoryId, number, title, open, onOpenChange, onSubmitted }: ReviewDialogProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict>('comment')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  function reset(): void {
    setVerdict('comment')
    setBody('')
    setError(null)
    setConfirming(false)
  }

  async function submit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    const result = await window.refract.pullRequests.submitReview(repositoryId, number, {
      verdict,
      body: body.trim() || undefined
    })
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    reset()
    onOpenChange(false)
    onSubmitted()
  }

  function handlePrimaryClick(): void {
    if (verdict === 'comment') {
      void submit()
    } else {
      setConfirming(true)
    }
  }

  function handleClose(next: boolean): void {
    if (!next) reset()
    onOpenChange(next)
  }

  const actionLabel = verdict === 'approve' ? 'Approve' : 'Request changes'

  return (
    <>
      <Dialog open={open && !confirming} onOpenChange={handleClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review {title}</DialogTitle>
            <DialogDescription>Choose a verdict and, optionally, a body.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2" role="group" aria-label="Review verdict">
            {VERDICTS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={verdict === option.value ? 'default' : 'outline'}
                aria-pressed={verdict === option.value}
                size="sm"
                onClick={() => setVerdict(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={verdict === 'request-changes' ? 'Explain what changes are needed' : 'Optional comment'}
            aria-label="Review body"
            className="min-h-24"
          />
          <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
            {error ?? ''}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handlePrimaryClick} disabled={submitting}>
              {verdict === 'comment' ? (submitting ? 'Submitting…' : 'Submit') : 'Continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* FR-017: approve/request-changes each require an explicit confirmation naming the pull
          request and the exact action, before the review is submitted. */}
      <AlertDialog
        open={open && confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actionLabel} {title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This submits your review as {verdict === 'approve' ? 'an approval' : 'a request for changes'} on {title}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
            {error ?? ''}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel
              aria-disabled={submitting}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                if (submitting) event.preventDefault()
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              aria-disabled={submitting}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault()
                if (submitting) return
                void submit()
              }}
            >
              {submitting ? 'Submitting…' : actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
