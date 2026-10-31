import * as React from 'react'
import { CheckIcon, Loader2Icon, OctagonXIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { AskQuestion, PendingRequest } from '../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { CHECKBOX_BOX_CLASS, CheckboxIndicator, CheckboxItem, OPTION_MARK_CLASS, OPTION_ROW_CLASS } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TAB_ACTIVE_UNDERLINE_CLASS } from '@/components/ui/tab-classes'
import { cn } from '@/lib/utils'
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

const ASK_CHECKED_MARK_CLASS = 'group-data-[state=checked]/checkbox-item:border-foreground forced-colors:group-data-[state=checked]/checkbox-item:border-[Highlight]'

function isQuestionComplete(question: AskQuestion, draft: AskDraftQuestion): boolean {
  if (question.multi) return draft.viewed
  return draft.selectedOptions.length > 0 || (draft.otherSelected && draft.customInput.trim().length > 0)
}

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

function focusFirstOrCheckedOption(container: HTMLElement | null): void {
  if (!container) return
  const checked = container.querySelector<HTMLElement>('[role=radio][data-state=checked], [role=checkbox][data-state=checked]')
  const first = container.querySelector<HTMLElement>('[role=radio], [role=checkbox]')
  ;(checked ?? first)?.focus()
}

function otherSentinelFor(options: { label: string }[]): string {
  let candidate = '__other__'
  while (options.some((option) => option.label === candidate)) candidate = `_${candidate}`
  return candidate
}

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

  async function submit(answersBy: Record<string, AskDraftQuestion> = byQuestionId) {
    setBusyAction('submit')
    setError(null)
    const answer: ChatAnswer = { answers: buildAnswers(questions, answersBy) }
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

  // D13: pressing the primary button, or picking a single-choice option, on an incomplete batch
  // moves to the NEXT incomplete question after the active one, wrapping around; the inline note
  // shows only when the active question is the ONLY one still incomplete. A pick never submits (#1448).
  function advance(answersBy: Record<string, AskDraftQuestion>, submitWhenComplete = true) {
    const incomplete = (question: AskQuestion) => !isQuestionComplete(question, answersBy[question.id] ?? EMPTY_ASK_QUESTION_DRAFT)
    if (!questions.some(incomplete)) {
      if (submitWhenComplete) void submit(answersBy)
      return
    }
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

  function handlePrimary() {
    advance(byQuestionId)
  }

  // #1435: a pointer click or Space on a single-choice option commits it and moves on; arrow keys only move the pick.
  const handlePickSingle = (label: string) => {
    if (busy) return
    selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)
    advance({ ...byQuestionId, [activeQuestion.id]: { ...(byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT), selectedOptions: [label], otherSelected: false } }, false)
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
      showIncompleteNote={incompleteNoteId === activeQuestion.id && activeIncomplete}
      groupIdPrefix={groupAriaId}
      advancesOnPick={questions.length > 1 && questions.some((question) => question.id !== activeQuestion.id && !isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT))}
      onSelectSingle={(label) => selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)}
      onPickSingle={handlePickSingle}
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
                          className={cn(
                            'max-w-40 flex-none gap-1 rounded-none text-muted-foreground shadow-none',
                            TAB_ACTIVE_UNDERLINE_CLASS
                          )}
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          {answered && (
                            <>
                              <CheckIcon aria-hidden className="size-4 shrink-0" />
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
        <CardFooter>
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={busy}
            aria-busy={busyAction === 'cancel'}
            className="dark:hover:bg-muted aria-disabled:opacity-50"
            onClick={() => !busy && void cancel()}
          >
            {busyAction === 'cancel' && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            {busyAction === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </Button>
          <Button
            size="sm"
            aria-disabled={busy}
            aria-busy={busyAction === 'submit'}
            className="aria-disabled:opacity-50"
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
  advancesOnPick: boolean
  onSelectSingle: (label: string) => void
  onPickSingle: (label: string) => void
  onSelectOther: () => void
  onToggleMulti: (label: string) => void
  onCustomInput: (text: string) => void
  onToggleOtherTicked: () => void
  onEnterInOther: () => void
}

const AskQuestionBody = React.forwardRef<HTMLDivElement, AskQuestionBodyProps>(function AskQuestionBody(
  { question, draft, busy, showIncompleteNote, groupIdPrefix, advancesOnPick, onSelectSingle, onPickSingle, onSelectOther, onToggleMulti, onCustomInput, onToggleOtherTicked, onEnterInOther },
  ref
) {
  const arrowKeyRef = React.useRef(false)
  const { heading, body } = splitQuestionHeading(question.question)
  const safeId = `${groupIdPrefix}-${question.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const headingId = `${safeId}-heading`
  const noteId = `${safeId}-incomplete-note`
  const hintId = `${safeId}-hint`
  const describedBy = [advancesOnPick ? hintId : null, showIncompleteNote ? noteId : null].filter(Boolean).join(' ') || undefined
  const multiDescribedBy = showIncompleteNote ? `${hintId} ${noteId}` : hintId
  const otherValue = otherSentinelFor(question.options)

  function handleOtherKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.repeat && !busy) onEnterInOther()
  }

  return (
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
                  aria-disabled={busy}
                  onCheckedChange={() => !busy && onToggleMulti(option.label)}
                  aria-labelledby={labelId}
                  aria-describedby={option.description ? descId : undefined}
                  className={OPTION_ROW_CLASS}
                >
                  <span aria-hidden className={cn(OPTION_MARK_CLASS, CHECKBOX_BOX_CLASS, ASK_CHECKED_MARK_CLASS)}>
                    <CheckboxIndicator />
                  </span>
                  <span id={labelId} className="col-start-2 min-w-0 break-words">
                    {option.label}
                    {hasRecommended(question) && question.recommended === index && <span className="font-normal text-muted-foreground">, Recommended</span>}
                  </span>
                  {option.description && (
                    <span id={descId} className="col-start-2 w-full min-w-0 break-words text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </CheckboxItem>
              )
            })}
            <CheckboxItem
              checked={draft.otherTicked}
              aria-disabled={busy}
              onCheckedChange={() => !busy && onToggleOtherTicked()}
              aria-label="Other"
              className={OPTION_ROW_CLASS}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, CHECKBOX_BOX_CLASS, ASK_CHECKED_MARK_CLASS)}>
                <CheckboxIndicator />
              </span>
              <span className="col-start-2 min-w-0 break-words">Other</span>
            </CheckboxItem>
            <Input
              value={draft.customInput}
              readOnly={busy}
              aria-disabled={busy}
              maxLength={ASK_CUSTOM_INPUT_MAX_LENGTH}
              placeholder="Type your own answer"
              className="ml-10 w-[calc(100%-2.5rem)]"
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
              onKeyDownCapture={(event) => { arrowKeyRef.current = /^(Arrow|Home$|End$)/.test(event.key) }}
              onKeyUpCapture={() => { arrowKeyRef.current = false }}
              onBlurCapture={() => { arrowKeyRef.current = false }}
              onPointerDownCapture={() => { arrowKeyRef.current = false }}
              value={draft.otherSelected ? otherValue : (draft.selectedOptions[0] ?? '')}
              onValueChange={(value) => { if (busy) return; if (value === otherValue) onSelectOther(); else onSelectSingle(value) }}
            >
              {question.options.map((option, index) => {
                const labelId = `${safeId}-opt-${index}-label`
                const descId = `${safeId}-opt-${index}-desc`
                return (
                  <RadioGroupItem
                    key={option.label}
                    value={option.label}
                    aria-disabled={busy}
                    aria-labelledby={labelId}
                    aria-describedby={option.description ? descId : undefined}
                    onClick={() => !arrowKeyRef.current && onPickSingle(option.label)}
                    className={OPTION_ROW_CLASS}
                  >
                    <span aria-hidden className={cn(OPTION_MARK_CLASS, RADIO_RING_CLASS)}>
                      <RadioGroupIndicator />
                    </span>
                    <span id={labelId} className="col-start-2 min-w-0 break-words">
                      {option.label}
                      {hasRecommended(question) && question.recommended === index && <span className="font-normal text-muted-foreground">, Recommended</span>}
                    </span>
                    {option.description && (
                      <span id={descId} className="col-start-2 w-full min-w-0 break-words text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </RadioGroupItem>
                )
              })}
              <RadioGroupItem value={otherValue} aria-disabled={busy} aria-label="Other" className={OPTION_ROW_CLASS}>
                <span aria-hidden className={cn(OPTION_MARK_CLASS, RADIO_RING_CLASS)}>
                  <RadioGroupIndicator />
                </span>
                <span className="col-start-2 min-w-0 break-words">Other</span>
              </RadioGroupItem>
            </RadioGroup>
            {advancesOnPick && (
              <p id={hintId} className="text-sm text-muted-foreground">
                Choosing an option moves to the next question.
              </p>
            )}
            <Input
              value={draft.customInput}
              readOnly={busy}
              aria-disabled={busy}
              maxLength={ASK_CUSTOM_INPUT_MAX_LENGTH}
              placeholder="Type your own answer"
              className="ml-10 w-[calc(100%-2.5rem)]"
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
