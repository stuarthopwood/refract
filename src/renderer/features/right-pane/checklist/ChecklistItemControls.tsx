import { ChevronDownIcon, ChevronRightIcon, PencilLineIcon } from 'lucide-react'
import { useEffect, useRef, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionsStore } from '@/state/sessions-store'
import { draftKey, useChecklistDraftsStore, type ItemNote } from '@/state/checklist-drafts'
import { sendItemAction } from '@/state/checklist-item-send'
import type { ChecklistItem } from '../../../../shared/checklist'
import { ItemForm, ItemNoteLine } from './ItemForm'
import { derivePresentation, dismissForm, doItemHint, doItemLabel, showsDoItem, submitAndRefocus, type ItemFormMode } from './item-controls'

interface ControlsViewProps {
  item: ChecklistItem
  open: boolean
  mode: ItemFormMode
  text: string
  agentRunning: boolean
  inFlight: boolean
  note: ItemNote | undefined
  disclosureRef?: Ref<HTMLButtonElement>
  textareaRef?: Ref<HTMLTextAreaElement>
  onToggle: () => void
  onNeedsValue: () => void
  onDoItem: () => void
  onModeChange: (mode: ItemFormMode) => void
  onTextChange: (text: string) => void
  onSend: () => void
  onClose: () => void
}

/** The per-item buttons and the one open form; a pure view so it can be tested without a DOM. */
export function ChecklistItemControlsView({
  item,
  open,
  mode,
  text,
  agentRunning,
  inFlight,
  note,
  disclosureRef,
  textareaRef,
  onToggle,
  onNeedsValue,
  onDoItem,
  onModeChange,
  onTextChange,
  onSend,
  onClose
}: ControlsViewProps) {
  const formId = `checklist-item-form-${item.id}`
  const hintId = `${formId}-do-hint`
  const awaitingInput = derivePresentation(item) === 'awaiting_input'
  const doItem = showsDoItem(item)
  const hint = doItem ? doItemHint(item, agentRunning) : null
  const working = item.status === 'in_progress'
  const doBlocked = working || hint !== null || inFlight
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon

  return (
    <div data-slot="checklist-item-controls" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          ref={disclosureRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          aria-label={`Ask or provide a value for ${item.text}`}
          onClick={onToggle}
        >
          <Chevron aria-hidden />
          Ask or provide a value
        </Button>
        {awaitingInput && (
          <Button type="button" variant="outline" size="sm" aria-label={`Needs a value: ${item.text}`} onClick={onNeedsValue}>
            <PencilLineIcon aria-hidden />
            Needs a value
          </Button>
        )}
        {doItem && (
          <Button
            className="aria-disabled:text-muted-foreground"
            type="button"
            variant="ghost"
            size="sm"
            // `aria-disabled`, never `disabled`: focus must stay on the button when the agent takes the item.
            aria-disabled={doBlocked}
            aria-label={`${doItemLabel(item)}: ${item.text}`}
            aria-describedby={hint !== null ? hintId : undefined}
            loading={working || inFlight}
            onClick={() => {
              if (!doBlocked) onDoItem()
            }}
          >
            {doItemLabel(item)}
          </Button>
        )}
      </div>
      {hint !== null && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {open ? (
        <div id={formId}>
          <ItemForm
            itemText={item.text}
            mode={mode}
            text={text}
            agentRunning={agentRunning}
            inFlight={inFlight}
            note={note}
            textareaRef={textareaRef}
            onModeChange={onModeChange}
            onTextChange={onTextChange}
            onSend={onSend}
            onClose={onClose}
          />
        </div>
      ) : (
        <ItemNoteLine note={note} />
      )}
    </div>
  )
}

interface ChecklistItemControlsProps {
  sessionId: string
  checklistId: string
  item: ChecklistItem
}

/** Wires one item's controls to the drafts store and the send path; only this item's slice re-renders it. */
export function ChecklistItemControls({ sessionId, checklistId, item }: ChecklistItemControlsProps) {
  const key = draftKey({ sessionId, checklistId, itemId: item.id })
  const open = useChecklistDraftsStore((s) => s.openKey === key)
  const draft = useChecklistDraftsStore((s) => s.drafts[key])
  const inFlight = useChecklistDraftsStore((s) => s.inFlight[key] === true)
  const note = useChecklistDraftsStore((s) => s.notes[key])
  const agentRunning = useSessionsStore((s) => (s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped') !== 'stopped')
  const disclosureRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mode = draft?.mode ?? 'ask'
  const text = draft?.text ?? ''

  useEffect(() => {
    if (open) textareaRef.current?.focus()
  }, [open])

  const drafts = useChecklistDraftsStore.getState
  // With no agent there is nobody to ask, so the form opens on the value.
  const openForm = (next?: ItemFormMode) => drafts().open(key, next ?? (agentRunning ? undefined : 'value'))

  return (
    <ChecklistItemControlsView
      item={item}
      open={open}
      mode={mode}
      text={text}
      agentRunning={agentRunning}
      inFlight={inFlight}
      note={note}
      disclosureRef={disclosureRef}
      textareaRef={textareaRef}
      onToggle={() => (open ? dismissForm(drafts().close, disclosureRef.current) : openForm())}
      onNeedsValue={() => {
        openForm('value')
        textareaRef.current?.focus()
      }}
      onDoItem={() => void sendItemAction({ sessionId, itemId: item.id, action: 'complete', agentRunning })}
      onModeChange={(next) => drafts().setMode(key, next)}
      onTextChange={(next) => drafts().setText(key, next)}
      onSend={() => void submitAndRefocus(() => sendItemAction({ sessionId, itemId: item.id, action: mode, text, agentRunning }), disclosureRef.current)}
      onClose={() => dismissForm(drafts().close, disclosureRef.current)}
    />
  )
}
