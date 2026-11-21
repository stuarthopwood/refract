import { ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon, PencilLineIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FocusEvent, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { draftKey, useChecklistDraftsStore, type ItemNote } from '@/state/checklist-drafts'
import { sendItemAction } from '@/state/checklist-item-send'
import type { ChecklistItem } from '../../../../shared/checklist'
import { ItemForm, ItemNoteLine } from './ItemForm'
import {
  canDoItem,
  canRefocusAfterSend,
  derivePresentation,
  dismissForm,
  doItemHint,
  doItemLabel,
  effectiveMode,
  isNoteStale,
  shouldFocusOnOpen,
  showsDoItem,
  showsDoItemHint,
  submitAndRefocus,
  type ItemFormMode
} from './item-controls'

interface ControlsViewProps {
  item: ChecklistItem
  open: boolean
  mode: ItemFormMode
  text: string
  agentRunning: boolean
  inFlight: boolean
  note: ItemNote | undefined
  /** Focus is somewhere inside this item's controls. */
  focused: boolean
  rootRef?: Ref<HTMLDivElement>
  disclosureRef?: Ref<HTMLButtonElement>
  textareaRef?: Ref<HTMLTextAreaElement>
  onFocusWithin?: (event: FocusEvent<HTMLDivElement>) => void
  onBlurWithin?: (event: FocusEvent<HTMLDivElement>) => void
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
  focused,
  rootRef,
  disclosureRef,
  textareaRef,
  onFocusWithin,
  onBlurWithin,
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
  const hintShown = showsDoItemHint(hint, open, focused)
  const working = item.status === 'in_progress'
  const doBlocked = !canDoItem(item) || !agentRunning || inFlight
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon

  return (
    <div data-slot="checklist-item-controls" ref={rootRef} className="flex flex-col gap-1" onFocus={onFocusWithin} onBlur={onBlurWithin}>
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
            className={working ? 'aria-disabled:opacity-100' : 'aria-disabled:text-muted-foreground'}
            type="button"
            variant="ghost"
            size="sm"
            // `aria-disabled`, never `disabled`: focus must stay on the button when the agent takes the item.
            aria-disabled={doBlocked}
            aria-busy={working || undefined}
            aria-label={`${doItemLabel(item)}: ${item.text}`}
            aria-describedby={hintShown ? hintId : undefined}
            loading={inFlight && !working}
            onClick={() => {
              if (!doBlocked) onDoItem()
            }}
          >
            {working && <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />}
            {doItemLabel(item)}
          </Button>
        )}
      </div>
      {hintShown && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <ItemNoteLine note={note} />
      {open && (
        <div id={formId}>
          <ItemForm
            itemText={item.text}
            mode={mode}
            text={text}
            agentRunning={agentRunning}
            inFlight={inFlight}
            textareaRef={textareaRef}
            onModeChange={onModeChange}
            onTextChange={onTextChange}
            onSend={onSend}
            onClose={onClose}
          />
        </div>
      )}
    </div>
  )
}

interface ChecklistItemControlsProps {
  sessionId: string
  checklistId: string
  item: ChecklistItem
  agentRunning: boolean
}

/** Wires one item's controls to the drafts store and the send path; only this item's slice re-renders it. */
export function ChecklistItemControls({ sessionId, checklistId, item, agentRunning }: ChecklistItemControlsProps) {
  const key = draftKey({ sessionId, checklistId, itemId: item.id })
  const open = useChecklistDraftsStore((s) => s.openKey === key)
  const draft = useChecklistDraftsStore((s) => s.drafts[key])
  const inFlight = useChecklistDraftsStore((s) => s.inFlight[key] === true)
  const stored = useChecklistDraftsStore((s) => s.notes[key])
  const note = stored !== undefined && !isNoteStale(stored.stamp, item) ? stored : undefined
  const rootRef = useRef<HTMLDivElement>(null)
  const disclosureRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wasOpen = useRef(open)
  const [focused, setFocused] = useState(false)
  const mode = effectiveMode(draft?.mode ?? 'ask', agentRunning)
  const text = draft?.text ?? ''

  useEffect(() => {
    if (shouldFocusOnOpen(wasOpen.current, open)) textareaRef.current?.focus()
    wasOpen.current = open
  }, [open])

  const drafts = useChecklistDraftsStore.getState
  // With no agent there is nobody to ask, so the form opens on the value.
  const openForm = (next?: ItemFormMode) => drafts().open(key, next ?? (agentRunning ? undefined : 'value'))
  const stillWanted = () =>
    canRefocusAfterSend({
      openKey: drafts().openKey,
      key,
      focusInsideItem: rootRef.current?.contains(document.activeElement) === true,
      focusOnBody: document.activeElement === document.body
    })

  return (
    <ChecklistItemControlsView
      item={item}
      open={open}
      mode={mode}
      text={text}
      agentRunning={agentRunning}
      inFlight={inFlight}
      note={note}
      focused={focused}
      rootRef={rootRef}
      disclosureRef={disclosureRef}
      textareaRef={textareaRef}
      onFocusWithin={() => setFocused(true)}
      onBlurWithin={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onToggle={() => (open ? dismissForm(drafts().close, disclosureRef.current) : openForm())}
      onNeedsValue={() => {
        openForm('value')
        textareaRef.current?.focus()
      }}
      onDoItem={() => void sendItemAction({ sessionId, itemId: item.id, action: 'complete', agentRunning })}
      onModeChange={(next) => drafts().setMode(key, next)}
      onTextChange={(next) => drafts().setText(key, next)}
      onSend={() => void submitAndRefocus(() => sendItemAction({ sessionId, itemId: item.id, action: mode, text, agentRunning }), disclosureRef.current, stillWanted)}
      onClose={() => dismissForm(drafts().close, disclosureRef.current)}
    />
  )
}
