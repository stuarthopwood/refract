import * as React from 'react'
import { CheckIcon, Loader2Icon, OctagonXIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { AskQuestion, PendingRequest } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { type AskDraftQuestion, EMPTY_ASK_QUESTION_DRAFT, useAskPicksStore } from '@/state/ask-picks-store'
import { Markdown } from './Markdown'
import { splitQuestionHeading } from './RequestCard'

// New for #572: the structured multi-question dialog path (`PendingRequest` kind `ask`), built
// only once `set_ask_dialog` is confirmed enabled for this OMP process (contracts/omp-usage.md
// "Start-up sequence"). The one-question-at-a-time `select`/`input`/`editor`/`confirm` fallback
// stays `RequestCard.tsx`'s own `kind: 'question'` branch, restyled to match (decision D18/D19).

type AskRequest = Extract<PendingRequest, { kind: 'ask' }>

interface AskCardProps {
  sessionId: string
  request: AskRequest
}

/** Row classes shared by every option row (radio and checkbox alike): a transparent background
 * (so the card's own surface shows through, decision D9), a muted hover, and a 36px minimum
 * target (WCAG 2.5.8). Named for what it governs, not the primitive it happens to sit on (code
 * review Low, round 1). */
const ASK_ROW_CLASS = 'gap-1 bg-transparent hover:bg-muted min-h-9 py-1.5'

/** D13: a single choice is complete once a real option is picked or Other carries text; a
 * multiple choice is complete once its tab has been opened, even with nothing ticked (D15: an
 * empty multi-select answer is allowed). */
function isQuestionComplete(question: AskQuestion, draft: AskDraftQuestion): boolean {
  if (question.multi) return draft.viewed
  return draft.selectedOptions.length > 0 || (draft.otherSelected && draft.customInput.trim().length > 0)
}

/** D4: one `answers` entry per question, in request order, each `id` copied exactly; a single
 * choice sends exactly one option or `customInput`, never both; a multiple choice sends any
 * number of options plus `customInput` when its own Other checkbox is ticked and non-empty. */
function buildAnswers(questions: AskQuestion[], byQuestionId: Record<string, AskDraftQuestion>) {
  return questions.map((question) => {
    const draft = byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT
    const trimmedInput = draft.customInput.trim()
    if (question.multi) {
      const customInput = draft.otherTicked && trimmedInput ? trimmedInput : undefined
      return { id: question.id, selectedOptions: draft.selectedOptions, ...(customInput ? { customInput } : {}) }
    }
    if (draft.otherSelected && trimmedInput) {
      return { id: question.id, selectedOptions: [], customInput: trimmedInput }
    }
    return { id: question.id, selectedOptions: draft.selectedOptions }
  })
}

/** Whether a question's `recommended` index actually names one of its own options (`ask.md` l.28:
 * an out-of-range index gets no preference at all). */
function hasRecommended(question: AskQuestion): boolean {
  return question.recommended !== undefined && question.recommended >= 0 && question.recommended < question.options.length
}

/** D16: a static deadline line, never a ticking countdown -- OMP owns the timer. */
function formatDeadlineText(deadlineAt: number, questions: AskQuestion[]): string {
  const time = new Date(deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const anyRecommended = questions.some(hasRecommended)
  return anyRecommended
    ? `If there's no answer by ${time}, the agent uses the recommended answers.`
    : `If there's no answer by ${time}, the agent uses the first option for each question.`
}

/** Focuses the checked option in `container` if one exists, else the first option -- used after
 * Next and the incomplete-question jump move the active tab (decision D13/D23). Never called on
 * tab-click or arrival (D25). */
function focusFirstOrCheckedOption(container: HTMLElement | null): void {
  if (!container) return
  const checked = container.querySelector<HTMLElement>('[role=radio][data-state=checked], [role=checkbox][data-state=checked]')
  const first = container.querySelector<HTMLElement>('[role=radio], [role=checkbox]')
  ;(checked ?? first)?.focus()
}

/** A sentinel value for the always-visible "Other" row's own `RadioGroupItem`, guaranteed not to
 * collide with any of THIS question's real option labels (gate round 2, code review/architect
 * Low: an agent-authored option literally labelled `__other__` would otherwise be
 * indistinguishable from the Other row itself). Recomputed per render; cheap, deterministic. */
function otherSentinelFor(options: { label: string }[]): string {
  let candidate = '__other__'
  while (options.some((option) => option.label === candidate)) candidate = `_${candidate}`
  return candidate
}

/** Gate round 2 (code review N3/architect Low): the renderer's own `maxLength` keeps the Rust
 * side's `MAX_ASK_CUSTOM_INPUT_LEN` (`requests.rs`) effectively unreachable through normal typing
 * or paste, but a mismatch (future change on either side) must never surface raw field names and
 * ids to the user (FR-055) -- this is the one place that error text is ever shown. */
const ASK_CUSTOM_INPUT_MAX_LENGTH = 4096
function friendlyAskError(message: string): string {
  if (/customInput exceeds \d+ characters/.test(message)) return 'Your answer is too long. Shorten it and try again.'
  return message
}

export function AskCard({ sessionId, request }: AskCardProps) {
  const [busyAction, setBusyAction] = React.useState<'submit' | 'cancel' | null>(null)
  const busy = busyAction !== null
  const [error, setError] = React.useState<string | null>(null)
  const [incompleteNoteId, setIncompleteNoteId] = React.useState<string | null>(null)
  // Gate round 2 (architect M-d): re-keys `TabsList` whenever Next/the incomplete-note jump moves
  // the active question, so Radix's own roving-tabindex bookkeeping (which tab was last focused)
  // starts fresh at the NEW active tab instead of keeping the OLD one as the Tab stop -- without
  // this, Shift+Tab back into the tab list from the new question lands on the wrong tab, and its
  // automatic activation switches the question out from under the user.
  const [tabEpoch, setTabEpoch] = React.useState(0)

  const draft = useAskPicksStore((state) => state.bySession[sessionId]?.[request.requestId])
  const setActiveQuestion = useAskPicksStore((state) => state.setActiveQuestion)
  const selectSingleOption = useAskPicksStore((state) => state.selectSingleOption)
  const selectOther = useAskPicksStore((state) => state.selectOther)
  const toggleMultiOption = useAskPicksStore((state) => state.toggleMultiOption)
  const setCustomInput = useAskPicksStore((state) => state.setCustomInput)
  const toggleOtherTicked = useAskPicksStore((state) => state.toggleOtherTicked)

  const questions = request.questions
  const byQuestionId = draft?.byQuestionId ?? {}
  // Rust's `classify_dialog` rejects a malformed `ask` frame (no questions) before a
  // `PendingRequest::Ask` is ever created, so `questions` is never actually empty here; the
  // fallback keeps the hooks above unconditional (gate-fix, code review Medium: an early return
  // before any hooks made the guard's safety depend on a runtime value no type ever proved).
  const firstQuestion = questions[0] as AskQuestion | undefined
  const activeId = draft?.activeQuestionId ?? firstQuestion?.id ?? ''
  const activeQuestion = questions.find((question) => question.id === activeId) ?? firstQuestion

  const cardRootRef = React.useRef<HTMLDivElement>(null)
  const questionBodyRef = React.useRef<HTMLDivElement>(null)
  const focusTargetOnActiveChangeRef = React.useRef(false)

  // First render of a given question: mark it active (and, for a multi-select question, viewed)
  // so a single-question call is complete-by-default without the user ever opening a tab row
  // that does not exist for it (D6: no tab row below 2 questions).
  React.useEffect(() => {
    if (!draft?.activeQuestionId && activeQuestion) setActiveQuestion(sessionId, request.requestId, activeQuestion.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D13/D23: only the Next/jump-to-incomplete move focus to the new question's first or checked
  // option -- a plain tab click never does (the flag is set only in `handlePrimary` below).
  React.useEffect(() => {
    if (focusTargetOnActiveChangeRef.current) {
      focusTargetOnActiveChangeRef.current = false
      focusFirstOrCheckedOption(questionBodyRef.current)
    }
  }, [activeId])

  // D17 (gate round 2 rewrite): the ONLY focus-after-resolution mechanism -- the previous pair of
  // effects (a local `resolved` render branch's own effect, and a passive-`useEffect` unmount
  // rescue) never actually ran: `Transcript.tsx` swaps this whole subtree for
  // `ResolvedRequestSummary`/`AskQuestionRow` the moment the pending request resolves, a
  // PARENT-level re-render driven by a store update, not this component's own unmount -- so by
  // the time either of those old effects could fire, the node they targeted was already gone (or
  // never existed in the resolved branch's own case). A `useLayoutEffect` cleanup, not `useEffect`:
  // React detaches a deleted subtree's own host refs and moves `document.activeElement` to
  // `<body>` during the commit's mutation phase, BEFORE passive-effect cleanups run (verified
  // against React 19.3's own commit source, independently, by code review N1, a11y H3, and the
  // UI architect's H-a) -- a layout effect's cleanup is the last point that still sees focus
  // genuinely inside the about-to-be-removed card, for EVERY resolution path alike (Submit,
  // Cancel, an OMP `cancel`, a timeout): the button that was clicked keeps focus through the
  // `aria-disabled` busy state (never literally `disabled`), so it is still focused right up to
  // whichever commit finally unmounts this instance, regardless of which path triggered it.
  // Gate round 3 (unanimous): the intent is keyed by `${sessionId}:${request.requestId}`, not the
  // bare request id, so a stale intent can never be claimed by the wrong Session's own row.
  const intentKey = `${sessionId}:${request.requestId}`

  React.useLayoutEffect(() => {
    return () => {
      if (!cardRootRef.current?.contains(document.activeElement)) return
      // `markAskFocusPendingWithFallback` (shared with `ResolvedRequestSummary`'s own bridge
      // re-arm, `RequestCard.tsx`) arms the intent, gives the row that actually replaces this
      // card one frame to claim it and focus itself, and otherwise rescues focus into the
      // Session's own chat pane -- never stealing it from somewhere it is still validly resting.
      markAskFocusPendingWithFallback(intentKey, sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentKey, sessionId])

  async function submit() {
    setBusyAction('submit')
    setError(null)
    const answer: ChatAnswer = { answers: buildAnswers(questions, byQuestionId) }
    const result = await window.refract.chat.answer(sessionId, request.requestId, answer)
    setBusyAction(null)
    if (!result.ok) {
      setError(friendlyAskError(result.error.message))
      return
    }
  }

  async function cancel() {
    setBusyAction('cancel')
    setError(null)
    const result = await window.refract.chat.answer(sessionId, request.requestId, { cancelled: true })
    setBusyAction(null)
    if (!result.ok) {
      setError(friendlyAskError(result.error.message))
      return
    }
  }

  if (!activeQuestion) return null

  const allComplete = questions.every((question) => isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT))
  const activeIncomplete = !isQuestionComplete(activeQuestion, byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT)

  // D13: pressing the primary button on an incomplete batch moves to the NEXT incomplete
  // question after the active one, wrapping around; the inline note shows only when the active
  // question is the ONLY one still incomplete (searching wraps all the way back to it).
  function handlePrimary() {
    if (allComplete) {
      void submit()
      return
    }
    const incomplete = (question: AskQuestion) => !isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT)
    const activeIndex = questions.findIndex((question) => question.id === activeId)
    const rotated = [...questions.slice(activeIndex + 1), ...questions.slice(0, activeIndex + 1)]
    const next = rotated.find(incomplete)
    if (!next || next.id === activeId) {
      setIncompleteNoteId(activeId)
      return
    }
    setIncompleteNoteId(null)
    focusTargetOnActiveChangeRef.current = true
    setTabEpoch((epoch) => epoch + 1)
    setActiveQuestion(sessionId, request.requestId, next.id)
  }

  function handleTabChange(questionId: string) {
    setIncompleteNoteId(null)
    setActiveQuestion(sessionId, request.requestId, questionId)
  }

  const groupAriaId = `${request.requestId.replace(/[^a-zA-Z0-9_-]/g, '-')}-ask`
  const activeDraft = byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT

  const questionBody = (
    <AskQuestionBody
      key={activeQuestion.id}
      ref={questionBodyRef}
      question={activeQuestion}
      draft={activeDraft}
      busy={busy}
      // The note only ever applies to the active question (the only one `handlePrimary` can show
      // it on), and clears itself the instant that question becomes complete -- no separate
      // "clear" call needed (gate-fix, round 1, Medium: it used to stick around after the fix).
      showIncompleteNote={incompleteNoteId === activeQuestion.id && activeIncomplete}
      groupIdPrefix={groupAriaId}
      onSelectSingle={(label) => selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)}
      onSelectOther={() => selectOther(sessionId, request.requestId, activeQuestion.id)}
      onToggleMulti={(label) => toggleMultiOption(sessionId, request.requestId, activeQuestion.id, label)}
      onCustomInput={(text) => setCustomInput(sessionId, request.requestId, activeQuestion.id, text, activeQuestion.multi)}
      onToggleOtherTicked={() => toggleOtherTicked(sessionId, request.requestId, activeQuestion.id)}
      onEnterInOther={handlePrimary}
    />
  )

  return (
    <div ref={cardRootRef}>
      <Card size="sm">
        {questions.length > 1 ? (
          <Tabs value={activeId} onValueChange={handleTabChange} activationMode="automatic">
            <CardHeader>
              <TabsList key={tabEpoch} aria-label="Questions" className="h-auto w-full flex-wrap justify-start bg-transparent p-0">
                {questions.map((question, index) => {
                  const answered = isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT)
                  const label = question.header ?? `Question ${index + 1}`
                  return (
                    <Tooltip key={question.id}>
                      <TooltipTrigger asChild>
                        <TabsTrigger
                          value={question.id}
                          aria-describedby={undefined}
                          // Gate-fix (round 1, live-check regression): `TooltipTrigger asChild`
                          // and `TabsTrigger` both set their own `data-state` on the same DOM
                          // node, and Tooltip's own ("closed"/"open") wins the merge, clobbering
                          // Tabs' own ("active"/"inactive") -- styling and tests both key off
                          // `aria-selected` instead, which Radix Tabs sets independently and
                          // Tooltip never touches (same variant `PanelTabBar.tsx` already uses).
                          className="relative max-w-40 flex-none gap-1 rounded-none border-b-2 border-transparent shadow-none aria-selected:bg-muted aria-selected:shadow-none aria-selected:after:opacity-100 forced-colors:aria-selected:border-[Highlight] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0"
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          {answered && (
                            <>
                              <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                              <span className="sr-only">, answered</span>
                            </>
                          )}
                        </TabsTrigger>
                      </TooltipTrigger>
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </TabsList>
            </CardHeader>
            {/* Gate round 2 (architect/a11y M-c): Radix always gives `TabsContent` its own
             * `tabIndex=0`, an invisible Tab stop with no `focus-visible` style of its own right
             * before the question's own focusable region below -- this panel always contains
             * focusable controls, so `-1` removes the redundant, unstyled stop (Radix's own APG
             * pattern permits this) rather than giving it a visible ring for nothing to land on. */}
            <TabsContent value={activeId} tabIndex={-1}>
              {questionBody}
            </TabsContent>
          </Tabs>
        ) : (
          questionBody
        )}
        {error && (
          <CardContent>
            <Alert variant="destructive" box="inline">
              <OctagonXIcon aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        {request.deadlineAt !== undefined && (
          <CardContent className="text-sm text-muted-foreground">{formatDeadlineText(request.deadlineAt, questions)}</CardContent>
        )}
        <CardFooter className="justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-disabled={busy}
            aria-busy={busyAction === 'cancel'}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => !busy && void cancel()}
          >
            {busyAction === 'cancel' && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            {busyAction === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </Button>
          <Button
            size="sm"
            aria-disabled={busy}
            aria-busy={busyAction === 'submit'}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => !busy && handlePrimary()}
          >
            {busyAction === 'submit' && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            {busyAction === 'submit' ? 'Submitting…' : allComplete ? 'Submit' : 'Next'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

interface AskQuestionBodyProps {
  question: AskQuestion
  draft: AskDraftQuestion
  busy: boolean
  showIncompleteNote: boolean
  groupIdPrefix: string
  onSelectSingle: (label: string) => void
  onSelectOther: () => void
  onToggleMulti: (label: string) => void
  onCustomInput: (text: string) => void
  onToggleOtherTicked: () => void
  onEnterInOther: () => void
}

const AskQuestionBody = React.forwardRef<HTMLDivElement, AskQuestionBodyProps>(function AskQuestionBody(
  { question, draft, busy, showIncompleteNote, groupIdPrefix, onSelectSingle, onSelectOther, onToggleMulti, onCustomInput, onToggleOtherTicked, onEnterInOther },
  ref
) {
  const { heading, body } = splitQuestionHeading(question.question)
  const safeId = `${groupIdPrefix}-${question.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const headingId = `${safeId}-heading`
  const noteId = `${safeId}-incomplete-note`
  const hintId = `${safeId}-hint`
  const describedBy = showIncompleteNote ? noteId : undefined
  // Gate round 3 (a11y L-b): the multi-choice group's own hint paragraph was never actually
  // linked to the group -- wired in now, alongside the incomplete note when that is also showing.
  const multiDescribedBy = showIncompleteNote ? `${hintId} ${noteId}` : hintId
  const otherValue = otherSentinelFor(question.options)

  /** Gate round 2 (architect M-e, merging the earlier M3 IME gap); gate round 3 (architect L-a):
   * Enter must never resubmit while a send is already in flight (the input stays focusable,
   * `readOnly` not `disabled`, through the busy state -- round 1's fix for keeping focus through
   * an error), must never fire mid-IME-composition (a composing Enter commits the candidate, it
   * does not submit), and must never retry in a loop from a held-down key (`event.repeat`) after
   * a send error leaves the card focused and usable again. */
  function handleOtherKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.repeat && !busy) onEnterInOther()
  }

  return (
    // `key` on the caller's element (not here) forces a fresh instance per question (gate-fix,
    // round 1, High): without it, one `RadioGroup`/its Other state was reused across single-
    // choice tabs, so a pick on one question visually leaked onto another with no answer at all.
    <div ref={ref} className="flex flex-col gap-(--card-spacing)">
      {heading && (
        <CardHeader>
          <CardTitle id={headingId}>
            <Markdown id={`${safeId}-heading-md`} text={heading} className="font-medium" />
          </CardTitle>
        </CardHeader>
      )}
      {/* #491's scroll-region treatment, restored (decision D8: unchanged from #491): keyboard-
       * reachable and named on its own, since nothing else is otherwise focusable when the
       * question overflows its max height. */}
      {body && (
        <CardContent
          tabIndex={0}
          role="region"
          aria-label="Question"
          className="max-h-56 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Markdown id={`${safeId}-body-md`} text={body} className="[&_p]:whitespace-pre-line" />
        </CardContent>
      )}
      <CardContent className="space-y-2">
        {question.multi ? (
          <div role="group" aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : question.question} aria-describedby={multiDescribedBy} className="flex flex-col gap-2">
            {question.options.map((option, index) => {
              const checked = draft.selectedOptions.includes(option.label)
              const labelId = `${safeId}-opt-${index}-label`
              const descId = `${safeId}-opt-${index}-desc`
              return (
                <CheckboxItem
                  key={option.label}
                  checked={checked}
                  disabled={busy}
                  onCheckedChange={() => onToggleMulti(option.label)}
                  aria-labelledby={labelId}
                  aria-describedby={option.description ? descId : undefined}
                  className={ASK_ROW_CLASS}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-muted-foreground group-data-[state=checked]/checkbox-item:border-primary">
                      <CheckboxIndicator />
                    </span>
                    <span id={labelId} className="min-w-0 flex-1 break-words font-medium">
                      {option.label}
                      {hasRecommended(question) && question.recommended === index && <span className="font-normal text-muted-foreground">, Recommended</span>}
                    </span>
                  </span>
                  {option.description && (
                    <span id={descId} className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </CheckboxItem>
              )
            })}
            <CheckboxItem
              checked={draft.otherTicked}
              disabled={busy}
              onCheckedChange={onToggleOtherTicked}
              aria-label="Other"
              className={ASK_ROW_CLASS}
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-muted-foreground group-data-[state=checked]/checkbox-item:border-primary">
                  <CheckboxIndicator />
                </span>
                <span className="min-w-0 flex-1 break-words font-medium">Other</span>
              </span>
            </CheckboxItem>
            <Input
              value={draft.customInput}
              readOnly={busy}
              aria-disabled={busy}
              maxLength={ASK_CUSTOM_INPUT_MAX_LENGTH}
              placeholder="Type your own answer"
              className="ml-6 w-[calc(100%-1.5rem)]"
              aria-label="Other answer"
              onChange={(event) => onCustomInput(event.target.value)}
              onKeyDown={handleOtherKeyDown}
            />
            <p id={hintId} className="text-sm text-muted-foreground">
              Tick any that apply, or none.
            </p>
          </div>
        ) : (
          <>
            <RadioGroup
              aria-labelledby={heading ? headingId : undefined}
              aria-label={heading ? undefined : question.question}
              aria-describedby={describedBy}
              className="gap-2"
              value={draft.otherSelected ? otherValue : (draft.selectedOptions[0] ?? '')}
              onValueChange={(value) => (value === otherValue ? onSelectOther() : onSelectSingle(value))}
            >
              {question.options.map((option, index) => {
                const labelId = `${safeId}-opt-${index}-label`
                const descId = `${safeId}-opt-${index}-desc`
                return (
                  <RadioGroupItem
                    key={option.label}
                    value={option.label}
                    disabled={busy}
                    aria-labelledby={labelId}
                    aria-describedby={option.description ? descId : undefined}
                    className={ASK_ROW_CLASS}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground group-data-[state=checked]/radio-item:border-primary">
                        <RadioGroupIndicator />
                      </span>
                      <span id={labelId} className="min-w-0 flex-1 break-words font-medium">
                        {option.label}
                        {hasRecommended(question) && question.recommended === index && <span className="font-normal text-muted-foreground">, Recommended</span>}
                      </span>
                    </span>
                    {option.description && (
                      <span id={descId} className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </RadioGroupItem>
                )
              })}
              <RadioGroupItem value={otherValue} disabled={busy} aria-label="Other" className={ASK_ROW_CLASS}>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground group-data-[state=checked]/radio-item:border-primary">
                    <RadioGroupIndicator />
                  </span>
                  <span className="min-w-0 flex-1 break-words font-medium">Other</span>
                </span>
              </RadioGroupItem>
            </RadioGroup>
            <Input
              value={draft.customInput}
              readOnly={busy}
              aria-disabled={busy}
              maxLength={ASK_CUSTOM_INPUT_MAX_LENGTH}
              placeholder="Type your own answer"
              className="ml-6 w-[calc(100%-1.5rem)]"
              aria-label="Other answer"
              onChange={(event) => onCustomInput(event.target.value)}
              onKeyDown={handleOtherKeyDown}
            />
          </>
        )}
        {showIncompleteNote && (
          <p id={noteId} role="alert" className="text-sm text-destructive">
            Choose an option or type your own.
          </p>
        )}
      </CardContent>
    </div>
  )
})
