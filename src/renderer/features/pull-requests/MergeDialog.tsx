// The merge confirmation (specs/003-pull-request-management FR-016, FR-017, T021): an
// `AlertDialog` naming the pull request and the chosen merge method, with a method picker limited
// to `PullRequestDetail.allowedMergeMethods` (only the methods this repository allows).
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
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MergeMethod } from '../../../shared/github'

export interface MergeDialogProps {
  repositoryId: string
  number: number
  title: string
  allowedMergeMethods: MergeMethod[]
  open: boolean
  onOpenChange(open: boolean): void
  onMerged(): void
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

export function MergeDialog({ repositoryId, number, title, allowedMergeMethods, open, onOpenChange, onMerged }: MergeDialogProps) {
  const [method, setMethod] = useState<MergeMethod>(allowedMergeMethods[0] ?? 'merge')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleMerge(): Promise<void> {
    setSubmitting(true)
    setError(null)
    const result = await window.refract.pullRequests.merge(repositoryId, number, { method })
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
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
      <AlertDialogContent>
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
