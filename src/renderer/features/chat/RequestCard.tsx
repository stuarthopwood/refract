import * as React from 'react'
import { CheckIcon, CircleQuestionMarkIcon, OctagonXIcon, XIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
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
import { UserAvatar } from '@/components/UserAvatar'
import { CodeBlock, inferOutputBlock, Markdown } from './Markdown'
import { AskCard } from './AskCard'
import { ApprovalActions } from './ApprovalActions'

type AskToolItem = Extract<TranscriptItem, { kind: 'tool' }>

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

interface AskOptionLike {
  label?: unknown
}

interface AskQuestionLike {
  id?: unknown
  question?: unknown
  options?: unknown
}

interface AskArgsLike {
  question?: unknown
  options?: unknown
  questions?: unknown
}

function readAskOption(option: unknown): string | undefined {
  if (typeof option === 'string') return option
  if (option && typeof option === 'object' && typeof (option as AskOptionLike).label === 'string') return (option as AskOptionLike).label as string
  return undefined
}

function readAskOptions(options: unknown): string[] {
  return (Array.isArray(options) ? options : []).map(readAskOption).filter((option): option is string => typeof option === 'string')
}

function readAskQuestions(args: unknown): { id?: string; question: string; options: string[] }[] {
  const record = args && typeof args === 'object' ? (args as AskArgsLike) : {}
  if (Array.isArray(record.questions) && record.questions.length > 0) {
    return record.questions
      .filter((entry): entry is AskQuestionLike => !!entry && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : undefined,
        question: typeof entry.question === 'string' ? entry.question : '',
        options: readAskOptions(entry.options)
      }))
  }
  const question = typeof record.question === 'string' ? record.question : ''
  return question ? [{ question, options: readAskOptions(record.options) }] : []
}

interface AskResultLike {
  id?: unknown
  selectedOptions?: unknown
  customInput?: unknown
  timedOut?: unknown
}

/** D22: option labels joined with ", ", then "Other: <text>" last, or "None selected" if none. */
function formatAskAnswerText(selectedOptions: string[], customInput: string, fallbackOutput?: string): string {
  const parts: string[] = []
  if (selectedOptions.length > 0) parts.push(selectedOptions.join(', '))
  if (customInput.trim()) parts.push(`Other: ${customInput.trim()}`)
  if (parts.length > 0) return parts.join(', ')
  return fallbackOutput && fallbackOutput.length > 0 ? fallbackOutput : 'None selected'
}

interface AskAnswer {
  text: string
  timedOut: boolean
}

function readAskAnswers(item: AskToolItem, questionIds: string[]): AskAnswer[] {
  const count = Math.max(questionIds.length, 1)
  if (item.status === 'error' || item.status === 'cancelled') return Array.from({ length: count }, () => ({ text: 'Cancelled', timedOut: false }))
  if (item.status === 'interrupted') return Array.from({ length: count }, () => ({ text: 'Question not answered', timedOut: false }))
  const details =
    item.details && typeof item.details === 'object'
      ? (item.details as { results?: unknown; selectedOptions?: unknown; customInput?: unknown; timedOut?: unknown })
      : undefined
  if (details && Array.isArray(details.results) && details.results.length > 0) {
    const byId: Record<string, AskResultLike> = {}
    for (const entry of details.results) {
      if (entry && typeof entry === 'object') {
        const result = entry as AskResultLike
        if (typeof result.id === 'string') byId[result.id] = result
      }
    }
    return questionIds.map((id) => {
      const result = byId[id]
      if (!result) return { text: 'None selected', timedOut: false }
      return {
        text: formatAskAnswerText(
          Array.isArray(result.selectedOptions) ? result.selectedOptions.filter((o): o is string => typeof o === 'string') : [],
          typeof result.customInput === 'string' ? result.customInput : ''
        ),
        timedOut: result.timedOut === true
      }
    })
  }
  const selectedOptions = details && Array.isArray(details.selectedOptions) ? details.selectedOptions.filter((o): o is string => typeof o === 'string') : []
  const customInput = details && typeof details.customInput === 'string' ? details.customInput : ''
  const timedOut = details?.timedOut === true
  return [{ text: formatAskAnswerText(selectedOptions, customInput, item.output), timedOut }]
}

