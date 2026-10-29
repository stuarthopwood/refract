// #1284 (spec 040 FR-001): the Turn error row at the end of a turn that ended in a model error.
// OMP's error text is untrusted, so it renders as plain text, never markdown. Retry resends the
// unanswered prompt once. The row shows only while it is the last item of the transcript: any
// later item (a new user message, or OMP's own auto-retry output) means the turn moved on, so a
// stale Retry is never offered. No `data-pane-banner`: the composer always takes pane focus first.
// The hint's primary action is Retry for every kind: the renderer has no restart-agent or
// sign-in action to offer for TLS or auth errors yet.
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { notify, EMPTY_READOUT_ENTRY, EMPTY_TRANSCRIPT, useReadoutStore, useTranscriptStore } from '@/state'
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

/** The prompt text Retry can resend whole, or null when it cannot (images are blob refs with no
 * bytes here, and the file-attachment content is stripped from the transcript text). */
function resendableText(user: UserItem): string | null {
  if (hasAttachments(user)) return null
  return user.text.trim() === '' ? null : user.text
}

export function TurnErrorRow({ item, sessionId }: { item: TurnErrorItem; sessionId: string | null }) {
  const [sending, setSending] = React.useState(false)
  // One selector: SUPERSEDED when any later item exists, else the nearest earlier user item (or null).
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

  if (prompt === SUPERSEDED) return null
  const kind = classifyTurnError(item.text)
  const text = prompt ? resendableText(prompt) : null
  const needsReattach = !!prompt && hasAttachments(prompt)

  async function handleRetry() {
    if (!sessionId || !text || sending) return
    setSending(true)
    try {
      const result = await window.refract.chat.send(sessionId, text)
      if (!result.ok) {
        notify(result.error, sessionId)
        return
      }
      focusSessionPane(sessionId)
    } catch (error) {
      console.error('[refract] turn error retry failed', error)
      notify({ code: 'prompt-failed', message: 'Could not resend this prompt.' }, sessionId)
    } finally {
      setSending(false)
    }
  }

  return (
    <PaneBanner
      data-testid="turn-error-row"
      role="none"
      title={kind ? TURN_ERROR_HINTS[kind] : 'The model returned an error.'}
      detail={<ClampedContent maxHeight="5lh">{item.text}</ClampedContent>}
      className="px-2"
    >
      {needsReattach && !autoRetrying && (
        <span className="text-xs text-muted-foreground">Re-attach and resend from the composer.</span>
      )}
      {sessionId && text && !autoRetrying && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-disabled={sending || undefined}
          className="aria-disabled:opacity-50"
          onClick={() => void handleRetry()}
        >
          {sending ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </PaneBanner>
  )
}
