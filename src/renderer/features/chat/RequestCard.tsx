import * as React from 'react'
import { CheckIcon, CircleQuestionMarkIcon, XIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CollapsedLine } from './CollapsedLine'
import { consumeAskFocusPending, markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { isFocusStranded } from '@/lib/focus'
import { initials } from '@/lib/initials'
import { CodeBlock, inferOutputBlock, Markdown } from './Markdown'
import { AskCard } from './AskCard'

type AskToolItem = Extract<TranscriptItem, { kind: 'tool' }>

type ResolvedKind = 'approved' | 'denied' | 'answered' | 'cancelled'

const RESOLVED_LABEL: Record<ResolvedKind, string> = {
  approved: 'Approved',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'Cancelled'
}

/** The one-line row an approval collapses to, whether resolved just now (RequestCard) or
 * resolved before this Session was opened (Transcript). A resolved question never uses this any
 * more (T073): superseded by `AskQuestionRow` once the matching `ask` tool item lands.
 *
 * `requestId`/`sessionId` (gate round 2 D17; gate round 3: keyed by `${sessionId}:${requestId}`):
 * the BRIDGING row an Ask card's resolution swaps to before `AskQuestionRow` exists. Consumes a
 * pending intent on mount and focuses itself, but only when focus is stranded (gate round 3
 * Medium, all reviewers: unconditional `.focus()` could steal focus on a later mount). */
export function ResolvedRequestSummary({ resolved, detail, requestId, sessionId }: { resolved?: ResolvedKind; detail?: string; requestId?: string; sessionId?: string }) {
  const label = resolved ? RESOLVED_LABEL[resolved] : 'Resolved'
  // Gate-fix (round 1, Low, D22): a user's own Cancel is not an error, so it keeps the muted
  // `--muted-foreground` XIcon every other icon in this row already uses -- only an actual Deny
  // (a real tool-approval refusal) still reads as destructive.
  const icon =
    resolved === 'denied' ? (
      <XIcon className="size-3.5 shrink-0 text-destructive" />
    ) : resolved === 'cancelled' ? (
      <XIcon className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CheckIcon className="size-3.5 shrink-0 text-state-working" />
    )
  const intentKey = requestId && sessionId ? `${sessionId}:${requestId}` : undefined
  const rowRef = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    if (consumeAskFocusPending(intentKey) && isFocusStranded(document.activeElement, null)) rowRef.current?.focus()
  }, [intentKey])
  // Gate round 2 (D17, two-stage handoff): `AskQuestionRow` can supersede this row LATER -- re-
  // mark the intent on unmount if still focused. Gate round 3: shares the one-frame claim-or-drop
  // expiry (`markAskFocusPendingWithFallback`) instead of an unbounded re-mark.
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
  /** The real wire shape (live-verified, T077): a batch under `questions[]`, each with its own
   * `question` and `options: [{ label }]`. #572: every question in the batch now renders its own
   * block (D21), not only the first. */
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

/** #572: reads every question of the batch (previously only `questions[0]`, FR-045's answered
 * summary is now one row per call with a block per question, D21). Falls back to the flat
 * `question`/`options` shape for a pre-batch call. `id` is carried through so the answer side
 * can match by id instead of array position (gate-fix, round 1, Medium: a short or reordered
 * `details.results[]` used to show another question's answer under the wrong one). */
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

/** D22: option labels joined with ", ", then "Other: <text>" last, or "None selected" when
 * nothing was picked and nothing was typed. */
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

/** The per-question answer text for a resolved `ask` tool item (T073, FINDINGS item 22(a)-(c),
 * contracts/omp-usage.md "Chat line wire shapes"; #572 extends this to a batch's own
 * `details.results[]`, matched by `id`, one entry per question, D21). A cancelled or interrupted
 * call never answered any question, so every question shows that one word instead of attempting
 * to read `details`. `questionIds[i]` is the synthetic fallback `String(i)` for a legacy/flat
 * call whose single question carries no real `id` -- never ambiguous, since there is only one. */
function readAskAnswers(item: AskToolItem, questionIds: string[]): AskAnswer[] {
  const count = Math.max(questionIds.length, 1)
  if (item.status === 'error') return Array.from({ length: count }, () => ({ text: 'Cancelled', timedOut: false }))
  // Issue #510 slice 3 (PLAN.md row A0 evidence): "an unanswered ask renders as 'question not
  // answered'" -- the process died before the user's reply ever landed.
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
  // Gate-fix (round 1, Medium): `timedOut` sits at the TOP of a single-question call's `details`
  // (`ask.md`'s flattened single-question shape), not nested under a non-existent `results[]` --
  // reading it here is what lets `askCallStatus` ever show "Answered automatically" for one.
  const timedOut = details?.timedOut === true
  return [{ text: formatAskAnswerText(selectedOptions, customInput, item.output), timedOut }]
}

type AskCallStatus = 'answered' | 'answered-automatically' | 'cancelled' | 'not-answered'

function askCallStatus(item: AskToolItem, answers: AskAnswer[]): AskCallStatus {
  if (item.status === 'error') return 'cancelled'
  if (item.status === 'interrupted') return 'not-answered'
  return answers.some((answer) => answer.timedOut) ? 'answered-automatically' : 'answered'
}

