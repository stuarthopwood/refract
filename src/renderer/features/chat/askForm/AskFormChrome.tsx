import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
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

interface AskFormFooterProps {
  error: string | null
  /** Set only while a refused send can be repeated; adds a Retry beside the error. */
  onRetry?: () => void
  /** A static line about the deadline, shown above the status note. */
  deadlineText?: string
  note: string | undefined
  cancellable: boolean
  submittable: boolean
  sending: boolean
  onCancel: () => void
  onSubmit: () => void
}

/** Error, status line and the Cancel / Submit pair both ask forms end with. */
export function AskFormFooter({ error, onRetry, deadlineText, note, cancellable, submittable, sending, onCancel, onSubmit }: AskFormFooterProps) {
  return (
    <>
      {error && (
        <CardContent>
          <Alert variant="destructive" box="inline">
            <OctagonXIcon aria-hidden />
            <AlertDescription>{error}</AlertDescription>
            {onRetry && (
              <AlertActions>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                  Retry
                </Button>
              </AlertActions>
            )}
          </Alert>
        </CardContent>
      )}
      {deadlineText !== undefined && <CardContent className="text-sm text-muted-foreground">{deadlineText}</CardContent>}
      <CardContent role="status" className="text-sm text-muted-foreground empty:hidden">
        {note}
      </CardContent>
      {/* Stays mounted with the card so the focused button is still in the DOM when the card unmounts. */}
      <CardFooter>
        <Button size="sm" variant="ghost" aria-disabled={!cancellable} className="aria-disabled:opacity-50" onClick={() => cancellable && onCancel()}>
          Cancel
        </Button>
        <Button size="sm" aria-disabled={!submittable} aria-busy={sending} className="aria-disabled:opacity-50" onClick={onSubmit}>
          {sending && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {sending ? 'Submitting...' : 'Submit'}
        </Button>
      </CardFooter>
    </>
  )
}
