import * as React from 'react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { PendingRequest } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type ResolvedKind = 'approved' | 'denied' | 'answered' | 'cancelled'

const RESOLVED_LABEL: Record<ResolvedKind, string> = {
  approved: 'Approved',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'Cancelled'
}

/** The one-line row a request collapses to, whether resolved just now (RequestCard) or resolved
 * before this Session was opened (Transcript, which then only has `TranscriptItem.resolved`, not
 * the original request detail). */
export function ResolvedRequestSummary({ resolved, detail }: { resolved?: ResolvedKind; detail?: string }) {
  const label = resolved ? RESOLVED_LABEL[resolved] : 'Resolved'
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      {label}
      {detail ? `: ${detail}` : ''}
    </div>
  )
}

interface RequestCardProps {
  sessionId: string
  request: PendingRequest
}

// An approval card (Approve/Deny) or a question card (options, optional free text, Cancel),
// rendered inline where the request arrived (docs/DESIGN.md "Chat"). Resolves itself: on a
// successful answer it swaps to the same one-line summary Transcript uses once the request is
// no longer pending, so there is no gap waiting for the main process round trip.
export function RequestCard({ sessionId, request }: RequestCardProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState<{ kind: ResolvedKind; detail?: string } | null>(null)
  const [text, setText] = React.useState('')

  async function answer(value: ChatAnswer, kind: ResolvedKind, detail?: string) {
    setBusy(true)
    setError(null)
    const result = await window.refract.chat.answer(sessionId, request.requestId, value)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setResolved({ kind, detail })
  }

  if (resolved) {
    return <ResolvedRequestSummary resolved={resolved.kind} detail={resolved.detail} />
  }

  if (request.kind === 'approval') {
    return (
      <Card size="sm" className="max-w-[60ch]">
        <CardHeader>
          <CardTitle>Allow tool: {request.tool}</CardTitle>
          <CardDescription className="truncate" title={request.target}>
            {request.target}
          </CardDescription>
        </CardHeader>
        {request.details.length > 0 && (
          <CardContent className="space-y-0.5 text-xs text-muted-foreground">
            {request.details.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </CardContent>
        )}
        {error && (
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        <CardFooter className="gap-2">
          <Button size="sm" disabled={busy} onClick={() => void answer({ approve: true }, 'approved')}>
            Approve
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void answer({ approve: false }, 'denied')}>
            Deny
          </Button>
        </CardFooter>
      </Card>
    )
  }

  const trimmedText = text.trim()

  return (
    <Card size="sm" className="max-w-[60ch]">
      <CardHeader>
        <CardTitle>{request.title}</CardTitle>
        {request.message && <CardDescription>{request.message}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-2">
        {request.inputKind === 'confirm' && (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void answer({ confirmed: true }, 'answered', 'Yes')}>
              Yes
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer({ confirmed: false }, 'answered', 'No')}>
              No
            </Button>
          </div>
        )}
        {request.inputKind === 'choice' && (
          <div className="flex flex-wrap gap-2">
            {request.options.map((option, index) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                disabled={busy}
                className="h-auto flex-col items-start gap-0 py-1"
                onClick={() => void answer({ value: option }, 'answered', option)}
              >
                <span>{option}</span>
                {/* `optionDetails` is a plain string (main converts OMP's `{description?}` objects
                 * before it reaches here) -- rendered as text, never as an object. */}
                {request.optionDetails?.[index] && (
                  <span className="font-normal text-muted-foreground">{request.optionDetails[index]}</span>
                )}
              </Button>
            ))}
          </div>
        )}
        {request.inputKind === 'text' && (
          <div className="flex gap-2">
            <Input
              value={text}
              disabled={busy}
              placeholder="Type an answer"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && trimmedText) void answer({ value: trimmedText }, 'answered', trimmedText)
              }}
            />
            <Button size="sm" disabled={busy || !trimmedText} onClick={() => void answer({ value: trimmedText }, 'answered', trimmedText)}>
              Send
            </Button>
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer({ cancelled: true }, 'cancelled')}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  )
}
