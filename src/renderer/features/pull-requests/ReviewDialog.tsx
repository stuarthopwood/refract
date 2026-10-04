// The "Review" header action's entry point (specs/003-pull-request-management FR-015, FR-017,
// T020): offers all three verdicts (Comment, Approve, Request changes) with an optional body.
// Only Approve and Request changes go through an `AlertDialog` confirmation (`DeleteDialog.tsx`'s
// pattern) naming the pull request and the exact action first; Comment submits immediately, with
// no confirmation (FR-017 names only approve, request changes, and merge).
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
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
 /** Security remediation (round 3, High): see `MergeDialog.tsx`'s identical prop -- the
  * renderer's own snapshot of `headSha` from the moment this dialog opened, sent as
  * `expectedHeadSha` so a background poll landing while the dialog is open can't silently pin
  * an approval to a commit the user never saw. */
 headSha: string
 open: boolean
 onOpenChange(open: boolean): void
 onSubmitted(): void
 /** High remediation (accessibility-auditor): this dialog's own opening "Review" button -- see
  * `MergeDialog.tsx`'s identical props for the exact reasoning (Radix can't restore focus to a
  * now-disabled trigger, e.g. right after an Approve closes out the pull request). */
 restoreFocusTo: RefObject<HTMLButtonElement | null>
 restoreFocusFallbackTo: RefObject<HTMLElement | null>
}

const VERDICTS: Array<{ value: ReviewVerdict; label: string }> = [
 { value: 'comment', label: 'Comment' },
 { value: 'approve', label: 'Approve' },
 { value: 'request-changes', label: 'Request changes' }
]

export function ReviewDialog({
 repositoryId,
 number,
 title,
 headSha,
 open,
 onOpenChange,
 onSubmitted,
 restoreFocusTo,
 restoreFocusFallbackTo
}: ReviewDialogProps) {
 const [verdict, setVerdict] = useState<ReviewVerdict>('comment')
 const [body, setBody] = useState('')
 const [submitting, setSubmitting] = useState(false)
 const [error, setError] = useState<string | null>(null)
 const [confirming, setConfirming] = useState(false)
 // Security remediation (round 3, High): see `MergeDialog.tsx`'s identical ref -- captures
 // `headSha` the instant the dialog opens, sent as `expectedHeadSha` instead of trusting
 // whatever the in-process staleness cache currently holds (silently re-seeded by the 15s poll
 // even while this dialog sits open).
 const expectedHeadShaRef = useRef(headSha)
 useEffect(() => {
  if (open) expectedHeadShaRef.current = headSha
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [open])
 // Accessibility remediation (round 3, High): see `MergeDialog.tsx`'s identical `succeededRef`
 // -- the prior focus logic inferred success from whether `restoreFocusTo`'s button was
 // disabled at close time, but the post-submit reload that disables it is async and usually
 // slower than Radix's ~200ms `onCloseAutoFocus` timing, so the fallback was never reached.
 const succeededRef = useRef(false)

 function reset(): void {
  setVerdict('comment')
  setBody('')
  setError(null)
  setConfirming(false)
 }

 // "Also fix" remediation: `gh pr review --comment`/`--request-changes` themselves reject an
 // empty body -- blocked client-side first, with a clear reason, rather than round-tripping to
 // `gh` just to surface its own rejection. Approve is the only verdict GitHub allows with no body.
 const trimmedBody = body.trim()
 const bodyRequired = verdict !== 'approve'
 const bodyMissing = bodyRequired && trimmedBody.length === 0

 async function submit(): Promise<void> {
  setSubmitting(true)
  setError(null)
  const result = await window.refract.pullRequests.submitReview(repositoryId, number, {
   verdict,
   body: trimmedBody || undefined,
   expectedHeadSha: expectedHeadShaRef.current
  })
  setSubmitting(false)
  if (!result.ok) {
   setError(result.error.message)
   return
  }
  succeededRef.current = true
  reset()
  onOpenChange(false)
  onSubmitted()
 }

 function handlePrimaryClick(): void {
  if (bodyMissing) {
   setError(verdict === 'comment' ? 'A comment needs a body.' : 'Explain what changes are needed before requesting changes.')
   return
  }
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

 function focusTrigger(event: { preventDefault(): void }): void {
  event.preventDefault()
  if (succeededRef.current) {
   succeededRef.current = false
   restoreFocusFallbackTo.current?.focus()
   return
  }
  const button = restoreFocusTo.current
  if (button && !button.disabled) button.focus()
  else restoreFocusFallbackTo.current?.focus()
 }

 const actionLabel = verdict === 'approve' ? 'Approve' : 'Request changes'
 // "Also fix" remediation (round 3, Medium): the placeholder/copy used to claim the body was
 // optional for every verdict, even though comment/request-changes now require one (added last
 // round, `bodyRequired` above) -- worded per-verdict instead.
 const bodyHint = verdict === 'approve' ? 'optional' : 'required'
 const bodyErrorId = 'review-body-error'

 return (
  <>
   <Dialog open={open && !confirming} onOpenChange={handleClose}>
    <DialogContent
     showCloseButton={!submitting}
     onCloseAutoFocus={focusTrigger}
     onEscapeKeyDown={(event) => {
      // High remediation (accessibility-auditor, also code-reviewer): matches
      // MergeDialog.tsx's own guard -- an in-flight submit must not be silently abandonable.
      if (submitting) event.preventDefault()
     }}
     onInteractOutside={(event) => {
      if (submitting) event.preventDefault()
     }}
    >
     <DialogHeader>
      <DialogTitle>Review {title}</DialogTitle>
      <DialogDescription>Choose a verdict and a body ({bodyHint}).</DialogDescription>
     </DialogHeader>
     <div className="flex gap-2" role="group" aria-label="Review verdict">
      {VERDICTS.map((option) => (
       <Button
        key={option.value}
        type="button"
        variant={verdict === option.value ? 'default' : 'outline'}
        aria-pressed={verdict === option.value}
        size="sm"
        onClick={() => {
         setVerdict(option.value)
         setError(null)
        }}
       >
        {option.label}
       </Button>
      ))}
     </div>
     <Textarea
      value={body}
      onChange={(e) => setBody(e.target.value)}
      placeholder={verdict === 'approve' ? 'Optional comment' : 'A body is required for this verdict'}
      aria-label="Review body"
      aria-invalid={bodyMissing && !!error}
      aria-describedby={error ? bodyErrorId : undefined}
      className="min-h-24"
      readOnly={submitting}
      aria-disabled={submitting}
     />
     <p id={bodyErrorId} role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
      {error ?? ''}
     </p>
     <DialogFooter>
      <Button
       variant="outline"
       aria-disabled={submitting}
       className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
       onClick={(event) => {
        if (submitting) {
         event.preventDefault()
         return
        }
        reset()
        onOpenChange(false)
       }}
      >
       Cancel
      </Button>
      <Button
       aria-disabled={submitting}
       className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
       onClick={(event) => {
        event.preventDefault()
        if (submitting) return
        handlePrimaryClick()
       }}
      >
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
    <AlertDialogContent
     onCloseAutoFocus={focusTrigger}
     onEscapeKeyDown={(event) => {
      if (submitting) event.preventDefault()
     }}
    >
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
