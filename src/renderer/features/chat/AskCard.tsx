import * as React from 'react'
import { CheckIcon } from 'lucide-react'
import type { ChatAnswer } from '../../../shared/ipc'
import type { AskQuestion, PendingRequest } from '../../../shared/model'
import { Button } from '@/components/ui/button'
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AskFormFooter } from '@/components/AskFormFooter'
import { AskFormShell } from '@/components/AskFormShell'
import { AskChoiceGroup } from '@/components/AskChoiceGroup'
import { choiceDigitIndex, focusChoiceRow, focusedOptionIndex, isNoteShortcut, isRowEnter, pickBeforeNote } from '@/components/askChoiceKeys'
import { type AskChoiceNotes, OptionNoteHint } from '@/components/OptionNote'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { type AskDraftQuestion, EMPTY_ASK_QUESTION_DRAFT, useAskPicksStore } from '@/state/ask-picks-store'
import { Markdown } from './Markdown'
import { splitQuestionHeading } from './RequestCard'
import { sendAnswer } from './askAnswerError'
import { pickedNotes } from './askNotes'
import { draftAfterUseRecommended, focusProbeOf, initialPickFor, opensOnRecommended, recommendedFlags, recommendedLabels, shouldTakeInitialFocus } from './askRecommended'

// New for #572: the structured multi-question dialog path (`PendingRequest` kind `ask`), built
// only once `set_ask_dialog` is confirmed enabled for this OMP process (contracts/omp-usage.md
// "Start-up sequence"). The one-question-at-a-time `select`/`input`/`editor`/`confirm` fallback
// stays `RequestCard.tsx`'s own `kind: 'question'` branch, restyled to match (decision D18/D19).

type AskRequest = Extract<PendingRequest, { kind: 'ask' }>

interface AskCardProps {
  sessionId: string
  request: AskRequest
}

function isQuestionComplete(question: AskQuestion, draft: AskDraftQuestion): boolean {
  if (question.multi) return draft.viewed
  return draft.selectedOptions.length > 0 || (draft.otherSelected && draft.customInput.trim().length > 0)
}

/** Runs `action` only while no send or cancel is in flight, so a second press cannot resend. */
export function runUnlessBusy(busy: boolean, action: () => void): void {
  if (!busy) action()
}

/** Notes ride only on a `refract_ask` card (`withNotes`); the native ask has nowhere to carry them. */
export function buildAnswers(questions: AskQuestion[], byQuestionId: Record<string, AskDraftQuestion>, withNotes: boolean) {
  return questions.map((question) => {
    const draft = byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT
    const trimmedInput = draft.customInput.trim()
    const notes = withNotes ? pickedNotes(draft.selectedOptions, draft.notes) : []
    const noteField = notes.length > 0 ? { notes } : {}
    if (question.multi) {
      const customInput = draft.otherTicked && trimmedInput ? trimmedInput : undefined
      return { id: question.id, selectedOptions: draft.selectedOptions, ...(customInput ? { customInput } : {}), ...noteField }
    }
    if (draft.otherSelected && trimmedInput) {
      return { id: question.id, selectedOptions: [], customInput: trimmedInput }
    }
    return { id: question.id, selectedOptions: draft.selectedOptions, ...noteField }
  })
}

