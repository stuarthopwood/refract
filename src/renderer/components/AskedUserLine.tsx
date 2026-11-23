import * as React from 'react'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { INSET_FOCUS_OUTLINE_CLASS, RESTING_FOCUS_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'
import {
  askedUserDigestAnswer,
  askedUserDigestPrompt,
  askedUserHasRecommended,
  askedUserHeader,
  askedUserLabel,
  askedUserNotes,
  NO_ANSWER,
  type AskedUserAnswer,
  type AskedUserLineModel,
  type AskedUserQuestion
} from '@/features/chat/askedUserLine'

/** The recommendation cue: a glyph FR-139 names, with the word beside it or, in the digest, for screen readers only. */
function RecommendedMark({ visibleText }: { visibleText: boolean }) {
  return (
    <span data-recommended-mark className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-severity-success">
      <span aria-hidden>✦</span>
      <span className={visibleText ? undefined : 'sr-only'}>Recommended</span>
    </span>
  )
}

function DigestRow({ question }: { question: AskedUserQuestion }) {
  const answered = question.answers.length > 0
  const notes = askedUserNotes(question)
  return (
    <li data-asked-digest className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate">{askedUserDigestPrompt(question.prompt)}</span>
      <span className="flex max-w-[60%] shrink-0 items-baseline gap-2">
        <span className={cn('truncate', !answered && 'text-muted-foreground')}>→ {askedUserDigestAnswer(question)}</span>
        {askedUserHasRecommended(question) && <RecommendedMark visibleText={false} />}
        {notes.length > 0 && <span className="truncate text-xs text-severity-warning">{notes.join(' · ')}</span>}
      </span>
    </li>
  )
}

function FullAnswer({ answer, multi }: { answer: AskedUserAnswer; multi: boolean }) {
  return (
    <li data-asked-answer className="space-y-1">
      <p className="flex items-start gap-2 break-words">
        {multi && <CheckIcon aria-hidden className="size-4 shrink-0" />}
        <span className="min-w-0 whitespace-pre-line">{answer.label}</span>
        {answer.recommended && <RecommendedMark visibleText />}
      </p>
      {answer.note && (
        <p className={cn('break-words text-xs', multi && 'ml-6')}>
          <span className="font-medium text-severity-warning">Note:</span> {answer.note}
        </p>
      )}
    </li>
  )
}

function FullQuestion({ question }: { question: AskedUserQuestion }) {
  return (
    <div data-asked-question className="space-y-1">
      <p className="whitespace-pre-line text-sm font-medium">{question.prompt}</p>
      {question.answers.length > 0 ? (
        <ul className="space-y-1">
          {question.answers.map((answer, index) => (
            <FullAnswer key={`${answer.label}-${index}`} answer={answer} multi={question.multi} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">→ {NO_ANSWER}</p>
      )}
    </div>
  )
}

interface AskedUserLineProps {
  model: AskedUserLineModel
  /** Starts expanded; the card is collapsed by default. */
  defaultOpen?: boolean
  /** The card root, so a host can claim focus for it. */
  ref?: React.Ref<HTMLDivElement>
}

/** The read-only card for a finished ask (FR-139): a header toggle over one digest line per question, or each question in full. */
export function AskedUserLine({ model, defaultOpen = false, ref }: AskedUserLineProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  const bodyId = React.useId()
  const answered = model.status === 'answered' || model.status === 'answered-by-away'
  const Chevron = open ? ChevronUpIcon : ChevronDownIcon
  return (
    <Card ref={ref} size="sm" role="group" aria-label={askedUserLabel(model)} tabIndex={-1} className={cn('gap-0 py-0', RESTING_FOCUS_CLASS)}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
        className={cn('h-auto w-full justify-start gap-2 rounded-none px-(--card-spacing) py-2 text-left text-sm font-medium whitespace-normal focus-visible:ring-0', INSET_FOCUS_OUTLINE_CLASS)}
      >
        {answered && <CheckIcon aria-hidden className="size-4 shrink-0 text-severity-success" />}
        <span className="min-w-0 flex-1">{askedUserHeader(model)}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
          {open ? 'Collapse' : 'Expand'}
          <Chevron aria-hidden className="size-3.5" />
        </span>
      </Button>
      <div id={bodyId} className="px-(--card-spacing) pt-1 pb-(--card-spacing) text-sm">
        {open ? (
          <div className="space-y-4">
            {model.questions.map((question, index) => (
              <FullQuestion key={`${question.prompt}-${index}`} question={question} />
            ))}
          </div>
        ) : (
          <ul className="space-y-1">
            {model.questions.map((question, index) => (
              <DigestRow key={`${question.prompt}-${index}`} question={question} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
