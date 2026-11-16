import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AskChoiceGroup } from '@/components/AskChoiceGroup'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { firstMissingField, missingFieldMessage, type AskFieldValue } from './answerPlan'
import { canCancel, type AskFormPhase } from './askFormSession'
import { escapeCancelsForm } from './askFormKeys'
import type { AskFormChoiceField, AskFormField } from './parseAskHtml'
import { askCardLabel, NO_SELECTION, type AskFormAnswer } from './readAskForm'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { askFormIntentKey } from './askFormIntentKey'
import { useClaimAskFormFocus } from './askFormFocus'
import { useAskFormSession } from './useAskFormSession'

type ChoiceValue = Extract<AskFieldValue, { kind: 'choice' }>

interface ChoiceFieldProps {
  field: AskFormChoiceField
  value: ChoiceValue
  disabled: boolean
  idPrefix: string
  /** Whether an empty Other box reads as invalid: only after a blocked Submit or leaving the box. */
  showInvalid: boolean
  onChange: (value: ChoiceValue) => void
  onOtherBlur: () => void
}

function ChoiceField({ field, value, disabled, idPrefix, showInvalid, onChange, onOtherBlur }: ChoiceFieldProps) {
  const headingId = `${idPrefix}-heading`
  const toggle = (optionValue: string) => {
    const selected = value.selected.includes(optionValue) ? value.selected.filter((entry) => entry !== optionValue) : [...value.selected, optionValue]
    onChange({ ...value, selected })
  }

  return (
    <CardContent data-ask-field={idPrefix} className="space-y-2">
      <p id={headingId} className="whitespace-pre-line text-sm font-medium">
        {field.question}
        {field.required && <span className="font-normal text-muted-foreground">, required</span>}
      </p>
      <AskChoiceGroup
        multi={field.kind === 'checkbox'}
        options={field.options}
        selected={value.selected}
        otherSelected={value.otherSelected}
        disabled={disabled}
        idPrefix={idPrefix}
        groupLabelledBy={headingId}
        groupRequired={field.required}
        other={{
          visible: value.otherSelected,
          text: value.otherText,
          ariaLabel: `Other answer for ${field.question}`,
          invalid: showInvalid && value.otherText.trim().length === 0,
          focusOnShow: true,
          onTextChange: (otherText) => onChange({ ...value, otherText }),
          onBlur: onOtherBlur
        }}
        onSelect={(next) => onChange({ ...value, selected: [next], otherSelected: false })}
        onToggle={toggle}
        onSelectOther={() => onChange({ ...value, selected: [], otherSelected: true })}
        onToggleOther={() => onChange({ ...value, otherSelected: !value.otherSelected })}
      />
    </CardContent>
  )
}

interface TextFieldProps {
  field: Extract<AskFormField, { kind: 'text' | 'textarea' }>
  value: string
  disabled: boolean
  idPrefix: string
  onChange: (text: string) => void
}

