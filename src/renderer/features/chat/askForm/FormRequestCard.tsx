import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import type { PendingRequest } from '../../../../shared/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { ASKED_USER_TITLE } from '../askedUserLine'
import type { AskFieldValue } from './answerPlan'
import { AskFormShell } from './AskFormCard'
import { ChoiceField, DropdownField, InputField, TextField } from './AskFormFields'
import { enterSubmitsForm, escapeCancelsForm } from './askFormKeys'
import {
  FORM_CANCEL,
  FORM_TIMED_OUT,
  firstInvalidField,
  formDeadlineText,
  formSubmission,
  scheduleDeadline,
  startingValues,
  visibleErrors
} from './formRequest'
import { parseAskHtml, type AskFormField } from './parseAskHtml'
import { offersOther } from './validateAskForm'
import { useFormResponder } from './useFormResponder'
import { UnshownFormNotice } from './UnshownFormNotice'

type FormRequest = Extract<PendingRequest, { kind: 'form' }>

interface FormRequestCardProps {
  sessionId: string
  request: FormRequest
}

/** A v19 whole-form request: parsed once, answered once with `{data}` or a cancel. */
export function FormRequestCard({ sessionId, request }: FormRequestCardProps) {
  const fields = React.useMemo(() => parseAskHtml(request.html), [request.html])
  return fields ? <FormBody sessionId={sessionId} request={request} fields={fields} /> : <UnshownFormNotice sessionId={sessionId} requestId={request.requestId} />
}

interface FormFieldProps {
  field: AskFormField
  value: AskFieldValue
  disabled: boolean
  idPrefix: string
  error: string | null
  /** Whether an empty Other box reads as invalid. */
  showInvalid: boolean
  onChange: (value: AskFieldValue) => void
  onTouch: () => void
}

/** Picks the control for one field; a select with `multiple` is a checkbox group, a single one a dropdown. */
function FormField({ field, value, disabled, idPrefix, error, showInvalid, onChange, onTouch }: FormFieldProps) {
  if (value.kind === 'choice' && 'options' in field) {
    if (field.kind === 'select' && !field.multiple) {
      return <DropdownField field={field} value={value} disabled={disabled} idPrefix={idPrefix} error={error} onChange={onChange} />
    }
    return (
      <ChoiceField
        field={field}
        value={value}
        disabled={disabled}
        idPrefix={idPrefix}
        showInvalid={showInvalid}
        offerOther={offersOther(field)}
        error={error}
        onChange={onChange}
        onOtherBlur={onTouch}
      />
    )
  }
  if (value.kind !== 'text') return null
  const onText = (text: string) => onChange({ kind: 'text', text })
  const text = { value: value.text, disabled, idPrefix, error, onChange: onText, onBlur: onTouch }
  switch (field.kind) {
    case 'text':
    case 'textarea':
      return <TextField field={field} {...text} />
    case 'number':
    case 'range':
    case 'email':
    case 'url':
      return <InputField field={field} {...text} />
    default:
      return null
  }
}

const PHASE_NOTE = { idle: undefined, sending: 'Submitting your answers', sent: 'Answers submitted' } as const

function FormBody({ sessionId, request, fields }: FormRequestCardProps & { fields: readonly AskFormField[] }) {
  const { responder, phase, error } = useFormResponder(sessionId, request.requestId)
  const [values, setValues] = React.useState(() => startingValues(fields))
  const [touched, setTouched] = React.useState<ReadonlySet<number>>(new Set())
  const [attempted, setAttempted] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const submission = React.useMemo(() => formSubmission(fields, values), [fields, values])
  const shownErrors = visibleErrors(submission.errors, touched, attempted)
  const editing = phase === 'idle'
  const settled = phase === 'sent'
  const idBase = `ask-form-${request.requestId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const intentKey = `${sessionId}:${request.requestId}`

  // OMP cancels the form itself at the deadline; this answers first so the card does not outlive it.
  React.useEffect(() => {
    if (settled) return undefined
    return scheduleDeadline(request.deadlineAt, Date.now(), () => void responder.respond(FORM_TIMED_OUT))
  }, [request.deadlineAt, responder, settled])

  React.useLayoutEffect(() => {
    return () => {
      if (!rootRef.current?.contains(document.activeElement)) return
      markAskFocusPendingWithFallback(intentKey, sessionId)
    }
  }, [intentKey, sessionId])

  function touch(index: number) {
    setTouched((current) => (current.has(index) ? current : new Set(current).add(index)))
  }

  function change(index: number, value: AskFieldValue) {
    setValues((current) => current.map((existing, at) => (at === index ? value : existing)))
    touch(index)
  }

  function trySubmit() {
    if (!editing) return
    if (submission.answer) {
      void responder.respond(submission.answer)
      return
    }
    setAttempted(true)
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-ask-field="${idBase}-${firstInvalidField(submission.errors)}"] :is(input, textarea, button, [role="radio"], [role="checkbox"])`
    )
    target?.focus()
  }

  function cancel() {
    if (editing) void responder.respond(FORM_CANCEL)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // A dropdown's list renders in a portal; its keys reach this handler through React but belong to the list.
    const target = event.target as HTMLElement
    if (!editing || !event.currentTarget.contains(target)) return
    if (enterSubmitsForm(event.key, event.nativeEvent.isComposing, event.repeat, target)) {
      event.preventDefault()
      trySubmit()
      return
    }
    if (!escapeCancelsForm(event.key, event.nativeEvent.isComposing, target)) return
    event.stopPropagation()
    cancel()
  }

  const note = PHASE_NOTE[phase]
  return (
    // Esc and Enter are card-wide shortcuts for Cancel and Submit; the footer buttons stay the operable controls.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={rootRef} onKeyDown={handleKeyDown}>
      <AskFormShell label={ASKED_USER_TITLE}>
        {fields.map((field, index) => {
          const value = values[index]
          if (!value) return null
          return (
            <FormField
              key={`${field.name}-${index}`}
              field={field}
              value={value}
              disabled={!editing}
              idPrefix={`${idBase}-${index}`}
              error={shownErrors[index] ?? null}
              showInvalid={attempted || touched.has(index)}
              onChange={(next) => change(index, next)}
              onTouch={() => touch(index)}
            />
          )
        })}
        {error && (
          <CardContent>
            <Alert variant="destructive" box="inline">
              <OctagonXIcon aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        {request.deadlineAt !== undefined && <CardContent className="text-sm text-muted-foreground">{formDeadlineText(request.deadlineAt)}</CardContent>}
        <CardContent role="status" className="text-sm text-muted-foreground empty:hidden">
          {note}
        </CardContent>
        <CardFooter>
          <Button size="sm" variant="ghost" aria-disabled={!editing} className="aria-disabled:opacity-50" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" aria-disabled={!editing || !submission.answer} aria-busy={phase === 'sending'} className="aria-disabled:opacity-50" onClick={trySubmit}>
            {phase === 'sending' && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {phase === 'sending' ? 'Submitting...' : 'Submit'}
          </Button>
        </CardFooter>
      </AskFormShell>
    </div>
  )
}