/** D22: an icon plus a word in the row's `meta` slot -- cancelling is never shown as an error. */
function AskStatusMeta({ status }: { status: AskCallStatus }) {
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1">
        <XIcon aria-hidden className="size-3" />
        Cancelled
      </span>
    )
  }
  if (status === 'not-answered') return <span>Question not answered</span>
  return (
    <span className="inline-flex items-center gap-1">
      <CheckIcon aria-hidden className="size-3" />
      {status === 'answered-automatically' ? 'Answered automatically' : 'Answered'}
    </span>
  )
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
  requestId?: string // gate round 2/3: the focus intent key, see ResolvedRequestSummary's doc comment
  sessionId?: string
}

// The answered-question line (T073, FR-018, FR-045, docs/DESIGN.md "Chat"): a collapsed
// "Asked user:" row (question cut to one line) on the T080 baseline, expanding to the full
// question through the same sanitised-markdown heading/body renderer the live card uses (FR-018,
// issue #491), with an indented "Answer:" row below carrying a small round avatar of the user's
// initials, their name, and the answer ("Cancelled" for a cancelled question). Built from the
// agent's own `ask` tool item (T072): its `args` hold the question and options, its
// `output`/`details` the chosen answer, both of which survive a restart via `get_messages`,
// unlike the `request` item this supersedes once it resolves.
export function AskQuestionRow({ item, userName, requestId, sessionId }: AskQuestionRowProps) {
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
      icon={<CircleQuestionMarkIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      label="Asked user:"
      summary={summary}
      meta={<AskStatusMeta status={status} />}
    >
      <div className="space-y-3">
        {questions.map((question, index) => {
          const { heading, body } = splitQuestionHeading(question.question)
          const answer = answers[index] ?? answers[0]
          return (
            // eslint-disable-next-line react/no-array-index-key -- questions have no stable id on this read path
            <div key={index} className="space-y-1">
              {/* Dimmed to `--muted-foreground` (accessibility-auditor, round 2): matches the collapsed
               * summary above instead of the ambient `--foreground` this previously inherited, which
               * reads brighter than primary chat prose and inverted the secondary/bookkeeping hierarchy.
               * Rendered through the shared Markdown component (FR-018, issue #491) with the same
               * heading/body split as the live question card, so a question looks the same before and
               * after answering. */}
              {heading && (
                <Markdown id={`${item.id}-ask-heading-${index}`} text={heading} className="font-medium text-muted-foreground" />
              )}
              <Markdown
                id={`${item.id}-ask-body-${index}`}
                text={body}
                className="text-muted-foreground [&_p]:whitespace-pre-line"
              />
              {question.options.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {question.options.map((option) => (
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

/** D19 (fallback path): the selector fallback appends a trailing " (Recommended)" to the label
 * it expects back verbatim (`ask.md` l.28, 101), so the suffix is removed from what is SHOWN
 * (replaced by the same muted D11 marker the dialog path uses) while the ORIGINAL label,
 * suffix included, is still what gets sent. */
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

  // Gate round 2 (code review L7): checked only AFTER every hook above -- an early return before
  // them made the hook count depend on `request.kind`, which can change across renders.
  if (request.kind === 'ask') {
    return <AskCard sessionId={sessionId} request={request} />
  }

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
    return <ResolvedRequestSummary resolved={resolved.kind} detail={resolved.detail} requestId={request.requestId} sessionId={sessionId} />
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
            {request.options.map((option, index) => {
              // D18: same card, same full-width row styling as the dialog path's option rows
              // (`AskCard.tsx`'s `ASK_ROW_CLASS`), still a plain commit-on-click button with no
              // indicator -- a `select` takes one value, so a radio/tick look here would imply
              // an un-sent intermediate pick that does not exist on this path. D19: OMP's own
              // trailing " (Recommended)" is stripped from what is shown (replaced by the same
              // muted marker the dialog path uses) but the original label, suffix included, is
              // still what gets sent back.
              const { displayLabel, recommended } = splitRecommendedSuffix(option)
              return (
                <Button
                  key={option}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-choice-item
                  // Gate round 2 (architect M-a): the shared `outline` variant's own
                  // `dark:bg-input/30 dark:border-input dark:hover:bg-input/50` survives
                  // tailwind-merge alongside `bg-transparent hover:bg-muted` below (different
                  // CSS properties, so nothing drops either side), filling and edging this row
                  // like a button in every dark theme instead of like the dialog path's own
                  // transparent rows. `data-choice-item` squares the corners (globals.css), same
                  // as every other option row.
                  className="h-auto min-h-9 w-full flex-col items-start gap-1 whitespace-normal bg-transparent py-1.5 text-left hover:bg-muted dark:border-border dark:bg-transparent dark:hover:bg-muted"
                  onClick={() => void answer({ value: option }, 'answered', displayLabel)}
                >
                  {/* `w-full`/`break-words`/`min-w-0` (#497): the button's `items-start` sizes each
                   * flex-column child to its own content width (cross-axis `align-items: flex-start`
                   * never stretches), so without `w-full` here `break-words` has no constrained box
                   * to wrap inside and an unbreakable token (e.g. a long URL with no spaces) just
                   * overflows the button -- live-verified at 380px before this line was added. */}
                  <span className="w-full min-w-0 break-words text-sm font-medium">
                    {displayLabel}
                    {recommended && <span className="font-normal text-muted-foreground">, Recommended</span>}
                  </span>
                  {/* `optionDetails` is a plain string (main converts OMP's `{description?}` objects
                   * before it reaches here) -- rendered as text, never as an object. */}
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
        {/* D18/roundtable: Cancel is outline, matching the dialog path's own footer, not ghost
         * (components.md flags labelled ghost buttons). */}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer({ cancelled: true }, 'cancelled')}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  )
}
