import * as React from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { isRowEnter } from '@/components/askChoiceKeys'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { firstMissingField, missingFieldMessage } from './answerPlan'
import { canCancel, type AskFormPhase } from './askFormSession'
import { escapeCancelsForm } from './askFormKeys'
import { ChoiceField, TextField } from './AskFormFields'
import type { AskFormFrameField } from './parseAskHtml'
import { ASKED_USER_TITLE } from '../askedUserLine'
import { markAskFocusPendingWithFallback } from '@/state/ask-focus-intent'
import { askFormIntentKey } from './askFormIntentKey'
import { useAskFormSession } from './useAskFormSession'

const PHASE_NOTE: Partial<Record<AskFormPhase, string>> = {
  answering: 'Submitting your answers',
  cancelling: 'Cancelled',
  done: 'Answers submitted'
}

/** The live form's card chrome; `label` names the card. */
function AskFormShell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <Card size="sm" role="group" aria-label={label}>
      <CardHeader>
        <CardTitle>Questions from the agent</CardTitle>
      </CardHeader>
      {children}
    </Card>
  )
}

interface AskFormCardProps {
  sessionId: string
  askItemId: string
  fields: readonly AskFormFrameField[]
}

/** One card for the whole parsed HTML form; Submit answers OMP's per-field frames in order. */
export function AskFormCard({ sessionId, askItemId, fields }: AskFormCardProps) {
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
    if (editing && isRowEnter(event)) {
      event.preventDefault()
      trySubmit()
      return
    }
    if (!cancellable || !escapeCancelsForm(event.key, event.nativeEvent.isComposing, event.target as HTMLElement)) return
    event.stopPropagation()
    cancel()
  }

  return (
    // Esc is the Cancel shortcut for the whole card (FR-010) except while typing; the buttons below stay the operable controls.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={rootRef} onKeyDown={handleKeyDown}>
      <AskFormShell label={ASKED_USER_TITLE}>
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
