import { useId } from 'react'
import type { Ref } from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import type { ItemNote } from '@/state/checklist-drafts'
import { ASK_UNAVAILABLE_REASON, type ItemFormMode, byteLength, capFor, deliveryLine, handleFormKey, sendBlock, sendLabel } from './item-controls'

const PLAIN_TEXT = 'whitespace-pre-wrap break-words'

const MODES: readonly { value: ItemFormMode; label: string }[] = [
  { value: 'ask', label: 'Ask the agent' },
  { value: 'value', label: 'Provide a value' }
]

/** Where the last send went or why it did not; the wrapper stays mounted so a new line is announced as a change. */
export function ItemNoteLine({ note }: { note: ItemNote | undefined }) {
  const delivery = note?.kind === 'delivery' ? deliveryLine(note.delivery) : null
  return (
    <div data-slot="checklist-item-note">
      {delivery !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {delivery}
        </p>
      )}
      {note?.kind === 'refusal' && (
        <InlineStatus tone="error" density="compact" className={`p-0 ${PLAIN_TEXT}`}>
          {note.message}
        </InlineStatus>
      )}
    </div>
  )
}

interface ItemFormProps {
  itemText: string
  mode: ItemFormMode
  text: string
  agentRunning: boolean
  /** A send for this item is in flight. */
  inFlight: boolean
  note: ItemNote | undefined
  textareaRef?: Ref<HTMLTextAreaElement>
  onModeChange: (mode: ItemFormMode) => void
  onTextChange: (text: string) => void
  onSend: () => void
  onClose: () => void
}

/** The one open form: ask the agent or give a value, with the byte count, the plain-text warning and the last outcome. */
export function ItemForm({ itemText, mode, text, agentRunning, inFlight, note, textareaRef, onModeChange, onTextChange, onSend, onClose }: ItemFormProps) {
  const id = useId()
  const warningId = `${id}-warning`
  const counterId = `${id}-counter`
  const reasonId = `${id}-reason`
  const bytes = byteLength(text)
  const cap = capFor(mode)
  const tooLong = bytes > cap
  const block = sendBlock(mode, text, agentRunning)
  const send = () => {
    if (block === null && !inFlight) onSend()
  }

  return (
    <form
      data-slot="checklist-item-form"
      className="flex flex-col gap-2 pt-1"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <RadioGroup aria-label="What to send" value={mode} onValueChange={(value) => onModeChange(value as ItemFormMode)} className="gap-1">
        {MODES.map(({ value, label }) => {
          const unavailable = value === 'ask' && !agentRunning
          return (
            <RadioGroupItem
              key={value}
              value={value}
              disabled={unavailable}
              aria-describedby={unavailable ? reasonId : undefined}
              className="min-h-6 w-auto flex-row items-center gap-2 rounded-none border-none bg-transparent px-0 py-0 text-sm hover:bg-transparent data-[state=checked]:border-none data-[state=checked]:bg-transparent"
            >
              <span aria-hidden className={RADIO_RING_CLASS}>
                <RadioGroupIndicator className={RADIO_DOT_CLASS} />
              </span>
              {label}
            </RadioGroupItem>
          )
        })}
      </RadioGroup>
      {!agentRunning && (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {ASK_UNAVAILABLE_REASON}
        </p>
      )}
      <Textarea
        ref={textareaRef}
        aria-label={`${mode === 'ask' ? 'Question' : 'Value'} for ${itemText}`}
        aria-describedby={`${warningId} ${counterId}`}
        aria-invalid={tooLong || undefined}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => handleFormKey(event, { send, close: onClose })}
        className="min-h-16 text-sm"
      />
      <p id={warningId} className="text-xs text-muted-foreground">
        Plain text, stored in the checklist and sent to the agent. Do not put secrets here.
      </p>
      <p id={counterId} className={tooLong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {bytes} of {cap} bytes{tooLong ? ', too long' : ''}
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={inFlight} aria-disabled={block !== null || inFlight || undefined}>
          {sendLabel(mode, agentRunning)}
        </Button>
      </div>
      <ItemNoteLine note={note} />
    </form>
  )
}
