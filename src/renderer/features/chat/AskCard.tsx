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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type AskDraftQuestion, EMPTY_ASK_QUESTION_DRAFT, useAskPicksStore } from '@/state/ask-picks-store'
import { Markdown } from './Markdown'
import { ResolvedRequestSummary, splitQuestionHeading } from './RequestCard'

// New for #572: the structured multi-question dialog path (`PendingRequest` kind `ask`), built
// only once `set_ask_dialog` is confirmed enabled for this OMP process (contracts/omp-usage.md
// "Start-up sequence"). The one-question-at-a-time `select`/`input`/`editor`/`confirm` fallback
// stays `RequestCard.tsx`'s own `kind: 'question'` branch, unchanged (decision D18-D20).

type AskRequest = Extract<PendingRequest, { kind: 'ask' }>

interface AskCardProps {
  sessionId: string
  request: AskRequest
}

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

/** D16: a static deadline line, never a ticking countdown -- OMP owns the timer. */
function formatDeadlineText(deadlineAt: number, questions: AskQuestion[]): string {
  const time = new Date(deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const everyQuestionHasRecommended = questions.every((question) => question.recommended !== undefined)
  const outcome = everyQuestionHasRecommended ? 'the recommended answers' : 'the recommended or first answer for each question'
  return `If there's no answer by ${time}, the agent uses ${outcome}.`
}

export function AskCard({ sessionId, request }: AskCardProps) {
  // Rust's `classify_dialog` rejects a malformed `ask` frame (no questions) before a
  // `PendingRequest::Ask` is ever created, so this is unreachable in practice; guarded before any
  // hooks (not after) so the component's hook order never depends on this runtime value.
  if (request.questions.length === 0) return null

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState<'answered' | 'cancelled' | null>(null)
  const [incompleteNoteId, setIncompleteNoteId] = React.useState<string | null>(null)

  const draft = useAskPicksStore((state) => state.bySession[sessionId]?.[request.requestId])
  const setActiveQuestion = useAskPicksStore((state) => state.setActiveQuestion)
  const selectSingleOption = useAskPicksStore((state) => state.selectSingleOption)
  const toggleMultiOption = useAskPicksStore((state) => state.toggleMultiOption)
  const setCustomInput = useAskPicksStore((state) => state.setCustomInput)
  const toggleOtherTicked = useAskPicksStore((state) => state.toggleOtherTicked)
  const clearDraft = useAskPicksStore((state) => state.clear)

  const questions = request.questions
  const byQuestionId = draft?.byQuestionId ?? {}
  // Non-null assertions below are safe only because of the length guard above (line 67), on
  // this exact `questions` value -- never on unvalidated external input.
  const activeId = draft?.activeQuestionId ?? questions[0]!.id
  const activeQuestion = questions.find((question) => question.id === activeId) ?? questions[0]!

  // First render of a given question: mark it active (and, for a multi-select question, viewed)
  // so a single-question call is complete-by-default without the user ever opening a tab row
  // that does not exist for it (D6: no tab row below 2 questions).
  React.useEffect(() => {
    if (!draft?.activeQuestionId && activeQuestion) setActiveQuestion(sessionId, request.requestId, activeQuestion.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit() {
    setBusy(true)
    setError(null)
    const answer: ChatAnswer = { answers: buildAnswers(questions, byQuestionId) }
    const result = await window.refract.chat.answer(sessionId, request.requestId, answer)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    clearDraft(sessionId, request.requestId)
    setResolved('answered')
  }

  async function cancel() {
    setBusy(true)
    setError(null)
    const result = await window.refract.chat.answer(sessionId, request.requestId, { cancelled: true })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    clearDraft(sessionId, request.requestId)
    setResolved('cancelled')
  }

  if (resolved) {
    return <ResolvedRequestSummary resolved={resolved} />
  }

  const allComplete = questions.every((question) => isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT))

  // D13: pressing the primary button on an incomplete batch jumps to the first incomplete
  // question (focusing its first/checked option is a follow-up refinement, not implemented this
  // pass -- the jump itself, and the inline note when already on that question, are).
  function handlePrimary() {
    if (allComplete) {
      void submit()
      return
    }
    const firstIncomplete = questions.find((question) => !isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT))
    if (!firstIncomplete) return
    if (firstIncomplete.id === activeId) {
      setIncompleteNoteId(firstIncomplete.id)
      return
    }
    setIncompleteNoteId(null)
    setActiveQuestion(sessionId, request.requestId, firstIncomplete.id)
  }

  const groupAriaId = `${request.requestId.replace(/[^a-zA-Z0-9_-]/g, '-')}-ask`

  return (
    <Card size="sm">
      {questions.length > 1 && (
        <CardHeader>
          <Tabs value={activeId} onValueChange={(value) => setActiveQuestion(sessionId, request.requestId, value)} activationMode="automatic">
            <TabsList className="h-auto w-full flex-wrap justify-start bg-transparent p-0">
              {questions.map((question, index) => {
                const answered = isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT)
                const label = question.header ?? `Question ${index + 1}`
                return (
                  <TabsTrigger
                    key={question.id}
                    value={question.id}
                    title={label}
                    className="relative max-w-40 shrink gap-1 overflow-hidden rounded-none border-0 shadow-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 data-[state=active]:bg-muted data-[state=active]:shadow-none data-[state=active]:after:opacity-100"
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    {answered && (
                      <>
                        <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                        <span className="sr-only">, answered</span>
                      </>
                    )}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        </CardHeader>
      )}
      <AskQuestionBody
        sessionId={sessionId}
        requestId={request.requestId}
        question={activeQuestion}
        draft={byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT}
        busy={busy}
        showIncompleteNote={incompleteNoteId === activeQuestion.id}
        groupIdPrefix={groupAriaId}
        onSelectSingle={(label) => selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)}
        onToggleMulti={(label) => toggleMultiOption(sessionId, request.requestId, activeQuestion.id, label)}
        onCustomInput={(text) => setCustomInput(sessionId, request.requestId, activeQuestion.id, text, activeQuestion.multi)}
        onToggleOtherTicked={() => toggleOtherTicked(sessionId, request.requestId, activeQuestion.id)}
        onEnterInOther={handlePrimary}
      />
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
  )
}

interface AskQuestionBodyProps {
  sessionId: string
  requestId: string
  question: AskQuestion
  draft: AskDraftQuestion
  busy: boolean
  showIncompleteNote: boolean
  groupIdPrefix: string
  onSelectSingle(label: string): void
  onToggleMulti(label: string): void
  onCustomInput(text: string): void
  onToggleOtherTicked(): void
  onEnterInOther(): void
}

const OTHER_ROW_CLASS = 'bg-transparent hover:bg-muted min-h-9 py-1.5'

function AskQuestionBody({
  question,
  draft,
  busy,
  showIncompleteNote,
  groupIdPrefix,
  onSelectSingle,
  onToggleMulti,
  onCustomInput,
  onToggleOtherTicked,
  onEnterInOther
}: AskQuestionBodyProps) {
  const { heading, body } = splitQuestionHeading(question.question)
  const safeId = `${groupIdPrefix}-${question.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const headingId = `${safeId}-heading`
  const noteId = `${safeId}-incomplete-note`
  const describedBy = showIncompleteNote ? noteId : undefined

  return (
    <>
      {heading && (
        <CardHeader>
          <CardTitle id={headingId}>
            <Markdown id={`${safeId}-heading-md`} text={heading} className="font-medium" />
          </CardTitle>
        </CardHeader>
      )}
      {body && (
        <CardContent className="max-h-56 overflow-y-auto">
          <Markdown id={`${safeId}-body-md`} text={body} className="[&_p]:whitespace-pre-line" />
        </CardContent>
      )}
      <CardContent className="space-y-2" aria-busy={busy}>
        {question.multi ? (
          <div role="group" aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : question.question} aria-describedby={describedBy} className="flex flex-col gap-2">
            {question.options.map((option) => {
              const checked = draft.selectedOptions.includes(option.label)
              return (
                <CheckboxItem
                  key={option.label}
                  checked={checked}
                  disabled={busy}
                  onCheckedChange={() => onToggleMulti(option.label)}
                  className={OTHER_ROW_CLASS}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-muted-foreground group-data-[state=checked]/checkbox-item:border-primary">
                      <CheckboxIndicator />
                    </span>
                    <span className="min-w-0 flex-1 break-words font-medium">
                      {option.label}
                      {question.recommended !== undefined && question.options[question.recommended]?.label === option.label && (
                        <span className="font-normal text-muted-foreground"> (Recommended)</span>
                      )}
                    </span>
                  </span>
                  {option.description && <span className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">{option.description}</span>}
                </CheckboxItem>
              )
            })}
            <CheckboxItem checked={draft.otherTicked} disabled={busy} onCheckedChange={onToggleOtherTicked} className={OTHER_ROW_CLASS}>
              <span className="flex w-full min-w-0 items-center gap-2">
                <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-muted-foreground group-data-[state=checked]/checkbox-item:border-primary">
                  <CheckboxIndicator />
                </span>
                <span className="min-w-0 flex-1 break-words font-medium">Other</span>
              </span>
            </CheckboxItem>
            <Input
              value={draft.customInput}
              disabled={busy}
              placeholder="Type your own answer"
              className="ml-6 w-[calc(100%-1.5rem)]"
              aria-label="Other answer"
              onChange={(event) => onCustomInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onEnterInOther()
              }}
            />
            <p className="text-sm text-muted-foreground">Tick any that apply, or none.</p>
          </div>
        ) : (
          <RadioGroup
            aria-labelledby={heading ? headingId : undefined}
            aria-label={heading ? undefined : question.question}
            aria-describedby={describedBy}
            value={draft.otherSelected ? undefined : (draft.selectedOptions[0] ?? undefined)}
            onValueChange={onSelectSingle}
          >
            {question.options.map((option, index) => (
              <RadioGroupItem key={option.label} value={option.label} disabled={busy} className={OTHER_ROW_CLASS}>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground group-data-[state=checked]/radio-item:border-primary">
                    <RadioGroupIndicator />
                  </span>
                  <span className="min-w-0 flex-1 break-words font-medium">
                    {option.label}
                    {question.recommended === index && <span className="font-normal text-muted-foreground"> (Recommended)</span>}
                  </span>
                </span>
                {option.description && <span className="w-full min-w-0 break-words pl-6 text-xs text-muted-foreground">{option.description}</span>}
              </RadioGroupItem>
            ))}
            <div className={`group/radio-item flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg px-3 py-1.5 text-left text-sm ${OTHER_ROW_CLASS}`}>
              <span className="font-medium">Other</span>
              <Input
                value={draft.customInput}
                disabled={busy}
                placeholder="Type your own answer"
                className="w-full"
                aria-label="Other answer"
                onChange={(event) => onCustomInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onEnterInOther()
                }}
              />
            </div>
          </RadioGroup>
        )}
        {showIncompleteNote && (
          <p id={noteId} role="alert" className="text-sm text-destructive">
            Choose an option or type your own answer.
          </p>
        )}
      </CardContent>
    </>
  )
}
