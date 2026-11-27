import * as React from 'react'
import { CheckIcon, OctagonXIcon, XIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { PendingRequest } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/SecretInput'
import { OPTION_FILL_CLASS, OPTION_RECOMMENDED_FILL_CLASS } from '@/components/ui/checkbox'
import { RecommendedBadge } from '@/components/RecommendedBadge'
import { cn } from '@/lib/utils'
import { ToolIcon } from '@/components/ToolIcon'
import { resolveToolDisplay } from './toolDisplay'
import { CollapsedLine } from './CollapsedLine'
import { consumeAskFocusPending, markAskFocusPending, markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { isFocusStranded } from '@/lib/focus'
import { CodeBlock, inferOutputBlock, Markdown } from './Markdown'
import { AskCard } from './AskCard'
import { FormRequestCard } from './askForm/FormRequestCard'
import { sendAnswer } from './askAnswerError'
import { ApprovalActions } from './ApprovalActions'

type ResolvedKind = 'approved' | 'denied' | 'answered' | 'cancelled'

const RESOLVED_LABEL: Record<ResolvedKind, string> = {
  approved: 'Approved',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'Cancelled'
}

/** Bridge row shown for a resolved request until the matching `ask` tool item lands. */
export function ResolvedRequestSummary({ resolved, detail, requestId, sessionId }: { resolved?: ResolvedKind; detail?: string; requestId?: string; sessionId?: string }) {
  const label = resolved ? RESOLVED_LABEL[resolved] : 'Resolved'
  const icon =
    resolved === 'denied' ? (
      <XIcon className="size-4 shrink-0 text-destructive" />
    ) : resolved === 'cancelled' ? (
      <XIcon className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      <CheckIcon className="size-4 shrink-0 text-state-working" />
    )
  const intentKey = requestId && sessionId ? `${sessionId}:${requestId}` : undefined
  const rowRef = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    if (consumeAskFocusPending(intentKey) && isFocusStranded(document.activeElement, null)) rowRef.current?.focus()
  }, [intentKey])
  React.useLayoutEffect(() => {
    return () => {
      if (document.activeElement === rowRef.current) markAskFocusPendingWithFallback(intentKey, sessionId)
    }
  }, [intentKey, sessionId])
  return <CollapsedLine ref={rowRef} icon={icon} label={label} summary={detail} />
}

/** Splits a leading heading line from the question body. */
export function splitQuestionHeading(text: string): { heading: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  const newlineIndex = normalized.indexOf('\n')
  if (newlineIndex === -1) return { heading: null, body: normalized }
  const rawFirstLine = normalized.slice(0, newlineIndex)
  const heading = rawFirstLine.trim()
  const body = normalized.slice(newlineIndex + 1).replace(/^(?:[ \t]*\n)+/, '')
  const bodyFirstLineEnd = body.indexOf('\n')
  const bodyFirstLine = bodyFirstLineEnd === -1 ? body : body.slice(0, bodyFirstLineEnd)
  if (
    !heading ||
    !body.trim() ||
    /^(    |\t)/.test(rawFirstLine) ||
    MARKDOWN_BLOCK_START.test(heading) ||
    THEMATIC_BREAK.test(heading) ||
    SETEXT_UNDERLINE.test(bodyFirstLine)
  ) {
    return { heading: null, body: normalized }
  }
  return { heading, body }
}

