// The merge confirmation (specs/003-pull-request-management FR-016, FR-017, T021): an
// `AlertDialog` naming the pull request, with a method picker limited to
// `PullRequestDetail.allowedMergeMethods` (only the methods this repository allows).
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
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
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

// Issue #498: one line of plain-language detail per method, shown under its name in the
// radiogroup list so the choice makes sense without opening GitHub's own help.
const METHOD_DESCRIPTION: Record<MergeMethod, string> = {
  merge: 'Keeps every commit and adds a merge commit.',
  squash: 'Combines every commit into a single commit.',
  rebase: 'Replays every commit onto the base branch.'
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
      {/* Issue #498: widened from the shared default (max-w-xs, sm:max-w-sm) to `size="md"`
       * (max-w-xs, sm:max-w-md -- 448px from the `sm` breakpoint) so the radiogroup list and its
       * descriptions have room without wrapping every word; every other `AlertDialogContent`
       * consumer keeps the unchanged default. */}
      <AlertDialogContent
        size="md"
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
          {/* Quality-gate remediation (code-reviewer, Low): `overflow-y-auto` on the shared
           * `AlertDialogContent` (added for 1.4.10) makes `overflow-x` resolve to `auto` too, so
           * an unbroken-token title with no wrap points would show a horizontal scrollbar instead
           * of simply spilling; `break-words` keeps it wrapping like the rest of the dialog. */}
          <AlertDialogTitle className="break-words">Merge {title}?</AlertDialogTitle>
          <AlertDialogDescription>Choose a merge method, then confirm.</AlertDialogDescription>
        </AlertDialogHeader>
        {/* Quality-gate remediation (code-reviewer, Medium, issue #498): replaces a hand-rolled
         * roving-tabindex `role="radiogroup"` (refs, key-to-index arithmetic, duplicated from
         * `ThemePicker.tsx` and already drifted from it) with the shared `RadioGroup` primitive,
         * which provides the same WAI-ARIA Radio Group keyboard behaviour (arrow keys, Home/End,
         * wrap-around) without a hand-written key handler. */}
        <RadioGroup aria-label="Merge method" value={method} onValueChange={(value) => setMethod(value as MergeMethod)}>
          {allowedMergeMethods.map((candidate) => {
            const labelId = `merge-method-${candidate}-label`
            const descriptionId = `merge-method-${candidate}-description`
            return (
              // Quality-gate remediation (cycle 2, Medium): a `role="radio"` button's accessible
              // name otherwise comes from its FULL subtree text content, so `aria-describedby`
              // alone (pointing at the description span nested inside the same button) made the
              // description read twice -- once as part of the name, once again as the
              // description. `aria-labelledby` on the label span overrides the name to just the
              // label; `aria-describedby` keeps the description as a separate, secondary read.
              <RadioGroupItem key={candidate} value={candidate} aria-labelledby={labelId} aria-describedby={descriptionId}>
                <span className="flex w-full min-w-0 items-center gap-2">
                  {/* Quality-gate remediation (accessibility-auditor, Medium, WCAG 1.4.1): the
                   * selected method used to be shown only by a border/tint colour change, which
                   * also vanished under the focus ring. This dot is a non-colour cue that stays
                   * visible while focused (it lives outside the border this component already
                   * recolours on focus) and only renders for the checked item (Radix mounts
                   * `Indicator` conditionally). */}
                  <span aria-hidden className={RADIO_RING_CLASS}>
                    <RadioGroupIndicator />
                  </span>
                  <span id={labelId} className="min-w-0 flex-1 break-words">{METHOD_LABEL[candidate]}</span>
                </span>
                <span id={descriptionId} className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">
                  {METHOD_DESCRIPTION[candidate]}
                </span>
              </RadioGroupItem>
            )
          })}
        </RadioGroup>
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
            {/* Issue #498: shortened from "Merge using ${METHOD_LABEL[method]}" -- the chosen
             * method is already selected above, so the long label only pushed the footer past the
             * dialog's edge for no extra information. */}
            {submitting ? 'Merging…' : 'Merge'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