function TextField({ field, value, disabled, idPrefix, onChange }: TextFieldProps) {
  const labelId = `${idPrefix}-heading`
  const shared = {
    value,
    readOnly: disabled,
    'aria-disabled': disabled,
    'aria-labelledby': labelId,
    'aria-required': field.required,
    onChange: (event: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(event.target.value)
  }
  return (
    <CardContent data-ask-field={idPrefix} className="space-y-2">
      <p id={labelId} className="whitespace-pre-line text-sm font-medium">
        {field.question}
        {field.required && <span className="font-normal text-muted-foreground">, required</span>}
      </p>
      {field.kind === 'textarea' ? <Textarea {...shared} /> : <Input {...shared} />}
    </CardContent>
  )
}

/** Programmatic focus target for a finished card, so Submit or Esc never leaves focus on the page body. */
const RESTING_FOCUS_CLASS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring'

interface ClaimFocusProps {
  sessionId?: string
  askItemId?: string
}

const PHASE_NOTE: Partial<Record<AskFormPhase, string>> = {
  answering: 'Submitting your answers',
  cancelling: 'Cancelled',
  done: 'Answers submitted'
}

/** The card chrome the live form and the read-only history share; `label` names the card, `resting` makes a finished card a focus target. */
function AskFormShell({ children, ref, label, resting }: { children: React.ReactNode; ref?: React.Ref<HTMLDivElement>; label: string; resting?: boolean }) {
  return (
    <Card ref={ref} size="sm" role="group" aria-label={label} {...(resting ? { tabIndex: -1, className: RESTING_FOCUS_CLASS } : {})}>
      <CardHeader>
        <CardTitle>Questions from the agent</CardTitle>
      </CardHeader>
      {children}
    </Card>
  )
}

interface AskFormLiveCardProps {
  sessionId: string
  askItemId: string
  fields: readonly AskFormField[]
}

/** Read-only question and answer pairs for a finished ask, so history shows the same card the user answered in. */
function AskFormAnswersCard({ answers, sessionId, askItemId }: { answers: readonly AskFormAnswer[] } & ClaimFocusProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  useClaimAskFormFocus(rootRef, sessionId, askItemId)
  return (
    <AskFormShell ref={rootRef} label={askCardLabel(answers)} resting>
      <CardContent>
        <dl className="space-y-2">
          {answers.map((row, index) => (
            <div key={`${row.name}-${index}`} className="space-y-1">
              <dt className="whitespace-pre-line text-sm font-medium">{row.question}</dt>
              <dd className={cn('whitespace-pre-line break-words text-sm', row.answer === NO_SELECTION && 'text-muted-foreground')}>{row.answer}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </AskFormShell>
  )
}

type AskFormCardProps = ({ answers?: undefined } & AskFormLiveCardProps) | ({ answers: readonly AskFormAnswer[] } & ClaimFocusProps)

/** The ask form card: editable and live, or read-only from `answers` once the ask has finished. */
export function AskFormCard(props: AskFormCardProps) {
  if (props.answers) return <AskFormAnswersCard answers={props.answers} sessionId={props.sessionId} askItemId={props.askItemId} />
  return <AskFormLiveCard sessionId={props.sessionId} askItemId={props.askItemId} fields={props.fields} />
}

/** One card for the whole parsed HTML form; Submit answers OMP's per-field frames in order. */
function AskFormLiveCard({ sessionId, askItemId, fields }: AskFormLiveCardProps) {
  const { session, submittable, setValue, submit, cancel } = useAskFormSession(sessionId, askItemId, fields)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const intentKey = askFormIntentKey(sessionId, askItemId)
  React.useLayoutEffect(() => {
    return () => {
      if (!rootRef.current?.contains(document.activeElement)) return
      // The row that replaces this card claims the intent and focuses itself; otherwise focus is rescued into the chat pane.
      markAskFocusPendingWithFallback(intentKey, sessionId)
    }
  }, [intentKey, sessionId])
  const editing = session.phase === 'editing'
  const note = PHASE_NOTE[session.phase]
  const idBase = `ask-form-${askItemId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  // A blocked Submit names what is missing and marks empty Other boxes; blurring an Other box marks just that one.
  const [attempted, setAttempted] = React.useState(false)
  const [blurredOther, setBlurredOther] = React.useState<ReadonlySet<number>>(new Set())
  const missing = attempted ? missingFieldMessage(fields, session.values) : null
  const cancellable = canCancel(session)

  function focusField(index: number) {
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-ask-field="${idBase}-${index}"] :is(input, textarea, [role="radio"], [role="checkbox"])`
    )
    target?.focus()
  }

  function trySubmit() {
    if (!editing) return
    if (submittable) {
      submit()
      return
    }
    setAttempted(true)
    focusField(firstMissingField(fields, session.values))
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!cancellable || !escapeCancelsForm(event.key, event.nativeEvent.isComposing, event.target as HTMLElement)) return
    event.stopPropagation()
    cancel()
  }

  return (
    // Esc is the Cancel shortcut for the whole card (FR-010) except while typing; the buttons below stay the operable controls.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={rootRef} onKeyDown={handleKeyDown}>
      <AskFormShell label={askCardLabel([])}>
        {fields.map((field, index) => {
          const value = session.values[index]
          if (!value) return null
          const idPrefix = `${idBase}-${index}`
          const key = `${field.name}-${index}`
          return value.kind === 'choice' && 'options' in field ? (
            <ChoiceField
              key={key}
              field={field}
              value={value}
              disabled={!editing}
              idPrefix={idPrefix}
              showInvalid={attempted || blurredOther.has(index)}
              onChange={(next) => setValue(index, next)}
              onOtherBlur={() => setBlurredOther((current) => new Set(current).add(index))}
            />
          ) : value.kind === 'text' && !('options' in field) ? (
            <TextField key={key} field={field} value={value.text} disabled={!editing} idPrefix={idPrefix} onChange={(text) => setValue(index, { kind: 'text', text })} />
          ) : null
        })}
        {(session.error ?? missing) && (
          <CardContent>
            <Alert variant="destructive" box="inline">
              <OctagonXIcon aria-hidden />
              <AlertDescription>{session.error ?? missing}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        <CardContent role="status" className="text-sm text-muted-foreground empty:hidden">
          {note}
        </CardContent>
        {/* Stays mounted with the card so the focused button is still in the DOM when the card unmounts. */}
        <CardFooter>
          <Button size="sm" variant="ghost" aria-disabled={!cancellable} className="aria-disabled:opacity-50" onClick={() => cancellable && cancel()}>
            Cancel
          </Button>
          <Button size="sm" aria-disabled={!editing || !submittable} aria-busy={session.phase === 'answering'} className="aria-disabled:opacity-50" onClick={trySubmit}>
            {session.phase === 'answering' && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {session.phase === 'answering' ? 'Submitting...' : 'Submit'}
          </Button>
        </CardFooter>
      </AskFormShell>
    </div>
  )
}

/** FR-006: an ask that timed out reads "Timed out, no answer" and offers no retry. */
export function AskFormTimedOut({ sessionId, askItemId }: ClaimFocusProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  useClaimAskFormFocus(rootRef, sessionId, askItemId)
  return (
    <Card ref={rootRef} size="sm" tabIndex={-1} role="group" aria-label="Questions from the agent" className={RESTING_FOCUS_CLASS}>
      <CardContent role="status" className="text-sm text-muted-foreground">
        Timed out, no answer
      </CardContent>
    </Card>
  )
}
