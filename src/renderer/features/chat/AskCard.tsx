import * as React from 'react'
import { CheckIcon, Loader2Icon } from 'lucide-react'
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
import { focusPaneContent, isFocusStranded } from '@/lib/focus'
import { type AskDraftQuestion, EMPTY_ASK_QUESTION_DRAFT, useAskPicksStore } from '@/state/ask-picks-store'
import { Markdown } from './Markdown'
import { ResolvedRequestSummary, splitQuestionHeading } from './RequestCard'

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
    if (question.multi) {
      const customInput = draft.otherTicked ? draft.customInput.trim() : ''
      return customInput
        ? { id: question.id, selectedOptions: draft.selectedOptions, customInput }
        : { id: question.id, selectedOptions: draft.selectedOptions }
    }
    if (draft.otherSelected && draft.customInput.trim()) {
      return { id: question.id, selectedOptions: [], customInput: draft.customInput.trim() }
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
  const everyQuestionHasRecommended = questions.every(hasRecommended)
  const outcome = everyQuestionHasRecommended ? 'the recommended answers' : 'the recommended or first answer for each question'
  return `If there's no answer by ${time}, the agent uses ${outcome}.`
}

/** Focuses the checked option in `container` if one exists, else the first option -- used after
 * Next and the incomplete-question jump move the active tab (decision D13/D23). Never called on
 * tab-click or arrival (D25). */
function focusFirstOrCheckedOption(container: HTMLElement | null): void {
  if (!container) return
  const checked = container.querySelector<HTMLElement>('[role="radio"][data-state="checked"], [role="checkbox"][data-state="checked"]')
  const first = container.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]')
  ;(checked ?? first)?.focus()
}

export function AskCard({ sessionId, request }: AskCardProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState<'answered' | 'cancelled' | null>(null)
  const [incompleteNoteId, setIncompleteNoteId] = React.useState<string | null>(null)

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
  const resolvedRef = React.useRef<HTMLDivElement>(null)
  const questionBodyRef = React.useRef<HTMLDivElement>(null)
  const focusTargetOnActiveChangeRef = React.useRef(false)
  const focusWasInsideRef = React.useRef(false)

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

  // D17: after Submit or Cancel resolves this card in place (no unmount -- `resolved` just
  // changes this same instance's own render branch below), move focus to the resolved summary
  // row when focus was inside the card at the moment Submit/Cancel was pressed.
  React.useEffect(() => {
    if (resolved && focusWasInsideRef.current) {
      focusWasInsideRef.current = false
      resolvedRef.current?.focus()
    }
  }, [resolved])

  // D17 (OMP `cancel`/timeout path): unlike Submit/Cancel above, an OMP-driven resolution removes
  // this request from the pending list entirely, so `Transcript.tsx` stops rendering this
  // component -- a real unmount, not a re-render. Rescue focus into the Session's own chat pane
  // (the established `isFocusStranded`/`focusPaneContent` pattern `ChatPane.tsx` already uses
  // everywhere else) rather than leaving it on `<body>`; there is no specific "expand button" to
  // target here since the eventual `AskQuestionRow` is a different component this one cannot see.
  React.useEffect(() => {
    return () => {
      if (!cardRootRef.current?.contains(document.activeElement)) return
      const sessionPane = document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`)
      requestAnimationFrame(() => {
        if (isFocusStranded(document.activeElement, sessionPane)) focusPaneContent(sessionPane)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit() {
    focusWasInsideRef.current = !!cardRootRef.current?.contains(document.activeElement)
    setBusy(true)
    setError(null)
    const answer: ChatAnswer = { answers: buildAnswers(questions, byQuestionId) }
    const result = await window.refract.chat.answer(sessionId, request.requestId, answer)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setResolved('answered')
  }

  async function cancel() {
    focusWasInsideRef.current = !!cardRootRef.current?.contains(document.activeElement)
    setBusy(true)
    setError(null)
    const result = await window.refract.chat.answer(sessionId, request.requestId, { cancelled: true })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setResolved('cancelled')
  }

  if (resolved) {
    return (
      <div ref={resolvedRef} tabIndex={-1} className="outline-none">
        <ResolvedRequestSummary resolved={resolved} />
      </div>
    )
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
              <TabsList aria-label="Questions" className="h-auto w-full flex-wrap justify-start bg-transparent p-0">
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
            <TabsContent value={activeId}>{questionBody}</TabsContent>
          </Tabs>
        ) : (
          questionBody
        )}
        {error && (
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        {request.deadlineAt !== undefined && (
          <CardContent className="text-sm text-muted-foreground">{formatDeadlineText(request.deadlineAt, questions)}</CardContent>
        )}
        <CardFooter className="justify-between gap-2">
          <Button size="sm" variant="outline" aria-disabled={busy} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !busy && void cancel()}>
            Cancel
          </Button>
          <Button size="sm" aria-disabled={busy} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-busy={busy} onClick={() => !busy && handlePrimary()}>
            {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            {busy ? 'Submitting…' : allComplete ? 'Submit' : 'Next'}
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
  onSelectSingle(label: string): void
  onSelectOther(): void
  onToggleMulti(label: string): void
  onCustomInput(text: string): void
  onToggleOtherTicked(): void
  onEnterInOther(): void
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

  return (
    // `key` on the caller's element (not here) forces a fresh instance per question (gate-fix,
    // round 1, High): without it, one `RadioGroup`/its Other state was reused across single-
    // choice tabs, so a pick on one question visually leaked onto another with no answer at all.
    <div ref={ref}>
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
          <div role="group" aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : question.question} aria-describedby={describedBy} className="flex flex-col gap-2">
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
              placeholder="Type your own answer"
              className="ml-6 w-[calc(100%-1.5rem)]"
              aria-label="Other answer"
              onChange={(event) => onCustomInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onEnterInOther()
              }}
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
              value={draft.otherSelected ? '__other__' : (draft.selectedOptions[0] ?? '')}
              onValueChange={(value) => (value === '__other__' ? onSelectOther() : onSelectSingle(value))}
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
              <RadioGroupItem value="__other__" disabled={busy} aria-label="Other" className={ASK_ROW_CLASS}>
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
              placeholder="Type your own answer"
              className="ml-6 w-[calc(100%-1.5rem)]"
              aria-label="Other answer"
              onChange={(event) => onCustomInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onEnterInOther()
              }}
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
