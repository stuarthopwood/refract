import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { CHECKBOX_BOX_CLASS, CheckboxIndicator, CheckboxItem, OPTION_MARK_CLASS, OPTION_ROW_CLASS } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AskFieldValue } from './answerPlan'
import type { AskFormPhase } from './askFormSession'
import type { AskFormChoiceField, AskFormField } from './parseAskHtml'
import { NO_SELECTION, type AskFormAnswer } from './readAskForm'
import { useAskFormSession } from './useAskFormSession'

type ChoiceValue = Extract<AskFieldValue, { kind: 'choice' }>

const OTHER_MAX_LENGTH = 4096
const CHECKED_MARK_CLASS =
  'group-data-[state=checked]/checkbox-item:border-foreground forced-colors:group-data-[state=checked]/checkbox-item:border-[Highlight]'

/** A radio value no option can collide with, so "Other" is one more row of the same group. */
function otherSentinel(field: AskFormChoiceField): string {
  let candidate = '__other__'
  while (field.options.some((option) => option.value === candidate)) candidate = `_${candidate}`
  return candidate
}

interface ChoiceFieldProps {
  field: AskFormChoiceField
  value: ChoiceValue
  disabled: boolean
  idPrefix: string
  onChange: (value: ChoiceValue) => void
}

function ChoiceField({ field, value, disabled, idPrefix, onChange }: ChoiceFieldProps) {
  const headingId = `${idPrefix}-heading`
  const otherValue = otherSentinel(field)
  const optionMark = field.kind === 'radio' ? RADIO_RING_CLASS : cn(CHECKBOX_BOX_CLASS, CHECKED_MARK_CLASS)

  const rows = field.options.map((option, index) => ({ key: option.value, label: option.label, labelId: `${idPrefix}-opt-${index}`, option }))
  const toggle = (optionValue: string) => {
    const selected = value.selected.includes(optionValue) ? value.selected.filter((entry) => entry !== optionValue) : [...value.selected, optionValue]
    onChange({ ...value, selected })
  }

  return (
    <CardContent className="space-y-2">
      <p id={headingId} className="whitespace-pre-line text-sm font-medium">
        {field.question}
        {field.required && <span className="font-normal text-muted-foreground">, required</span>}
      </p>
      {field.kind === 'radio' ? (
        <RadioGroup
          aria-labelledby={headingId}
          aria-required={field.required}
          className="gap-2"
          value={value.otherSelected ? otherValue : (value.selected[0] ?? '')}
          onValueChange={(next) => {
            if (disabled) return
            if (next === otherValue) onChange({ ...value, selected: [], otherSelected: true })
            else onChange({ ...value, selected: [next], otherSelected: false })
          }}
        >
          {rows.map((row) => (
            <RadioGroupItem key={row.key} value={row.key} aria-disabled={disabled} aria-labelledby={row.labelId} className={OPTION_ROW_CLASS}>
              <span aria-hidden className={cn(OPTION_MARK_CLASS, optionMark)}>
                <RadioGroupIndicator />
              </span>
              <span id={row.labelId} className="col-start-2 min-w-0 break-words">
                {row.label}
              </span>
            </RadioGroupItem>
          ))}
          <RadioGroupItem value={otherValue} aria-disabled={disabled} aria-label="Other" className={OPTION_ROW_CLASS}>
            <span aria-hidden className={cn(OPTION_MARK_CLASS, optionMark)}>
              <RadioGroupIndicator />
            </span>
            <span className="col-start-2 min-w-0 break-words">Other</span>
          </RadioGroupItem>
        </RadioGroup>
      ) : (
        <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
          {rows.map((row) => (
            <CheckboxItem
              key={row.key}
              checked={value.selected.includes(row.key)}
              aria-disabled={disabled}
              onCheckedChange={() => !disabled && toggle(row.key)}
              aria-labelledby={row.labelId}
              className={OPTION_ROW_CLASS}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, optionMark)}>
                <CheckboxIndicator />
              </span>
              <span id={row.labelId} className="col-start-2 min-w-0 break-words">
                {row.label}
              </span>
            </CheckboxItem>
          ))}
          <CheckboxItem
            checked={value.otherSelected}
            aria-disabled={disabled}
            onCheckedChange={() => !disabled && onChange({ ...value, otherSelected: !value.otherSelected })}
            aria-label="Other"
            className={OPTION_ROW_CLASS}
          >
            <span aria-hidden className={cn(OPTION_MARK_CLASS, optionMark)}>
              <CheckboxIndicator />
            </span>
            <span className="col-start-2 min-w-0 break-words">Other</span>
          </CheckboxItem>
        </div>
      )}
      {value.otherSelected && (
        <Input
          value={value.otherText}
          readOnly={disabled}
          aria-disabled={disabled}
          maxLength={OTHER_MAX_LENGTH}
          placeholder="Type your own answer"
          className="ml-10 w-[calc(100%-2.5rem)]"
          aria-label={`Other answer for ${field.question}`}
          aria-invalid={value.otherText.trim().length === 0}
          onChange={(event) => onChange({ ...value, otherText: event.target.value })}
        />
      )}
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
    <CardContent className="space-y-2">
      <p id={labelId} className="whitespace-pre-line text-sm font-medium">
        {field.question}
        {field.required && <span className="font-normal text-muted-foreground">, required</span>}
      </p>
      {field.kind === 'textarea' ? <Textarea {...shared} /> : <Input {...shared} />}
    </CardContent>
  )
}

