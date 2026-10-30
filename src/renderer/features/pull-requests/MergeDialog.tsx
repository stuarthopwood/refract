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

/** Props for {@link MergeDialog}. */
export interface MergeDialogProps {
  repositoryId: string
  number: number
  title: string
  headSha: string
  allowedMergeMethods: MergeMethod[]
  open: boolean
  onOpenChange(open: boolean): void
  onMerged(): void
  restoreFocusTo: RefObject<HTMLButtonElement | null>
  restoreFocusFallbackTo: RefObject<HTMLElement | null>
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

const METHOD_DESCRIPTION: Record<MergeMethod, string> = {
  merge: 'Keeps every commit and adds a merge commit.',
  squash: 'Combines every commit into a single commit.',
  rebase: 'Replays every commit onto the base branch.'
}

/** Dialog to choose a merge method and merge a pull request. */
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
  const expectedHeadShaRef = useRef(headSha)
  useEffect(() => {
    if (open) expectedHeadShaRef.current = headSha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
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
          if (submitting) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Merge {title}?</AlertDialogTitle>
          <AlertDialogDescription>Choose a merge method, then confirm.</AlertDialogDescription>
        </AlertDialogHeader>
        <RadioGroup aria-label="Merge method" value={method} onValueChange={(value) => setMethod(value as MergeMethod)}>
          {allowedMergeMethods.map((candidate) => {
            const labelId = `merge-method-${candidate}-label`
            const descriptionId = `merge-method-${candidate}-description`
            return (
              <RadioGroupItem key={candidate} value={candidate} aria-labelledby={labelId} aria-describedby={descriptionId}>
                <span className="flex w-full min-w-0 items-center gap-2">
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
            {submitting ? 'Merging…' : 'Merge'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
