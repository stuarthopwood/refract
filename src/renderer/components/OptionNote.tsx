import * as React from 'react'
import { XIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** The host rejects a longer note (FR-134), so the editor stops typing here. */
export const OPTION_NOTE_MAX_LENGTH = 1000
/** The counter only appears near the cap, where it matters. */
const COUNTER_FROM = 900

/** "n/1000" once the text is near the cap, otherwise null. */
export function noteCounterText(length: number): string | null {
  return length >= COUNTER_FROM ? `${length}/${OPTION_NOTE_MAX_LENGTH}` : null
}

/** The spoken limit warning. It is constant within a band, so a live region holding it announces at 900, 950 and 1000 characters, not on every keystroke. */
export function noteLimitAnnouncement(length: number): string {
  if (length >= OPTION_NOTE_MAX_LENGTH) return 'Note is at the 1000 character limit'
  if (length >= 950) return 'Fewer than 50 characters left'
  if (length >= COUNTER_FROM) return 'Fewer than 100 characters left'
  return ''
}

/** A note is one line of text that wraps: line breaks (typed or pasted) become spaces and the cap is enforced. */
export function normalizeNoteText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, OPTION_NOTE_MAX_LENGTH)
}

/** What a key does in the editor. Enter never reaches the card, and Enter that confirms IME text is not a save. */
export function noteEditorAction(event: { key: string; nativeEvent: { isComposing: boolean } }): 'save' | 'cancel' | null {
  if (event.nativeEvent.isComposing) return null
  if (event.key === 'Enter') return 'save'
  if (event.key === 'Escape') return 'cancel'
  return null
}

/** The "press N" hint under a question's options. */
export function OptionNoteHint({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      Press <Kbd>N</Kbd> to add a note to selected option
    </p>
  )
}

interface OptionNoteButtonProps {
  optionLabel: string
  hasNote: boolean
  disabled: boolean
  onClick: () => void
  className?: string
}

/** Opens the note editor on an option; the same action as the N key. */
export function OptionNoteButton({ optionLabel, hasNote, disabled, onClick, className }: OptionNoteButtonProps) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={`${hasNote ? 'Edit note on' : 'Add a note to'} ${optionLabel}`}
      aria-keyshortcuts="N"
      aria-disabled={disabled}
      className={cn('aria-disabled:opacity-50', className)}
      onClick={() => !disabled && onClick()}
    >
      {hasNote ? 'Edit note' : 'Note'}
      <Kbd aria-hidden>N</Kbd>
    </Button>
  )
}

interface OptionNoteViewProps {
  text: string
  optionLabel: string
  disabled: boolean
  onEdit: () => void
  onRemove: () => void
}

/** A saved note under its option: the "Note:" label (not colour) carries it, with inline Edit and remove. */
export function OptionNoteView({ text, optionLabel, disabled, onEdit, onRemove }: OptionNoteViewProps) {
  return (
    <div className="ml-6 flex items-start gap-2 border-t border-border bg-severity-warning-bg pt-2 text-xs">
      <p className="min-w-0 flex-1 break-words">
        <span className="font-medium text-severity-warning">Note:</span> {text}
      </p>
      <OptionNoteButton optionLabel={optionLabel} hasNote disabled={disabled} onClick={onEdit} />
      <IconButton label={`Remove note on ${optionLabel}`} size="icon-xs" aria-disabled={disabled} className="aria-disabled:opacity-50" onClick={() => !disabled && onRemove()}>
        <XIcon aria-hidden />
      </IconButton>
    </div>
  )
}

interface OptionNoteEditorProps {
  initial: string
  optionLabel: string
  /** An empty text removes the note. */
  onSave: (text: string) => void
  onCancel: () => void
}

/** Single-line editor that wraps. Enter saves (never submits the card), Escape cancels, and it takes focus when it opens. */
export function OptionNoteEditor({ initial, optionLabel, onSave, onCancel }: OptionNoteEditorProps) {
  const [text, setText] = React.useState(() => normalizeNoteText(initial))
  const ref = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => {
    const field = ref.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])
  const counter = noteCounterText(text.length)
  const hintId = React.useId()
  const counterId = React.useId()

  return (
    <div className="ml-6 flex flex-col gap-1 border-t border-border pt-2">
      <Textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={OPTION_NOTE_MAX_LENGTH}
        aria-label={`Note on ${optionLabel}`}
        aria-describedby={counter ? `${hintId} ${counterId}` : hintId}
        placeholder="Add a note for the agent"
        className="min-h-0 resize-none text-xs md:text-xs"
        onChange={(event) => setText(normalizeNoteText(event.target.value))}
        onKeyDown={(event) => {
          const action = noteEditorAction(event)
          if (!action) return
          event.preventDefault()
          event.stopPropagation()
          if (action === 'save') onSave(text)
          else onCancel()
        }}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span id={hintId}>Enter saves, Escape cancels</span>
        {counter && (
          <span id={counterId} data-note-counter className="tabular-nums">
            {counter}
          </span>
        )}
        <span role="status" className="sr-only">
          {noteLimitAnnouncement(text.length)}
        </span>
      </div>
    </div>
  )
}

/** What a choice group needs to offer notes: saved texts by option value, which option's editor is open, and the four actions. */
export interface AskChoiceNotes {
  texts: Readonly<Record<string, string>>
  editing: string | null
  onEdit: (value: string) => void
  onSave: (value: string, text: string) => void
  onCancel: (value: string) => void
  onRemove: (value: string) => void
}

interface OptionNoteSlotProps {
  value: string
  label: string
  picked: boolean
  disabled: boolean
  notes: AskChoiceNotes
}

/** Under a picked option: its editor while open, else its saved note, else the Note button. An unpicked option shows only a hover or focus-within "Note [N]" button that picks it first (its kept note stays hidden until then). */
export function OptionNoteSlot({ value, label, picked, disabled, notes }: OptionNoteSlotProps) {
  if (!picked) {
    if (disabled) return null
    // Overlaid on the row so revealing it never moves the rows below; opacity (not display) keeps it focusable so focus-within can show it.
    return (
      <OptionNoteButton
        optionLabel={label}
        hasNote={false}
        disabled={disabled}
        onClick={() => notes.onEdit(value)}
        className="absolute inset-y-0 right-2 my-auto border-border bg-background opacity-0 group-focus-within/option:opacity-100 group-hover/option:opacity-100"
      />
    )
  }
  const text = notes.texts[value]
  if (notes.editing === value) {
    return <OptionNoteEditor initial={text ?? ''} optionLabel={label} onSave={(next) => notes.onSave(value, next)} onCancel={() => notes.onCancel(value)} />
  }
  if (text) {
    return <OptionNoteView text={text} optionLabel={label} disabled={disabled} onEdit={() => notes.onEdit(value)} onRemove={() => notes.onRemove(value)} />
  }
  return <OptionNoteButton optionLabel={label} hasNote={false} disabled={disabled} onClick={() => notes.onEdit(value)} className="ml-6 self-start" />
}