const MARKDOWN_BLOCK_START = /^(```|~~~|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/

const THEMATIC_BREAK = /^([-*_])(?:\s*\1){2,}$/

const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/

const FALLBACK_RECOMMENDED_SUFFIX = ' (Recommended)'

function splitRecommendedSuffix(label: string): { displayLabel: string; recommended: boolean } {
  if (label.endsWith(FALLBACK_RECOMMENDED_SUFFIX)) {
    return { displayLabel: label.slice(0, -FALLBACK_RECOMMENDED_SUFFIX.length), recommended: true }
  }
  return { displayLabel: label, recommended: false }
}

interface RequestCardProps {
  sessionId: string
  request: PendingRequest
}

/** Card for a pending approval or ask request. */
export function RequestCard({ sessionId, request }: RequestCardProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState<{ kind: ResolvedKind; detail?: string } | null>(null)
  const [text, setText] = React.useState('')
  const refocusRef = React.useRef<HTMLElement | null>(null)
  // A failed answer re-enables controls that `busy` disabled (and blurred); put focus back where it was.
  React.useLayoutEffect(() => {
    const target = refocusRef.current
    if (busy || !target) return
    refocusRef.current = null
    if (target.isConnected && isFocusStranded(document.activeElement, null)) target.focus()
  }, [busy])
  const approvalDetailBlock = React.useMemo(
    () => inferOutputBlock(request.kind === 'approval' ? request.details.join('\n') : ''),
    [request]
  )

  if (request.kind === 'ask') {
    return <AskCard sessionId={sessionId} request={request} />
  }

  if (request.kind === 'form') {
    return <FormRequestCard key={request.requestId} sessionId={sessionId} request={request} />
  }

  async function answer(value: ChatAnswer, kind: ResolvedKind, detail?: string) {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const hadFocus = origin !== null && origin !== document.body
    setBusy(true)
    setError(null)
    const failure = await sendAnswer(sessionId, request.requestId, value)
    if (failure !== null) refocusRef.current = origin
    setBusy(false)
    if (failure !== null) {
      setError(failure)
      return
    }
    // Armed at the swap, not before the await: busy disables the focused control and the summary row must claim focus.
    if (hadFocus) markAskFocusPending(`${sessionId}:${request.requestId}`)
    setResolved({ kind, detail })
    if (request.kind === 'question' && request.secret) setText('')
  }

  if (resolved) {
    return <ResolvedRequestSummary resolved={resolved.kind} detail={resolved.detail} requestId={request.requestId} sessionId={sessionId} />
  }

  if (request.kind === 'approval') {
    return (
      <Card size="sm" className="bg-approval-card-bg text-approval-card-fg ring-approval-card-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ToolIcon icon={resolveToolDisplay(request.tool).icon} />Allow tool: {request.tool}</CardTitle>
          <CardDescription className="truncate" title={request.target}>
            {request.target}
          </CardDescription>
        </CardHeader>
        {request.details.length > 0 && (
          <CardContent>
            <CodeBlock code={approvalDetailBlock.code} lang={approvalDetailBlock.lang} wrap />
          </CardContent>
        )}
        {error && (
          <CardContent>
            <Alert variant="destructive" box="inline">
              <OctagonXIcon aria-hidden /><AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        <CardFooter>
          <ApprovalActions options={request.options} busy={busy} onAnswer={(value, kind, detail) => void answer(value, kind, detail)} />
        </CardFooter>
      </Card>
    )
  }

  const trimmedText = text.trim()
  const answerValue = request.secret ? text : trimmedText
  const answerSummary = request.secret ? 'Secret entered' : trimmedText
  const textFieldProps = {
    value: text,
    disabled: busy,
    placeholder: request.secret ? 'Enter the secret' : 'Type an answer',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && trimmedText) void answer({ value: answerValue }, 'answered', answerSummary)
    }
  }
  const { heading, body } = splitQuestionHeading(request.title)
  const safeRequestId = request.requestId.replace(/[^a-zA-Z0-9_-]/g, '-')
  const headingTitleId = `${safeRequestId}-ask-heading-title`
  const bodyTextId = `${safeRequestId}-ask-question-text`
  const hasBody = body.trim().length > 0
  const isMultilineBody = body.trim().includes('\n')
  const groupAriaLabelledBy = heading ? headingTitleId : hasBody && !isMultilineBody ? bodyTextId : undefined
  const groupAriaLabel = !heading && (!hasBody || isMultilineBody) ? 'Question' : undefined
  const groupAriaDescribedBy = !heading && hasBody && isMultilineBody ? bodyTextId : undefined

  return (
    <Card
      size="sm"
      className="bg-chat-card-bg"
      role="group"
      aria-labelledby={groupAriaLabelledBy}
      aria-label={groupAriaLabel}
      aria-describedby={groupAriaDescribedBy}
    >
      {heading && (
        <CardHeader>
          <CardTitle id={headingTitleId}>
            <Markdown id={`${safeRequestId}-ask-heading`} text={heading} />
          </CardTitle>
        </CardHeader>
      )}
      {(hasBody || request.message) && (
        <CardContent
          tabIndex={0}
          role="region"
          aria-label="Question"
          className="max-h-56 space-y-2 overflow-y-auto outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring focus-visible:ring-inset"
        >
          {hasBody && (
            <div id={bodyTextId}>
              <Markdown id={`${safeRequestId}-ask-body`} text={body} className="[&_p]:whitespace-pre-line" />
            </div>
          )}
          {request.message && (
            <Markdown id={`${safeRequestId}-ask-message`} text={request.message} className="text-muted-foreground" />
          )}
        </CardContent>
      )}
      <CardContent className="space-y-2">
        {request.inputKind === 'confirm' && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer({ confirmed: false }, 'answered', 'No')}>
              No
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void answer({ confirmed: true }, 'answered', 'Yes')}>
              Yes
            </Button>
          </div>
        )}
        {request.inputKind === 'choice' && (
          <div className="flex flex-col gap-2">
            {request.options.map((option, index) => {
              const { displayLabel, recommended } = splitRecommendedSuffix(option)
              return (
                <Button
                  key={option}
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  data-choice-item
                  className={cn("h-auto min-h-9 w-full flex-col items-start gap-1 whitespace-normal py-1 text-left", OPTION_FILL_CLASS, recommended && OPTION_RECOMMENDED_FILL_CLASS)}
                  onClick={() => void answer({ value: option }, 'answered', displayLabel)}
                >
                  <span className="w-full min-w-0 break-words text-sm">
                    {displayLabel}
                    {recommended && <RecommendedBadge />}
                  </span>
                  {request.optionDetails?.[index] && (
                    <span className="w-full min-w-0 break-words text-xs font-normal text-muted-foreground">{request.optionDetails[index]}</span>
                  )}
                </Button>
              )
            })}
          </div>
        )}
        {request.inputKind === 'text' && (
          <div className="flex gap-2">
            {request.secret ? (
              <SecretInput
                {...textFieldProps}
                wrapperClassName="flex-1"
                aria-labelledby={groupAriaLabelledBy}
                aria-label={groupAriaLabelledBy ? undefined : 'Secret'}
              />
            ) : (
              <Input
                {...textFieldProps}
                aria-labelledby={groupAriaLabelledBy}
                aria-label={groupAriaLabelledBy ? undefined : 'Answer'}
              />
            )}
            <Button size="sm" disabled={busy || !trimmedText} onClick={() => void answer({ value: answerValue }, 'answered', answerSummary)}>
              Send
            </Button>
          </div>
        )}
        {error && (
          <Alert variant="destructive" box="inline">
            <OctagonXIcon aria-hidden /><AlertDescription>{error}</AlertDescription>
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
