import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { AskFormPhase } from './askFormSession'

/** The live form's card chrome; `label` names the card. */
export function AskFormShell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <Card size="sm" role="group" aria-label={label}>
      <CardHeader>
        <CardTitle>Questions from the agent</CardTitle>
      </CardHeader>
      {children}
    </Card>
  )
}

const SESSION_PHASE_NOTE: Partial<Record<AskFormPhase, string>> = {
  answering: 'Submitting your answers',
  cancelling: 'Cancelled',
  done: 'Answers submitted'
}

/** The per-field session's status line; the whole-form card words its own from what it sent. */
export function sessionPhaseNote(phase: AskFormPhase): string | undefined {
  return SESSION_PHASE_NOTE[phase]
}

/**
 * Retry for a refused send. It stays mounted, aria-disabled and busy, while its send is in flight, so focus is
 * not dropped to the page; once it goes, a focused Retry hands focus to `handoffTo` first.
 */
export function RetryButton({ busy, onRetry, handoffTo }: { busy: boolean; onRetry: () => void; handoffTo: React.RefObject<HTMLElement | null> }) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useLayoutEffect(() => {
    return () => {
      if (ref.current && document.activeElement === ref.current) handoffTo.current?.focus()
    }
  }, [handoffTo])
  return (
    <Button ref={ref} size="sm" variant="ghost" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => !busy && onRetry()}>
      {busy && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
      Retry
    </Button>
  )
}

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
  onCancel: () => void
  onSubmit: () => void
}

/** Error, status line and the Cancel / Submit pair both ask forms end with. */
export function AskFormFooter({ error, retry, deadlineText, note, cancellable, submittable, sending, cancelling = false, onCancel, onSubmit }: AskFormFooterProps) {
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
      <CardFooter>
        <Button ref={cancelRef} size="sm" variant="ghost" aria-disabled={!cancellable} aria-busy={cancelling} className="aria-disabled:opacity-50" onClick={() => cancellable && onCancel()}>
          {cancelling && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
        <Button size="sm" aria-disabled={!submittable} aria-busy={sending} className="aria-disabled:opacity-50" onClick={onSubmit}>
          {sending && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {sending ? 'Submitting…' : 'Submit'}
        </Button>
      </CardFooter>
    </>
  )
}
