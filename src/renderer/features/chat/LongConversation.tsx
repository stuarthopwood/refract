// #1212 (spec 021, FR-014, FR-016, FR-020): the Status line's "Long conversation" readout and the
// pane banner repeating the offer, both with a real Hand off button. State is stated in text, not
// colour. The screen-reader announcement is one visually hidden `role="status"` whose text only
// changes when a threshold (300, 500) is crossed upward while mounted, so it is spoken once per
// threshold per Conversation, never per call and never on load; Hand off progress is announced
// through a second polite status.
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { focusSessionPane } from '@/lib/focus'
import { useSessionsStore } from '@/state'
import { useTokenGuardCallsStore } from '@/state/token-guard-calls-store'
import {
  LONG_CONVERSATION_BANNER_CALLS,
  LONG_CONVERSATION_BANNER_REPEAT,
  LONG_CONVERSATION_CALLS
} from '../../../shared/tokenGuard'
import { ReadoutItem } from './readout/ReadoutItem'

const DISABLED_BUTTON_CLASS = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

function useHandOff(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const handingOff = useTokenGuardCallsStore((s) => s.handingOff[sessionId] ?? false)
  const idle = status === 'idle'
  const disabled = handingOff || !idle
  return {
    disabled,
    reason: handingOff ? 'Handing off…' : idle ? null : 'Available when the Session is idle',
    // aria-disabled keeps the button focusable, so the guard lives here instead of `disabled`.
    run: () => {
      if (disabled) return
      void useTokenGuardCallsStore
        .getState()
        .handOff(sessionId)
        .then((ok) => {
          if (ok) focusSessionPane(sessionId)
        })
    }
  }
}

function announcementFor(calls: number): string {
  if (calls >= LONG_CONVERSATION_BANNER_CALLS) {
    return `Very long conversation, over ${LONG_CONVERSATION_BANNER_CALLS} model calls. Hand off to continue in a fresh conversation.`
  }
  return `Long conversation, over ${LONG_CONVERSATION_CALLS} model calls. You can hand off to a fresh conversation.`
}

// Text for the polite status: set only when a threshold is crossed upward after the first count
// arrived, so reopening a Session that is already past one stays silent.
function useThresholdAnnouncement(sessionId: string, calls: number | undefined): string {
  const previous = useRef<{ sessionId: string; calls: number | undefined }>({ sessionId, calls })
  const [text, setText] = useState('')
  useEffect(() => {
    const before = previous.current
    previous.current = { sessionId, calls }
    if (before.sessionId !== sessionId) {
      setText('')
      return
    }
    if (before.calls === undefined || calls === undefined) return
    const was = before.calls
    if ([LONG_CONVERSATION_CALLS, LONG_CONVERSATION_BANNER_CALLS].some((t) => was < t && calls >= t)) {
      setText(announcementFor(calls))
    } else if (calls < was) {
      setText('')
    }
  }, [sessionId, calls])
  return text
}

export function LongConversationChip({ sessionId }: { sessionId: string }) {
  const entryCalls = useTokenGuardCallsStore((s) => s.bySession[sessionId]?.calls)
  const notice = useTokenGuardCallsStore((s) => s.handoffNotice[sessionId] ?? '')
  const handOff = useHandOff(sessionId)
  const calls = entryCalls ?? 0
  const announcement = useThresholdAnnouncement(sessionId, entryCalls)
  const reasonId = `long-conversation-chip-reason-${sessionId}`
  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <span role="status" className="sr-only">
        {notice}
      </span>
      {calls >= LONG_CONVERSATION_CALLS && (
        <ReadoutItem>
          <span>{`Long conversation, ${calls} calls`}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-disabled={handOff.disabled}
            aria-describedby={handOff.reason ? reasonId : undefined}
            className={DISABLED_BUTTON_CLASS}
            onClick={handOff.run}
          >
            Hand off
          </Button>
          {handOff.reason && <span id={reasonId}>{handOff.reason}</span>}
        </ReadoutItem>
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
  const reasonId = `long-conversation-banner-reason-${sessionId}`
  return (
    <>
      {error && (
        <Alert variant="destructive" role="alert" data-slot="handoff-error">
          <AlertTitle>Hand off failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertActions>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                useTokenGuardCallsStore.getState().dismissHandoffError(sessionId)
                focusSessionPane(sessionId)
              }}
            >
              Dismiss
            </Button>
          </AlertActions>
        </Alert>
      )}
      {showBanner && (
        <Alert role="region" aria-label="Long conversation" data-slot="long-conversation-banner">
          <AlertTitle>{`Long conversation, ${calls} calls`}</AlertTitle>
          <AlertDescription>
            Hand off to continue in a fresh conversation with a summary. Nothing is blocked.
            {handOff.reason && <span id={reasonId}>{` ${handOff.reason}.`}</span>}
          </AlertDescription>
          <AlertActions>
            <Button
              type="button"
              size="xs"
              aria-disabled={handOff.disabled}
              aria-describedby={handOff.reason ? reasonId : undefined}
              className={DISABLED_BUTTON_CLASS}
              onClick={handOff.run}
            >
              Hand off
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                useTokenGuardCallsStore.getState().dismissBanner(sessionId)
                focusSessionPane(sessionId)
              }}
            >
              Dismiss
            </Button>
          </AlertActions>
        </Alert>
      )}
    </>
  )
}