const PHASE_NOTE: Partial<Record<AskFormPhase, string>> = {
  answering: 'Submitting your answers',
  cancelling: 'Cancelled',
  done: 'Answers submitted'
}

/** The card chrome the live form and the read-only history share. */
function AskFormShell({ children }: { children: React.ReactNode }) {
  return (
    <Card size="sm">
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

/** Read-only rows for a finished ask, so history shows the same card the user answered in. */
function AskFormAnswersCard({ answers }: { answers: readonly AskFormAnswer[] }) {
  return (
    <AskFormShell>
      {answers.map((row, index) => (
        <CardContent key={`${row.name}-${index}`} className="space-y-1">
          <p className="whitespace-pre-line text-sm font-medium">{row.question}</p>
          <p className={cn('whitespace-pre-line break-words text-sm', row.answer === NO_SELECTION && 'text-muted-foreground')}>{row.answer}</p>
        </CardContent>
      ))}
    </AskFormShell>
  )
}

type AskFormCardProps = ({ answers?: undefined } & AskFormLiveCardProps) | { answers: readonly AskFormAnswer[] }

/** The ask form card: editable and live, or read-only from `answers` once the ask has finished. */
export function AskFormCard(props: AskFormCardProps) {
  if (props.answers) return <AskFormAnswersCard answers={props.answers} />
  return <AskFormLiveCard sessionId={props.sessionId} askItemId={props.askItemId} fields={props.fields} />
}

/** One card for the whole parsed HTML form; Submit answers OMP's per-field frames in order. */
function AskFormLiveCard({ sessionId, askItemId, fields }: AskFormLiveCardProps) {
  const { session, submittable, setValue, submit, cancel } = useAskFormSession(sessionId, askItemId, fields)
  const editing = session.phase === 'editing'
  const note = PHASE_NOTE[session.phase]
  const idBase = `ask-form-${askItemId}`.replace(/[^a-zA-Z0-9_-]/g, '-')

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || !(editing || session.phase === 'answering')) return
    event.stopPropagation()
    cancel()
  }

  return (
    // Esc is the Cancel shortcut for the whole card (FR-010); the buttons below stay the operable controls.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDown={handleKeyDown}>
      <AskFormShell>
        {fields.map((field, index) => {
          const value = session.values[index]
          if (!value) return null
          const idPrefix = `${idBase}-${index}`
          return value.kind === 'choice' && 'options' in field ? (
            <ChoiceField key={field.name} field={field} value={value} disabled={!editing} idPrefix={idPrefix} onChange={(next) => setValue(index, next)} />
          ) : value.kind === 'text' && !('options' in field) ? (
            <TextField key={field.name} field={field} value={value.text} disabled={!editing} idPrefix={idPrefix} onChange={(text) => setValue(index, { kind: 'text', text })} />
          ) : null
        })}
        {session.error && (
          <CardContent>
            <Alert variant="destructive" box="inline">
              <OctagonXIcon aria-hidden />
              <AlertDescription>{session.error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        <CardContent role="status" className="text-sm text-muted-foreground empty:hidden">
          {note}
        </CardContent>
        {(editing || session.phase === 'answering') && (
          <CardFooter>
            <Button size="sm" variant="ghost" aria-disabled={!editing} className="aria-disabled:opacity-50" onClick={() => editing && cancel()}>
              Cancel
            </Button>
            <Button
              size="sm"
              aria-disabled={!editing || !submittable}
              aria-busy={session.phase === 'answering'}
              className="aria-disabled:opacity-50"
              onClick={() => editing && submittable && submit()}
            >
              {session.phase === 'answering' && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
              {session.phase === 'answering' ? 'Submitting...' : 'Submit'}
            </Button>
          </CardFooter>
        )}
      </AskFormShell>
    </div>
  )
}

/** FR-006: an ask that timed out reads "Timed out, no answer" and offers no retry. */
export function AskFormTimedOut() {
  return (
    <Card size="sm">
      <CardContent role="status" className="text-sm text-muted-foreground">
        Timed out, no answer
      </CardContent>
    </Card>
  )
}
