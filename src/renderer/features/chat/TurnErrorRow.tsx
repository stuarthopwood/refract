// #1284 (spec 040 FR-001): the Turn error row at the end of a turn that ended in a model error.
// OMP's error text is untrusted, so it renders as plain text, never markdown. Retry resends the
// unanswered prompt once; the row disappears as soon as any later user message exists (the new
// turn), so a second click is impossible.
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { notify, EMPTY_TRANSCRIPT, useTranscriptStore } from '@/state'
import { classifyTurnError, TURN_ERROR_HINTS } from '../../../shared/turnError'
import type { TranscriptItem } from '../../../shared/model'
import { PaneBanner } from '../../components/PaneBanner'

type TurnErrorItem = Extract<TranscriptItem, { kind: 'turn-error' }>

export function TurnErrorRow({ item, sessionId }: { item: TurnErrorItem; sessionId: string | null }) {
  const [sending, setSending] = React.useState(false)
  const superseded = useTranscriptStore((s) => {
    const items = (sessionId ? s.bySession[sessionId] : undefined)?.items ?? EMPTY_TRANSCRIPT.items
    const index = items.findIndex((candidate) => candidate.id === item.id)
    return index >= 0 && items.slice(index + 1).some((candidate) => candidate.kind === 'user')
  })
  const prompt = useTranscriptStore((s) => {
    const items = (sessionId ? s.bySession[sessionId] : undefined)?.items ?? EMPTY_TRANSCRIPT.items
    const index = items.findIndex((candidate) => candidate.id === item.id)
    for (let i = index - 1; i >= 0; i--) {
      const candidate = items[i]
      if (candidate?.kind === 'user') return candidate.text
    }
    return null
  })

  if (superseded) return null
  const kind = classifyTurnError(item.text)

  async function handleRetry() {
    if (!sessionId || !prompt || sending) return
    setSending(true)
    try {
      const result = await window.refract.chat.send(sessionId, prompt)
      if (!result.ok) {
        notify(
          result.error.code === 'agent-not-running'
            ? { code: result.error.code, message: 'The agent is not running for this Session.' }
            : result.error
        )
      }
    } catch {
      notify({ code: 'prompt-failed', message: 'Could not resend this prompt.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <PaneBanner
      data-testid="turn-error-row"
      title={kind ? TURN_ERROR_HINTS[kind] : 'The model returned an error.'}
      detail={item.text}
      className="py-2"
    >
      {sessionId && prompt && (
        <Button type="button" size="xs" variant="outline" aria-disabled={sending || undefined} onClick={() => void handleRetry()}>
          {sending ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </PaneBanner>
  )
}
