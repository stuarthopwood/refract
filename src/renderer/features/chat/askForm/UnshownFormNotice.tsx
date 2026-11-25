import * as React from 'react'
import { OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FORM_CANCEL, type FormResponder } from './formRequest'
import { useFormResponder, type FormSendPhase } from './useFormResponder'

// Same wording as the notice the Rust side appends for a dialog it can't show.
export const UNSHOWN_FORM_NOTICE = `Refract can't show the agent's "form" dialog yet, so it was cancelled.`

/** The one cancel the agent gets, sent on open and again by Retry; the responder lets only one succeed. */
export function cancelUnshownForm(responder: FormResponder): Promise<boolean> {
  return responder.respond(FORM_CANCEL)
}

export interface UnshownFormNoticeState {
  /** Why OMP refused the cancel, shown beside the notice; null while the cancel is going or done. */
  readonly error: string | null
  readonly canRetry: boolean
}

/** A refused cancel is the only state with an error and a Retry; the notice itself reads the same throughout. */
export function unshownFormNoticeState(phase: FormSendPhase, error: string | null): UnshownFormNoticeState {
  const refused = phase === 'idle' && error !== null
  return { error: refused ? error : null, canRetry: refused }
}

interface UnshownFormViewProps {
  phase: FormSendPhase
  error: string | null
  onRetry: () => void
}

export function UnshownFormView({ phase, error, onRetry }: UnshownFormViewProps) {
  const state = unshownFormNoticeState(phase, error)
  return (
    <Alert variant={state.canRetry ? 'destructive' : 'warning'} role={state.canRetry ? 'alert' : 'status'}>
      {state.canRetry ? <OctagonXIcon aria-hidden /> : <TriangleAlertIcon aria-hidden />}
      <AlertDescription>
        {UNSHOWN_FORM_NOTICE}
        {state.error !== null && <> {state.error}</>}
      </AlertDescription>
      {state.canRetry && (
        <AlertActions>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </AlertActions>
      )}
    </Alert>
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
