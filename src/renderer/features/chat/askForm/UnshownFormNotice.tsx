import * as React from 'react'
import { OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription } from '@/components/ui/alert'
import { RESTING_FOCUS_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'
import { RetryButton } from '@/components/RetryButton'
import { FORM_CANCEL, type FormResponder, type FormSendPhase } from './formRequest'
import { useFormResponder } from './useFormResponder'

const UNSHOWN_FORM_LEAD = `Refract can't show the agent's "form" dialog yet`
// Same wording as the notice the Rust side appends for a dialog it can't show.
export const UNSHOWN_FORM_NOTICE = `${UNSHOWN_FORM_LEAD}, so it was cancelled.`

/** The one cancel the agent gets, sent on open and again by Retry; the responder lets only one succeed. */
export function cancelUnshownForm(responder: FormResponder): Promise<boolean> {
  return responder.respond(FORM_CANCEL)
}

export interface UnshownFormNoticeState {
  /** Why OMP refused the cancel, shown in its own alert; null while the first cancel is going or done. */
  readonly error: string | null
  readonly canRetry: boolean
  /** A Retry send is in flight: Retry stays mounted, busy, so focus is not dropped. */
  readonly retrying: boolean
  /** What happened to the cancel, so the wording follows it. */
  readonly outcome: 'cancelling' | 'cancelled' | 'refused'
}

/** A refused cancel is the only state with an error and a Retry; both stay through the Retry's own resend. */
export function unshownFormNoticeState(phase: FormSendPhase, error: string | null): UnshownFormNoticeState {
  const refused = phase === 'idle' && error !== null
  const retrying = phase === 'sending' && error !== null
  const outcome = refused ? 'refused' : phase === 'sent' ? 'cancelled' : 'cancelling'
  return { error: refused || retrying ? error : null, canRetry: refused || retrying, retrying, outcome }
}

/** The notice wording for the state of the cancel; it keeps the word "form" the agent used. */
export function unshownFormNoticeText(outcome: UnshownFormNoticeState['outcome']): string {
  if (outcome === 'cancelled') return UNSHOWN_FORM_NOTICE
  return outcome === 'refused' ? `${UNSHOWN_FORM_LEAD}, and it couldn't be cancelled.` : `${UNSHOWN_FORM_LEAD}, so it is being cancelled.`
}

interface UnshownFormViewProps {
  phase: FormSendPhase
  error: string | null
  onRetry: () => void
}

export function UnshownFormView({ phase, error, onRetry }: UnshownFormViewProps) {
  const state = unshownFormNoticeState(phase, error)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  return (
    <div ref={wrapperRef} tabIndex={-1} className={cn('flex flex-col gap-2 rounded-lg', RESTING_FOCUS_CLASS)}>
      {/* The warning keeps one role in every state; a refused cancel is its own alert so a screen reader announces it once. */}
      <Alert variant="warning" role="status">
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>{unshownFormNoticeText(state.outcome)}</AlertDescription>
      </Alert>
      {state.error !== null && (
        <Alert variant="destructive" box="inline" role="alert">
          <OctagonXIcon aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
          {state.canRetry && (
            <AlertActions>
              <RetryButton busy={state.retrying} onRetry={onRetry} handoffTo={wrapperRef} />
            </AlertActions>
          )}
        </Alert>
      )}
    </div>
  )
}

/** A form whose html Refract can't parse gets no card: it is cancelled for the agent and a short notice stays. */
export function UnshownFormNotice({ sessionId, requestId }: { sessionId: string; requestId: string }) {
  const { responder, phase, error } = useFormResponder(sessionId, requestId)
  React.useEffect(() => {
    void cancelUnshownForm(responder)
  }, [responder])
  return <UnshownFormView phase={phase} error={error} onRetry={() => void cancelUnshownForm(responder)} />
}
