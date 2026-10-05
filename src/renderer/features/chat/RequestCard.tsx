import * as React from 'react'
import { CheckIcon, CircleQuestionMarkIcon, XIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CollapsedLine } from './CollapsedLine'
import { initials } from '@/lib/initials'
import { CodeBlock, inferOutputBlock } from './Markdown'

type AskToolItem = Extract<TranscriptItem, { kind: 'tool' }>

type ResolvedKind = 'approved' | 'denied' | 'answered' | 'cancelled'

const RESOLVED_LABEL: Record<ResolvedKind, string> = {
  approved: 'Approved',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'Cancelled'
}

/** The one-line row an approval collapses to, whether resolved just now (RequestCard) or
 * resolved before this Session was opened (Transcript, which then only has
 * `TranscriptItem.resolved`, not the original request detail). Built on the T080 baseline. A
 * resolved question never uses this any more (T073): it is superseded by `AskQuestionRow` once
 * the matching `ask` tool item lands. */
export function ResolvedRequestSummary({ resolved, detail }: { resolved?: ResolvedKind; detail?: string }) {
  const label = resolved ? RESOLVED_LABEL[resolved] : 'Resolved'
  const denied = resolved === 'denied' || resolved === 'cancelled'
  return (
    <CollapsedLine
      icon={denied ? <XIcon className="size-3.5 shrink-0 text-destructive" /> : <CheckIcon className="size-3.5 shrink-0 text-state-working" />}
      label={label}
      summary={detail}
    />
  )
}

interface AskOptionLike {
  label?: unknown
}

interface AskArgsLike {
  question?: unknown
  options?: unknown
  /** The real wire shape (live-verified, T077): a batch under `questions[]`, each with its own
   * `question` and `options: [{ label }]` -- not the flat `question`/`options` FINDINGS item 22
   * documented only for the ANSWER side (`details`). A multi-question batch renders only the
   * first; OMP's own batching beyond one question is outside what this task covers. */
  questions?: unknown
}

function readAskOption(option: unknown): string | undefined {
  if (typeof option === 'string') return option
  if (option && typeof option === 'object' && typeof (option as AskOptionLike).label === 'string') return (option as AskOptionLike).label as string
  return undefined
}

function readAskArgs(args: unknown): { question: string; options: string[] } {
  const record = args && typeof args === 'object' ? (args as AskArgsLike) : {}
  const first =
    Array.isArray(record.questions) && record.questions.length > 0 && record.questions[0] && typeof record.questions[0] === 'object'
      ? (record.questions[0] as AskArgsLike)
      : record
  const question = typeof first.question === 'string' ? first.question : typeof record.question === 'string' ? record.question : ''
  const rawOptions = Array.isArray(first.options) ? first.options : Array.isArray(record.options) ? record.options : []
  const options = rawOptions.map(readAskOption).filter((o): o is string => typeof o === 'string')
  return { question, options }
}

interface AskDetailsLike {
  selectedOptions?: unknown
  customInput?: unknown
}

/** The answer text for a resolved `ask` tool item (T073, FINDINGS item 22(a)-(c),
 * contracts/omp-usage.md "Chat line wire shapes"): a cancelled ask is `status: 'error'` with an
 * empty `details`, read as the literal word "Cancelled" rather than OMP's fixed error sentence;
 * free text prefers `details.customInput` (the only reliable source for it); multiple choice
 * prefers `details.selectedOptions`, falling back to the tool's own output text. */
function askAnswer(item: AskToolItem): string {
  if (item.status === 'error') return 'Cancelled'
  const details = item.details && typeof item.details === 'object' ? (item.details as AskDetailsLike) : undefined
  if (details && typeof details.customInput === 'string') return details.customInput
  if (details && Array.isArray(details.selectedOptions)) {
    return details.selectedOptions.filter((o): o is string => typeof o === 'string').join(', ')
  }
  return item.output ?? ''
}

interface AskQuestionRowProps {
  item: AskToolItem
  userName?: string
}

// The answered-question line (T073, FR-018, FR-045, docs/DESIGN.md "Chat"): a collapsed
// "Asked user:" row (question cut to one line) on the T080 baseline, expanding to the full
// question and its options as plain text, with an indented "Answer:" row below carrying a small
// round avatar of the user's initials, their name, and the answer ("Cancelled" for a cancelled
// question). Built from the agent's own `ask` tool item (T072): its `args` hold the question and
// options, its `output`/`details` the chosen answer, both of which survive a restart via
// `get_messages`, unlike the `request` item this supersedes once it resolves.
export function AskQuestionRow({ item, userName }: AskQuestionRowProps) {
  const { question, options } = readAskArgs(item.args)
  const answer = askAnswer(item)
  const name = userName ?? 'You'

  return (
    <CollapsedLine
      icon={<CircleQuestionMarkIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      label="Asked user:"
      summary={question}
    >
      {/* Dimmed to `--muted-foreground` (accessibility-auditor, round 2): matches the collapsed
       * summary above instead of the ambient `--foreground` this previously inherited, which
       * reads brighter than primary chat prose and inverted the secondary/bookkeeping hierarchy. */}
      <div className="whitespace-pre-wrap text-sm text-muted-foreground">{question}</div>
      {options.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          {options.map((option) => (
            <li key={option}>{option}</li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2 pl-4">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium"
        >
          {initials(name)}
        </span>
        <div className="text-sm">
          <span className="text-muted-foreground">Answer: </span>
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">: {answer}</span>
        </div>
      </div>
    </CollapsedLine>
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
  // An approval card's detail lines are joined back into one text block and run through the same
  // JSON/diff inference every other tool/code surface uses (docs/DESIGN.md "Every JSON-shaped
  // tool/code surface uses `CodeBlock`") instead of rendering as a raw stack of plain `<div>`s.
  const approvalDetailBlock = React.useMemo(
    () => inferOutputBlock(request.kind === 'approval' ? request.details.join('\n') : ''),
    [request]
  )

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
      <Card size="sm">
        <CardHeader>
          <CardTitle>Allow tool: {request.tool}</CardTitle>
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
    <Card size="sm">
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
