// OMP's error text is untrusted, so it renders as plain text, never markdown.
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { notify, EMPTY_READOUT_ENTRY, EMPTY_TRANSCRIPT, useReadoutStore, useSessionsStore, useTranscriptStore } from '@/state'
import { classifyTurnError, TURN_ERROR_HINTS } from '../../../shared/turnError'
import type { TranscriptItem } from '../../../shared/model'
import { ClampedContent } from '../../components/ClampedContent'
import { PaneBanner } from '../../components/PaneBanner'
import { focusSessionPane } from '../../lib/focus'

type TurnErrorItem = Extract<TranscriptItem, { kind: 'turn-error' }>
type UserItem = Extract<TranscriptItem, { kind: 'user' }>

const SUPERSEDED = Symbol('superseded')

function hasAttachments(user: UserItem): boolean {
  return (user.images?.length ?? 0) > 0 || (user.fileAttachments?.length ?? 0) > 0
}

function resendableText(user: UserItem): string | null {
  if (hasAttachments(user)) return null
  return user.text.trim() === '' ? null : user.text
}

export function TurnErrorRow({ item, sessionId }: { item: TurnErrorItem; sessionId: string | null }) {
  const [sending, setSending] = React.useState(false)
  const sendingRef = React.useRef(false)
  const retryHadFocus = React.useRef(false)
  const prompt = useTranscriptStore((s): UserItem | null | typeof SUPERSEDED => {
    const items = (sessionId ? s.bySession[sessionId] : undefined)?.items ?? EMPTY_TRANSCRIPT.items
    const index = items.findIndex((candidate) => candidate.id === item.id)
    if (index < 0) return null
    if (index < items.length - 1) return SUPERSEDED
    for (let i = index - 1; i >= 0; i--) {
      const candidate = items[i]
      if (candidate?.kind === 'user') return candidate
    }
    return null
  })

  // Same readout the Retry line reads: while OMP auto-retries, a manual Retry would double-send.
  const autoRetrying = useReadoutStore((s) => !!(sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.retry : null))

  const working = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'working')
  const blocked = autoRetrying || working

  React.useEffect(() => {
    if (!blocked || !retryHadFocus.current) return
    retryHadFocus.current = false
    const active = document.activeElement
    if (sessionId && (!active || active === document.body)) focusSessionPane(sessionId)
  }, [blocked, sessionId])

  if (prompt === SUPERSEDED) return null
  const kind = classifyTurnError(item.text)
  const text = prompt ? resendableText(prompt) : null
  const needsReattach = !!prompt && hasAttachments(prompt)

  async function handleRetry() {
    if (!sessionId || !text || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      const result = await window.refract.chat.send(sessionId, text)
      if (!result.ok) {
        notify(result.error, sessionId)
        sendingRef.current = false
        setSending(false)
        return
      }
      focusSessionPane(sessionId)
      return
    } catch (error) {
      console.error('[refract] turn error retry failed', error)
      notify({ code: 'prompt-failed', message: 'Could not resend this prompt.' }, sessionId)
    }
    sendingRef.current = false
    setSending(false)
  }

  const showHint = needsReattach && !blocked
  const showRetry = !!sessionId && !!text && !blocked

  const actions = (
    <>
      {showHint && (
        <span className="text-xs text-muted-foreground">Re-attach and resend from the composer.</span>
      )}
      {showRetry && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-disabled={sending || undefined}
          className="aria-disabled:opacity-50"
          onFocus={() => { retryHadFocus.current = true }}
          onBlur={() => { retryHadFocus.current = false }}
          onClick={() => void handleRetry()}
        >
          {sending ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </>
  )

  return (
    <PaneBanner
      data-testid="turn-error-row"
      role="none"
      title={kind ? TURN_ERROR_HINTS[kind] : 'The model returned an error.'}
      detail={<ClampedContent maxHeight="5lh">{item.text}</ClampedContent>}
      className="px-2"
    >
      {showHint || showRetry ? actions : undefined}
    </PaneBanner>
  )
}
