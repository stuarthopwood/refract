import * as React from 'react'
import type { PendingRequest } from '../../../../shared/model'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { ASKED_USER_TITLE } from '../askedUserLine'
import type { AskFieldValue } from './answerPlan'
import { AskFormFooter, AskFormShell } from './AskFormChrome'
import { ChoiceField, DropdownField, InputField, TextField } from './AskFormFields'
import { askFormIntentKey } from './askFormIntentKey'
import { focusField } from './askFormFocusTarget'
import { enterSubmitsForm, escapeCancelsForm } from './askFormKeys'
import {
  FORM_CANCEL,
  FORM_TIMED_OUT,
  firstInvalidField,
  footerBusy,
  formDeadlineText,
  formStatusNote,
  formSubmission,
  refusedPastDeadline,
  retryState,
  scheduleDeadline,
  startingValues,
  visibleErrors,
  withTouched
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
      return <DropdownField field={field} value={value} disabled={disabled} idPrefix={idPrefix} error={error} onChange={onChange} onBlur={onTouch} />
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
        onBlur={onTouch}
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

function FormBody({ sessionId, request, fields }: FormRequestCardProps & { fields: readonly AskFormField[] }) {
  const { responder, phase, kind, error } = useFormResponder(sessionId, request.requestId)
  const [values, setValues] = React.useState(() => startingValues(fields))
  const [touched, setTouched] = React.useState<ReadonlySet<number>>(new Set())
  const [attempted, setAttempted] = React.useState(false)
  // A fresh object per blocked Submit, so focus moves once the invalid state has rendered.
  const [focusRequest, setFocusRequest] = React.useState<{ index: number } | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const submission = React.useMemo(() => formSubmission(fields, values), [fields, values])
  const shownErrors = visibleErrors(submission.errors, touched, attempted)
  const editing = phase === 'idle'
  // A sent form, or a refused timed-out cancel, must not be answered again by the deadline timer.
  const closed = phase === 'sent' || phase === 'locked'
  const idBase = `ask-form-${request.requestId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const intentKey = askFormIntentKey(sessionId, request.requestId)
  const busy = footerBusy(phase, kind)
  const retry = retryState(phase, kind)

  // OMP cancels the form itself at the deadline; this answers first so the card does not outlive it.
  React.useEffect(() => {
    if (closed) return undefined
    return scheduleDeadline(request.deadlineAt, Date.now(), () => void responder.respond(FORM_TIMED_OUT))
  }, [request.deadlineAt, responder, closed])

  // A refusal that lands after the deadline times the form out and locks it instead of re-opening it.
  React.useEffect(() => {
    if (refusedPastDeadline(phase, error, request.deadlineAt, Date.now())) void responder.respond(FORM_TIMED_OUT)
  }, [phase, error, request.deadlineAt, responder])

  React.useEffect(() => {
    if (focusRequest) focusField(rootRef.current, `${idBase}-${focusRequest.index}`)
  }, [focusRequest, idBase])

  React.useLayoutEffect(() => {
    return () => {
      if (!rootRef.current?.contains(document.activeElement)) return
      markAskFocusPendingWithFallback(intentKey, sessionId)
    }
  }, [intentKey, sessionId])

  // Typing alone never marks a field touched: its message waits for leaving the field or a blocked Submit.
  function touch(index: number) {
    setTouched((current) => withTouched(current, index))
  }

  function change(index: number, value: AskFieldValue) {
    setValues((current) => current.map((existing, at) => (at === index ? value : existing)))
  }

  function trySubmit() {
    if (!editing) return
    if (submission.answer) {
      void responder.respond(submission.answer)
      return
    }
    setAttempted(true)
    setFocusRequest({ index: firstInvalidField(submission.errors) })
  }

  function cancel() {
    if (editing) void responder.respond(FORM_CANCEL)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // A dropdown's list renders in a portal; its keys reach this handler through React but belong to the list.
    const target = event.target as HTMLElement
    if (!editing || !event.currentTarget.contains(target)) return
    if (enterSubmitsForm(event.key, event.nativeEvent.isComposing, event.repeat, target, event)) {
      event.preventDefault()
      trySubmit()
      return
    }
    if (!escapeCancelsForm(event.key, event.nativeEvent.isComposing, target)) return
    event.stopPropagation()
    cancel()
  }

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
        <AskFormFooter
          error={error}
          retry={retry.visible ? { busy: retry.busy, onRetry: () => void responder.respond(FORM_TIMED_OUT) } : undefined}
          deadlineText={editing && request.deadlineAt !== undefined ? formDeadlineText(request.deadlineAt) : undefined}
          note={formStatusNote(phase, kind)}
          cancellable={editing}
          submittable={editing && submission.answer !== null}
          sending={busy.sending}
          cancelling={busy.cancelling}
          onCancel={cancel}
          onSubmit={trySubmit}
        />
      </AskFormShell>
    </div>
  )
}
