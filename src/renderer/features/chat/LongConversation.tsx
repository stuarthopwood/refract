// #1212 (spec 021, FR-014, FR-016, FR-020): the Status line's "Long conversation" readout and the
// pane banner repeating the offer, both with a real Hand off button. State is stated in text, not
// colour. The screen-reader announcement is one visually hidden `role="status"` whose text only
// changes when a threshold (300, 500) is crossed, so it is spoken once per threshold per
// Conversation and never per call.
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useSessionsStore } from '@/state'
import { useTokenGuardCallsStore } from '@/state/token-guard-calls-store'
import {
  LONG_CONVERSATION_BANNER_CALLS,
  LONG_CONVERSATION_BANNER_REPEAT,
  LONG_CONVERSATION_CALLS
} from '../../../shared/tokenGuard'
import { ReadoutChip } from './readout/ReadoutChip'

function useHandOff(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const handingOff = useTokenGuardCallsStore((s) => s.handingOff[sessionId] ?? false)
  const idle = status === 'idle'
  return {
    handingOff,
    idle,
    disabled: handingOff || !idle,
    reason: handingOff ? 'Handing off…' : idle ? null : 'Available when the Session is idle',
    run: () => void useTokenGuardCallsStore.getState().handOff(sessionId)
  }
}

export function LongConversationChip({ sessionId }: { sessionId: string }) {
  const calls = useTokenGuardCallsStore((s) => s.bySession[sessionId]?.calls ?? 0)
  const handOff = useHandOff(sessionId)
  const long = calls >= LONG_CONVERSATION_CALLS
  const announcement =
    calls >= LONG_CONVERSATION_BANNER_CALLS
      ? `Very long conversation, over ${LONG_CONVERSATION_BANNER_CALLS} model calls. Hand off to continue in a fresh conversation.`
      : long
        ? `Long conversation, over ${LONG_CONVERSATION_CALLS} model calls. You can hand off to a fresh conversation.`
        : ''
  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {long && (
        <ReadoutChip>
          <span>{`Long conversation, ${calls} calls`}</span>
          <Button type="button" variant="outline" size="xs" disabled={handOff.disabled} onClick={handOff.run}>
            Hand off
          </Button>
          {handOff.reason && <span>{handOff.reason}</span>}
        </ReadoutChip>
      )}
    </>
  )
}

export function LongConversationBanner({ sessionId }: { sessionId: string }) {
  const entry = useTokenGuardCallsStore((s) => s.bySession[sessionId])
  const error = useTokenGuardCallsStore((s) => s.handoffError[sessionId] ?? null)
  const handOff = useHandOff(sessionId)
  const calls = entry?.calls ?? 0
  const dismissedAt = entry?.bannerDismissedAt ?? null
  const showBanner =
    calls >= LONG_CONVERSATION_BANNER_CALLS &&
    (dismissedAt === null || calls >= dismissedAt + LONG_CONVERSATION_BANNER_REPEAT)
  return (
    <>
      {error && (
        <Alert variant="destructive" role="alert" data-slot="handoff-error">
          <AlertTitle>Hand off failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => useTokenGuardCallsStore.getState().dismissHandoffError(sessionId)}
            >
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      )}
      {showBanner && (
        <Alert data-slot="long-conversation-banner">
          <AlertTitle>{`Long conversation, ${calls} calls`}</AlertTitle>
          <AlertDescription>
            Hand off to continue in a fresh conversation with a summary. Nothing is blocked.
            {handOff.reason ? ` ${handOff.reason}.` : ''}
          </AlertDescription>
          <AlertAction className="flex gap-1.5">
            <Button type="button" size="xs" disabled={handOff.disabled} onClick={handOff.run}>
              Hand off
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => useTokenGuardCallsStore.getState().dismissBanner(sessionId)}
            >
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      )}
    </>
  )
}
