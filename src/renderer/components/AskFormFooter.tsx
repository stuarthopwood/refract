import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { RetryButton } from './RetryButton'

interface AskFormFooterProps {
  error: string | null
  /** Set only while a refused send can be repeated, or is being; adds a Retry beside the error. */
  retry?: { busy: boolean; onRetry: () => void }
  /** A static line about the deadline, shown above the status note. */
  deadlineText?: string
  note: string | undefined
  cancellable: boolean
  submittable: boolean
  /** A submit is in flight. */
  sending: boolean
  /** A cancel is in flight. */
  cancelling?: boolean
  /** Resting labels; the busy ones ("Submitting…", "Cancelling…") are fixed. */
  cancelLabel?: string
  submitLabel?: string
  /** Extra buttons between Cancel and Submit. */
  actions?: React.ReactNode
  onCancel: () => void
  onSubmit: () => void
}

/** Error, status line and the Cancel / Submit pair both ask cards end with. */
export function AskFormFooter({
  error,
  retry,
  deadlineText,
  note,
  cancellable,
  submittable,
  sending,
  cancelling = false,
  cancelLabel = 'Cancel',
  submitLabel = 'Submit',
  actions,
  onCancel,
  onSubmit
}: AskFormFooterProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  return (
    <>
      {error && (
        <CardContent>
          <Alert variant="destructive" box="inline">
            <OctagonXIcon aria-hidden />
            <AlertDescription>{error}</AlertDescription>
            {retry && (
              <AlertActions>
                <RetryButton busy={retry.busy} onRetry={retry.onRetry} handoffTo={cancelRef} />
              </AlertActions>
            )}
          </Alert>
        </CardContent>
      )}
      {deadlineText !== undefined && <CardContent className="text-sm text-muted-foreground">{deadlineText}</CardContent>}
      {/* Always mounted so a later note is announced; sr-only while it is empty. */}
      <CardContent role="status" className={cn('text-sm text-muted-foreground', !note && 'sr-only')}>
        {note}
      </CardContent>
      {/* Stays mounted with the card so the focused button is still in the DOM when the card unmounts. */}
      <CardFooter className="flex-wrap">
        <Button ref={cancelRef} size="sm" variant="ghost" aria-disabled={!cancellable} aria-busy={cancelling} className="aria-disabled:opacity-50" onClick={() => cancellable && onCancel()}>
          {cancelling && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {cancelling ? 'Cancelling…' : cancelLabel}
        </Button>
        {actions}
        <Button size="sm" aria-disabled={!submittable} aria-busy={sending} className="aria-disabled:opacity-50" onClick={onSubmit}>
          {sending && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {sending ? 'Submitting…' : submitLabel}
        </Button>
      </CardFooter>
    </>
  )
}