type AskCallStatus = 'answered' | 'answered-automatically' | 'cancelled' | 'not-answered'

function askCallStatus(item: AskToolItem, answers: AskAnswer[]): AskCallStatus {
  if (item.status === 'error' || item.status === 'cancelled') return 'cancelled'
  if (item.status === 'interrupted') return 'not-answered'
  return answers.some((answer) => answer.timedOut) ? 'answered-automatically' : 'answered'
}

/** D22: an icon plus a word in the row's `meta` slot -- cancelling is never shown as an error. */
function AskStatusMeta({ status }: { status: AskCallStatus }) {
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1">
        <XIcon aria-hidden className="size-4" />
        Cancelled
      </span>
    )
  }
  if (status === 'not-answered') return <span>Question not answered</span>
  return (
    <span className="inline-flex items-center gap-1">
      <CheckIcon aria-hidden className="size-4" />
      {status === 'answered-automatically' ? 'Answered automatically' : 'Answered'}
    </span>
  )
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

interface AskQuestionRowProps {
  item: AskToolItem
  userName?: string
  userAvatarUrl?: string
  requestId?: string
  sessionId?: string
}

/** Transcript row for a resolved `ask` question and its answer. */
export function AskQuestionRow({ item, userName, userAvatarUrl, requestId, sessionId }: AskQuestionRowProps) {
  const questions = readAskQuestions(item.args)
  const answers = readAskAnswers(item, questions.map((question, index) => question.id ?? String(index)))
  const name = userName ?? 'You'
  const status = askCallStatus(item, answers)
  const firstQuestion = questions[0]?.question ?? ''
  const summary = questions.length > 1 ? `${firstQuestion} and ${questions.length - 1} more` : firstQuestion

  const intentKey = requestId && sessionId ? `${sessionId}:${requestId}` : undefined
  const triggerRef = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    if (consumeAskFocusPending(intentKey) && isFocusStranded(document.activeElement, null)) triggerRef.current?.focus()
  }, [intentKey])

  return (
    <CollapsedLine
      ref={triggerRef}
      icon={<CircleQuestionMarkIcon className="size-4 shrink-0 text-muted-foreground" />}
      label="Asked user"
      summary={summary}
      meta={<AskStatusMeta status={status} />}
    >
      <div className="space-y-2">
        {questions.map((question, index) => {
          const { heading, body } = splitQuestionHeading(question.question)
          const answer = answers[index] ?? answers[0]
          return (
            // eslint-disable-next-line react/no-array-index-key -- questions have no stable id on this read path
            <div key={index} className="space-y-1">
              {heading && (
                <Markdown id={`${item.id}-ask-heading-${index}`} text={heading} className="font-medium text-muted-foreground" />
              )}
              <Markdown
                id={`${item.id}-ask-body-${index}`}
                text={body}
                className="text-muted-foreground [&_p]:whitespace-pre-line"
              />
              {question.options.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {question.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-start gap-2 pl-4">
                <UserAvatar name={name} src={userAvatarUrl} size="xs" />
                <div className="text-sm">
                  <span className="text-muted-foreground">Answer: </span>
                  <span>{name}</span>
                  <span className="text-muted-foreground">: {answer?.text ?? 'None selected'}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </CollapsedLine>
  )
}

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

  async function answer(value: ChatAnswer, kind: ResolvedKind, detail?: string) {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const hadFocus = origin !== null && origin !== document.body
    setBusy(true)
    setError(null)
    const result = await window.refract.chat.answer(sessionId, request.requestId, value)
    if (!result.ok) refocusRef.current = origin
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
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
          className="max-h-56 space-y-2 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
