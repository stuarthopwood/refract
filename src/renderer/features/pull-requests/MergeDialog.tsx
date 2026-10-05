// The merge confirmation (specs/003-pull-request-management FR-016, FR-017, T021): an
// `AlertDialog` naming the pull request and the chosen merge method, with a method picker limited
// to `PullRequestDetail.allowedMergeMethods` (only the methods this repository allows).
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
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MergeMethod } from '../../../shared/github'

export interface MergeDialogProps {
  repositoryId: string
  number: number
  title: string
  /** Security remediation (round 3, High): the pull request's `headSha` as the renderer had it
   * on screen the moment this dialog opened -- captured below into a ref the instant `open`
   * flips true, not re-read lazily at confirm time, so a background poll landing while this
   * dialog sits open can't silently swap in a commit the user never reviewed. Sent as
   * `expectedHeadSha`; main refuses with `stale` unless a fresh re-fetch still matches it. */
  headSha: string
  allowedMergeMethods: MergeMethod[]
  open: boolean
  onOpenChange(open: boolean): void
  onMerged(): void
  /** High remediation (accessibility-auditor): this dialog's own opening "Merge" button, so
   * closing it (Cancel, Escape, or a successful merge) returns focus there instead of Radix's
   * default (which lands on `<body>` once the opening button is re-rendered disabled after a
   * successful merge, since Radix can't restore focus to a disabled element). */
  restoreFocusTo: RefObject<HTMLButtonElement | null>
  /** Falls back here (the detail view's own `<h2>`) when `restoreFocusTo`'s button is now
   * disabled -- e.g. right after a successful merge, when the Merge button itself disappears
   * behind `mergeDisabledReason` (corrected round-3 comment: the field was renamed from
   * `disabledReason` when Critical #3's fix two rounds ago split it from `reviewDisabledReason`).
   */
  restoreFocusFallbackTo: RefObject<HTMLElement | null>
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

export function MergeDialog({
  repositoryId,
  number,
  title,
  headSha,
  allowedMergeMethods,
  open,
  onOpenChange,
  onMerged,
  restoreFocusTo,
  restoreFocusFallbackTo
}: MergeDialogProps) {
  const [method, setMethod] = useState<MergeMethod>(allowedMergeMethods[0] ?? 'merge')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Security remediation (round 3, High): snapshots `headSha` the instant the dialog opens, not
  // read lazily from the (possibly since-changed) prop at confirm time -- this is the exact
  // value sent as `expectedHeadSha`.
  const expectedHeadShaRef = useRef(headSha)
  useEffect(() => {
    if (open) expectedHeadShaRef.current = headSha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  // Accessibility remediation (round 3, High): the prior `onCloseAutoFocus` inferred success by
  // checking whether `restoreFocusTo`'s button was DISABLED at the moment Radix fires that
  // callback (~200ms after close) -- but the `load()` reload that actually disables the Merge
  // button (because the PR is now merged) is async and usually slower than that 200ms window, so
  // focus landed on the still-enabled button, then got yanked to `<body>` once the slow reload
  // later disabled it; the heading fallback was never reached. `succeededRef` (`DeleteDialog.tsx`'s
  // own pattern) is set synchronously the instant the mutation call resolves successfully, so the
  // close-focus logic below checks a fact that is true the moment it matters, not an inference
  // about a DOM state that hasn't caught up yet.
  const succeededRef = useRef(false)

  async function handleMerge(): Promise<void> {
    setSubmitting(true)
    setError(null)
    const result = await window.refract.pullRequests.merge(repositoryId, number, { method, expectedHeadSha: expectedHeadShaRef.current })
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    succeededRef.current = true
    onOpenChange(false)
    onMerged()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const button = restoreFocusTo.current
          if (succeededRef.current) {
            succeededRef.current = false
            restoreFocusFallbackTo.current?.focus()
            return
          }
          if (button && !button.disabled) button.focus()
          else restoreFocusFallbackTo.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          // High remediation (accessibility-auditor, also code-reviewer): an in-flight merge
          // used to be silently abandonable via Escape, Close, or a click outside -- its result
          // (including a `stale` refusal) was then lost with no announcement at all.
          if (submitting) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Merge {title}?</AlertDialogTitle>
          <AlertDialogDescription>Choose a merge method, then confirm.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-2" role="group" aria-label="Merge method">
          {allowedMergeMethods.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              variant={method === candidate ? 'default' : 'outline'}
              aria-pressed={method === candidate}
              size="sm"
              onClick={() => setMethod(candidate)}
            >
              {METHOD_LABEL[candidate]}
            </Button>
          ))}
        </div>
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
              void handleMerge()
            }}
          >
            {submitting ? 'Merging…' : `Merge using ${METHOD_LABEL[method]}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