/** D16: a static deadline line, never a ticking countdown -- OMP owns the timer. */
export function formatDeadlineText(deadlineAt: number, questions: AskQuestion[]): string {
  const time = new Date(deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const anyRecommended = questions.some((question) => recommendedLabels(question).length > 0)
  return anyRecommended
    ? `If there's no answer by ${time}, the agent uses the recommended answers.`
    : `If there's no answer by ${time}, the agent uses the first option for each question.`
}

/** The recommended row when there is one, so Enter confirms it; otherwise the pick, otherwise the first row. `preventScroll` for a card that opens on its own. */
function focusFirstOrCheckedOption(container: HTMLElement | null, preventScroll = false): void {
  if (!container) return
  const checked = container.querySelector<HTMLElement>('[role=radio][data-state=checked], [role=checkbox][data-state=checked]')
  const recommended = container.querySelector<HTMLElement>('[data-ask-recommended]')
  const first = container.querySelector<HTMLElement>('[role=radio], [role=checkbox]')
  ;(checked ?? recommended ?? first)?.focus({ preventScroll })
}

export function AskCard({ sessionId, request }: AskCardProps) {
  const [busyAction, setBusyAction] = React.useState<'submit' | 'cancel' | null>(null)
  const busy = busyAction !== null
  const [error, setError] = React.useState<string | null>(null)
  const [incompleteNoteId, setIncompleteNoteId] = React.useState<string | null>(null)
  const [tabEpoch, setTabEpoch] = React.useState(0)
  const [editingNote, setEditingNote] = React.useState<{ questionId: string; label: string } | null>(null)

  const draft = useAskPicksStore((state) => state.bySession[sessionId]?.[request.requestId])
  const setActiveQuestion = useAskPicksStore((state) => state.setActiveQuestion)
  const selectSingleOption = useAskPicksStore((state) => state.selectSingleOption)
  const selectOther = useAskPicksStore((state) => state.selectOther)
  const toggleMultiOption = useAskPicksStore((state) => state.toggleMultiOption)
  const setCustomInput = useAskPicksStore((state) => state.setCustomInput)
  const toggleOtherTicked = useAskPicksStore((state) => state.toggleOtherTicked)
  const replaceQuestionDraft = useAskPicksStore((state) => state.replaceQuestionDraft)
  const setOptionNote = useAskPicksStore((state) => state.setOptionNote)

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
  // that does not exist for it (D6: no tab row below 2 questions). #1985: a single-choice
  // recommendation is preselected here, and its row takes focus only from `body` or this Session's own pane (see `shouldTakeInitialFocus`).
  React.useEffect(() => {
    if (!draft?.activeQuestionId && activeQuestion) {
      openQuestion(activeQuestion)
      if (opensOnRecommended(activeQuestion) && shouldTakeInitialFocus(focusProbeOf(document.activeElement, sessionId))) {
        focusFirstOrCheckedOption(questionBodyRef.current, true)
      }
    }
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
    const answer: ChatAnswer = { answers: buildAnswers(questions, answersBy, request.hostCall === true) }
    const failure = await sendAnswer(sessionId, request.requestId, answer)
    setBusyAction(null)
    if (failure !== null) setError(failure)
  }

  async function cancel() {
    setBusyAction('cancel')
    setError(null)
    const failure = await sendAnswer(sessionId, request.requestId, { cancelled: true })
    setBusyAction(null)
    if (failure !== null) setError(failure)
  }

  if (!activeQuestion) return null
  const recommendedNames = recommendedLabels(activeQuestion)

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
    openQuestion(next)
  }

  // The footer calls this even when Submit is not submittable (form cards use that to flag the attempt), so a busy card must refuse here.
  function handlePrimary() {
    runUnlessBusy(busy, () => advance(byQuestionId))
  }

  // #1435: a pointer click or Space on a single-choice option commits it and moves on; arrow keys only move the pick.
  const handlePickSingle = (label: string) => {
    if (busy) return
    selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)
    advance({ ...byQuestionId, [activeQuestion.id]: { ...(byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT), selectedOptions: [label], otherSelected: false } }, false)
  }

  function openQuestion(question: AskQuestion) {
    setActiveQuestion(sessionId, request.requestId, question.id, initialPickFor(question))
  }

  // #1985: "Use Recommended" and Enter on the recommended row pick it, then act like the primary button.
  const acceptRecommended = () => {
    if (busy) return
    const current = byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT
    const next = draftAfterUseRecommended(activeQuestion, current)
    if (!next) return
    replaceQuestionDraft(sessionId, request.requestId, activeQuestion.id, next)
    advance({ ...byQuestionId, [activeQuestion.id]: next })
  }

  function handleTabChange(questionId: string) {
    setIncompleteNoteId(null)
    const target = questions.find((question) => question.id === questionId)
    if (target) openQuestion(target)
  }

  const groupAriaId = `${request.requestId.replace(/[^a-zA-Z0-9_-]/g, '-')}-ask`
  const activeDraft = byQuestionId[activeQuestion.id] ?? EMPTY_ASK_QUESTION_DRAFT
  const editingLabel = editingNote?.questionId === activeQuestion.id ? editingNote.label : null

  // A note belongs to a picked option, so unpicking the option being edited closes its editor (the text stays in the draft).
  React.useEffect(() => {
    if (editingLabel && !activeDraft.selectedOptions.includes(editingLabel)) setEditingNote(null)
  }, [editingLabel, activeDraft.selectedOptions])

  const closeNoteEditor = (label: string) => {
    setEditingNote(null)
    focusChoiceRow(questionBodyRef.current, activeQuestion.options.findIndex((option) => option.label === label))
  }

  // The N key and the Note button share this: pick the option first if needed, then open its editor.
  const openNote = (label: string) => {
    const pick = pickBeforeNote(activeQuestion.multi, activeDraft.selectedOptions.includes(label))
    if (pick === 'toggle') toggleMultiOption(sessionId, request.requestId, activeQuestion.id, label)
    else if (pick === 'select') selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)
    setEditingNote({ questionId: activeQuestion.id, label })
  }

  const notes: AskChoiceNotes | undefined = request.hostCall
    ? {
        texts: activeDraft.notes,
        editing: editingLabel,
        onEdit: openNote,
        onSave: (label, text) => {
          setOptionNote(sessionId, request.requestId, activeQuestion.id, label, text)
          closeNoteEditor(label)
        },
        onCancel: closeNoteEditor,
        onRemove: (label) => {
          setOptionNote(sessionId, request.requestId, activeQuestion.id, label, '')
          closeNoteEditor(label)
        }
      }
    : undefined

  // N acts on the focused option (openNote). Digits pick or tick by position and Enter on a row acts like the primary button, only while focus is inside this card and not in a text box.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy) return
    if (notes && isNoteShortcut(event)) {
      const noteIndex = focusedOptionIndex(questionBodyRef.current, event.target)
      const noteOption = noteIndex === null ? undefined : activeQuestion.options[noteIndex]
      if (!noteOption) return
      event.preventDefault()
      openNote(noteOption.label)
      return
    }
    const index = choiceDigitIndex(event, activeQuestion.options.length)
    const option = index === null ? undefined : activeQuestion.options[index]
    if (index !== null && option) {
      event.preventDefault()
      if (activeQuestion.multi) toggleMultiOption(sessionId, request.requestId, activeQuestion.id, option.label)
      else selectSingleOption(sessionId, request.requestId, activeQuestion.id, option.label)
      focusChoiceRow(questionBodyRef.current, index)
    } else if (isRowEnter(event)) {
      event.preventDefault()
      handlePrimary()
    }
  }

  const questionBody = (
    <AskQuestionBody
      key={activeQuestion.id}
      ref={questionBodyRef}
      question={activeQuestion}
      draft={activeDraft}
      busy={busy}
      showIncompleteNote={incompleteNoteId === activeQuestion.id && activeIncomplete}
      groupIdPrefix={groupAriaId}
      onSelectSingle={(label) => selectSingleOption(sessionId, request.requestId, activeQuestion.id, label)}
      onPickSingle={handlePickSingle}
      onSelectOther={() => selectOther(sessionId, request.requestId, activeQuestion.id)}
      onToggleMulti={(label) => toggleMultiOption(sessionId, request.requestId, activeQuestion.id, label)}
      onCustomInput={(text) => setCustomInput(sessionId, request.requestId, activeQuestion.id, text, activeQuestion.multi)}
      onToggleOtherTicked={() => toggleOtherTicked(sessionId, request.requestId, activeQuestion.id)}
      onEnterInOther={handlePrimary}
      onAcceptRecommended={acceptRecommended}
      notes={notes}
    />
  )

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={cardRootRef} onKeyDown={handleKeyDown}>
      <AskFormShell>
        {questions.length > 1 ? (
          <Tabs value={activeId} onValueChange={handleTabChange} activationMode="automatic">
            <CardHeader>
              <TabsList key={tabEpoch} aria-label="Questions" className="h-auto w-full flex-wrap">
                {questions.map((question, index) => {
                  const answered = isQuestionComplete(question, byQuestionId[question.id] ?? EMPTY_ASK_QUESTION_DRAFT)
                  const label = question.header ?? `Question ${index + 1}`
                  return (
                    <Tooltip key={question.id}>
                      <TooltipTrigger asChild>
                        <TabsTrigger
                          value={question.id}
                          aria-describedby={undefined}
                          className="max-w-40 gap-1"
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
        <AskFormFooter
          error={error}
          deadlineText={request.deadlineAt !== undefined ? formatDeadlineText(request.deadlineAt, questions) : undefined}
          cancellable={!busy}
          submittable={!busy}
          sending={busyAction === 'submit'}
          cancelling={busyAction === 'cancel'}
          submitLabel={allComplete ? 'Submit' : 'Next'}
          actions={
            recommendedNames.length > 0 && (
              <Button size="sm" variant="outline" aria-label={`Use recommended: ${recommendedNames.join('; ')}`} aria-disabled={busy} className="aria-disabled:opacity-50" onClick={acceptRecommended}>
                Use Recommended
                <span aria-hidden>↵</span>
              </Button>
            )
          }
          onCancel={() => void cancel()}
          onSubmit={handlePrimary}
        />
      </AskFormShell>
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
  onPickSingle: (label: string) => void
  onSelectOther: () => void
  onToggleMulti: (label: string) => void
  onCustomInput: (text: string) => void
  onToggleOtherTicked: () => void
  onAcceptRecommended: () => void
  onEnterInOther: () => void
  notes: AskChoiceNotes | undefined
}

const AskQuestionBody = React.forwardRef<HTMLDivElement, AskQuestionBodyProps>(function AskQuestionBody(
  { question, draft, busy, showIncompleteNote, groupIdPrefix, onSelectSingle, onPickSingle, onSelectOther, onToggleMulti, onCustomInput, onToggleOtherTicked, onEnterInOther, onAcceptRecommended, notes },
  ref
) {
  const { heading, body } = splitQuestionHeading(question.question)
  const safeId = `${groupIdPrefix}-${question.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const headingId = `${safeId}-heading`
  const noteId = `${safeId}-incomplete-note`
  const describedBy = showIncompleteNote ? noteId : undefined
  const recommended = recommendedFlags(question)
  const options = question.options.map((option, index) => ({
    value: option.label,
    label: option.label,
    description: option.description,
    recommended: recommended[index] === true,
    reason: option.reason
  }))

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
        <AskChoiceGroup
          multi={question.multi}
          options={options}
          selected={draft.selectedOptions}
          otherSelected={question.multi ? draft.otherTicked : draft.otherSelected}
          disabled={busy}
          idPrefix={safeId}
          groupLabelledBy={heading ? headingId : undefined}
          groupLabel={heading ? undefined : question.question}
          groupDescribedBy={describedBy}
          other={{ visible: true, text: draft.customInput, ariaLabel: 'Other answer', onTextChange: onCustomInput, onKeyDown: handleOtherKeyDown }}
          onSelect={onSelectSingle}
          onToggle={onToggleMulti}
          onSelectOther={onSelectOther}
          onToggleOther={onToggleOtherTicked}
          onPick={onPickSingle}
          onAcceptRecommended={opensOnRecommended(question) ? onAcceptRecommended : undefined}
          notes={notes}
        />
        {notes && <OptionNoteHint />}
        {showIncompleteNote && (
          <p id={noteId} role="alert" className="text-sm text-destructive">
            Choose an option or type your own.
          </p>
        )}
      </CardContent>
    </div>
  )
})
