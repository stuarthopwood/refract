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
import { CodeBlock, inferOutputBlock, Markdown } from './Markdown'

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

/** FR-018 (issue #491): a question with more than one line shows its first line as a short
 * heading of medium weight, with the rest rendered as the body; a single-line question has no
 * separate heading, only a body. Splits on the raw text's own newline, not on markdown block
 * boundaries -- the agent's question is plain multi-line text, and the markdown renderer turns
 * each half into its own blocks independently. A first line that is itself the start of a
 * markdown block (a fence, a list/blockquote marker, a table row, an ATX heading, a thematic
 * break, or a 4-space/tab indented code line) is never promoted to a heading (quality gate, a11y
 * round 3, issue #491 finding 3; round 4 finding 3): splitting there would produce a bogus
 * heading and, for a fence or indented code line, an unclosed/misrendered code block in the
 * remaining body. The indent check runs on the RAW first line, before trimming, since trimming
 * is exactly what would erase the leading whitespace that makes it a code line. */
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

// A markdown fence (```/~~~), ATX heading (#), blockquote (>), table row (|), or list marker
// (bullet or ordered) at the start of a line -- the shapes `splitQuestionHeading` must never cut
// off as a bare heading string, since react-markdown then parses the remainder as a separate,
// usually broken, block.
const MARKDOWN_BLOCK_START = /^(```|~~~|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/

// A thematic break (CommonMark: three or more matching `-`/`*`/`_`, optionally space-separated,
// alone on the line) -- also never promoted to a heading (quality gate, a11y round 4, issue #491
// finding 3), since react-markdown renders it as an `<hr>`, not text.
const THEMATIC_BREAK = /^([-*_])(?:\s*\1){2,}$/

// A setext heading underline (CommonMark: one or more `=` or up to three leading spaces then
// `-`, alone on the line, trailing spaces allowed) as the BODY's first non-blank line. Splitting
// the question here would separate that underline from the line it underlines, so the heading
// would be wrong (gate cycle 3, issue #491 finding 2; gate cycle 5 finding 3). Suppressing the
// split falls back to rendering the whole normalised text as one body, exactly as the agent sent
// it: `Q\n---` renders as `<h2>` (`===` as `<h1>`, per `Markdown.tsx`'s heading renderer), and an
// underline after a blank line renders as `<hr>` (`---`) or literal text (`===`).
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/

interface AskQuestionRowProps {
  item: AskToolItem
  userName?: string
}

// The answered-question line (T073, FR-018, FR-045, docs/DESIGN.md "Chat"): a collapsed
// "Asked user:" row (question cut to one line) on the T080 baseline, expanding to the full
// question through the same sanitised-markdown heading/body renderer the live card uses (FR-018,
// issue #491), with an indented "Answer:" row below carrying a small round avatar of the user's
// initials, their name, and the answer ("Cancelled" for a cancelled question). Built from the
// agent's own `ask` tool item (T072): its `args` hold the question and options, its
// `output`/`details` the chosen answer, both of which survive a restart via `get_messages`,
// unlike the `request` item this supersedes once it resolves.
export function AskQuestionRow({ item, userName }: AskQuestionRowProps) {
  const { question, options } = readAskArgs(item.args)
  const answer = askAnswer(item)
  const name = userName ?? 'You'
  const { heading, body } = splitQuestionHeading(question)

  return (
    <CollapsedLine
      icon={<CircleQuestionMarkIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      label="Asked user:"
      summary={question}
    >
      {/* Dimmed to `--muted-foreground` (accessibility-auditor, round 2): matches the collapsed
       * summary above instead of the ambient `--foreground` this previously inherited, which
       * reads brighter than primary chat prose and inverted the secondary/bookkeeping hierarchy.
       * Rendered through the shared Markdown component (FR-018, issue #491) with the same
       * heading/body split as the live question card, so a question looks the same before and
       * after answering. */}
      {heading && (
        <Markdown id={`${item.id}-ask-heading`} text={heading} className="font-medium text-muted-foreground" />
      )}
      <Markdown
        id={`${item.id}-ask-body`}
        text={body}
        className="text-muted-foreground [&_p]:whitespace-pre-line"
      />
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
  // FR-018 (issue #491): the whole question used to sit in `CardTitle`'s bold/medium-weight
  // style, over-emphasising even a long multi-paragraph question. Now only a genuine first-line
  // heading (when the question has more than one line) uses that style; the body always renders
  // through the shared sanitised-markdown `Markdown` component at normal weight, in its own
  // maximum-height scrolling region so a long question never pushes the options or Cancel off
  // screen (WCAG 1.4.10).
  const { heading, body } = splitQuestionHeading(request.title)
  // Accessible name plumbing for the card (quality gate, a11y round 3, issue #491 findings 1-2;
  // round 4 finding 1; gate cycle 3 findings 3-5): `CardTitle`/`CardContent` are plain `div`s
  // with no implicit name or landmark role, so the card is wrapped in `role="group"` whose name
  // comes from whichever element holds the question's visible name. With a heading, that is the
  // heading wrapper. Without one, a single-line body (one short paragraph, no newline) still
  // reads naturally as the group's name via `aria-labelledby`; a multi-line/long body would
  // otherwise make the entire body text the group's accessible name, so the group instead gets a
  // literal `aria-label="Question"` with `aria-describedby` pointing at the body for its
  // description. An empty title (input/editor/confirm frames send `title: ''`, main/omp/
  // dialogs.ts:61,66) leaves no heading AND no body: the group falls back to the same literal
  // `aria-label="Question"`, and the scroll region below is skipped entirely rather than
  // rendering an empty focusable area (gate cycle 3 finding 3). The group must NOT borrow its
  // name from the surrounding scroll region: that region carries its own `aria-label="Question"`
  // (below), and in the accessible-name computation an element's own `aria-label` wins over a
  // name borrowed via `aria-labelledby` from a *descendant* that itself has one, so labelling the
  // group from the region collapsed its name to the literal word "Question" instead of the
  // question text (verified via the CDP accessibility tree).
  // `requestId` arrives from the main process and is sanitised the same way `Markdown.tsx`'s
  // `footnotePrefix` sanitises its own id source, since it ends up raw inside `id`/
  // `aria-labelledby`/`aria-describedby` attributes (gate cycle 3 finding 5).
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
      {/* `tabIndex`/`role="region"`/`aria-label` match the pattern `Markdown.tsx`'s `CodeBlock`
       * uses for its own scrollable region (quality gate, a11y round 3, issue #491 finding 1):
       * keyboard-reachable and named on its own, since nothing else in the card is otherwise
       * focusable when the question overflows its max height. Skipped entirely when there is no
       * body and no message (gate cycle 3 finding 3), e.g. an empty title, so no empty focusable
       * region is left behind. */}
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
          <div className="flex flex-col gap-2">
            {request.options.map((option, index) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                disabled={busy}
                className="h-auto w-full flex-col items-start gap-0 whitespace-normal py-1.5 text-left"
                onClick={() => void answer({ value: option }, 'answered', option)}
              >
                {/* `w-full`/`break-words`/`min-w-0` (#497): the button's `items-start` sizes each
                 * flex-column child to its own content width (cross-axis `align-items: flex-start`
                 * never stretches), so without `w-full` here `break-words` has no constrained box
                 * to wrap inside and an unbreakable token (e.g. a long URL with no spaces) just
                 * overflows the button -- live-verified at 380px before this line was added. */}
                <span className="w-full min-w-0 break-words font-medium">{option}</span>
                {/* `optionDetails` is a plain string (main converts OMP's `{description?}` objects
                 * before it reaches here) -- rendered as text, never as an object. */}
                {request.optionDetails?.[index] && (
                  <span className="w-full min-w-0 break-words font-normal text-muted-foreground">{request.optionDetails[index]}</span>
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
