import * as React from 'react'
import { RecommendedBadge } from '@/components/RecommendedBadge'
import { CHECKBOX_BOX_CLASS, CheckboxIndicator, CheckboxItem, OPTION_MARK_CLASS, OPTION_RECOMMENDED_ROW_CLASS, OPTION_ROW_CLASS } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ACCEPTS_ENTER_ATTRIBUTE, ASK_OPTION_ATTRIBUTE, MAX_DIGIT_OPTIONS, isPlainEnter } from '@/components/askChoiceKeys'
import { type AskChoiceNotes, OptionNoteSlot } from '@/components/OptionNote'
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'

const OTHER_MAX_LENGTH = 4096
const CHECKED_MARK_CLASS =
  'group-data-[state=checked]/checkbox-item:border-foreground forced-colors:group-data-[state=checked]/checkbox-item:border-[Highlight]'

export interface AskChoiceOption {
  value: string
  label: string
  description?: string | undefined
  /** OMP's recommended option: tinted row plus an icon and "Recommended" text (never colour alone), and ", Recommended" for assistive tech. */
  recommended?: boolean | undefined
  /** Why it is recommended; shown after the "Recommended" cue and read as the row's description. Ignored on a row that is not recommended. */
  reason?: string | undefined
}

export interface AskChoiceOther {
  /** Whether the free-text box shows; the "Other" row itself always shows. */
  visible: boolean
  text: string
  ariaLabel: string
  invalid?: boolean | undefined
  /** Moves focus into the box when it appears after the user chose "Other", not when the card mounts with it open. */
  focusOnShow?: boolean | undefined
  onTextChange: (text: string) => void
  onKeyDown?: ((event: React.KeyboardEvent<HTMLInputElement>) => void) | undefined
  onBlur?: (() => void) | undefined
}

interface AskChoiceGroupProps {
  multi: boolean
  options: readonly AskChoiceOption[]
  selected: readonly string[]
  otherSelected: boolean
  disabled: boolean
  idPrefix: string
  groupLabelledBy?: string | undefined
  groupLabel?: string | undefined
  groupDescribedBy?: string | undefined
  /** Marks a radio group required for assistive tech; a checkbox group's role does not carry it. */
  groupRequired?: boolean | undefined
  other: AskChoiceOther
  onSelect: (value: string) => void
  onToggle: (value: string) => void
  onSelectOther: () => void
  onToggleOther: () => void
  /** A pointer click or Space on a radio row, but not an arrow-key move; lets the caller commit and advance. */
  onPick?: (value: string) => void
  /** Enter on the recommended row's own control; the caller picks it and moves on. */
  onAcceptRecommended?: (() => void) | undefined
  /** Offers a note on each picked listed option (`refract_ask` only); absent, rows render exactly as before. */
  notes?: AskChoiceNotes | undefined
}

/** A radio value no option can collide with, so "Other" is one more row of the same group. */
function otherSentinel(options: readonly AskChoiceOption[]): string {
  let candidate = '__other__'
  while (options.some((option) => option.value === candidate)) candidate = `_${candidate}`
  return candidate
}

function OtherInput({ other, disabled }: { other: AskChoiceOther; disabled: boolean }) {
  const ref = React.useRef<HTMLInputElement>(null)
  const wasVisible = React.useRef(other.visible)
  React.useEffect(() => {
    if (other.visible && !wasVisible.current && other.focusOnShow) ref.current?.focus()
    wasVisible.current = other.visible
  }, [other.visible, other.focusOnShow])
  return (
    <Input
      ref={ref}
      value={other.text}
      readOnly={disabled}
      aria-disabled={disabled}
      maxLength={OTHER_MAX_LENGTH}
      placeholder="Type your own answer"
      className="ml-10 w-[calc(100%-2.5rem)]"
      aria-label={other.ariaLabel}
      aria-invalid={other.invalid}
      data-ask-other
      onChange={(event) => other.onTextChange(event.target.value)}
      onKeyDown={other.onKeyDown}
      onBlur={other.onBlur}
    />
  )
}

/** The accessible description of a row: its detail text and, on a recommended row, the reason. */
export function describedByOf(option: AskChoiceOption, descId: string, reasonId: string): string | undefined {
  const ids = [option.description ? descId : undefined, option.recommended && option.reason ? reasonId : undefined].filter(Boolean)
  return ids.length > 0 ? ids.join(' ') : undefined
}

function OptionLabel({ option, labelId, descId, reasonId }: { option: AskChoiceOption; labelId: string; descId: string; reasonId: string }) {
  return (
    <>
      <span id={labelId} className="col-start-2 min-w-0 break-words">
        {option.label}
        {option.recommended && <RecommendedBadge reason={option.reason} />}
      </span>
      {option.recommended && option.reason && (
        <span id={reasonId} className="sr-only">
          {option.reason}
        </span>
      )}
      {option.description && (
        <span id={descId} className="col-start-2 w-full min-w-0 break-words text-xs text-muted-foreground">
          {option.description}
        </span>
      )}
    </>
  )
}

/** Row styling and the recommended row's Enter shortcut, shared by the radio and tick-box rows. Held Enter and IME composition never accept, so one held key cannot accept several questions. */
export function rowProps(option: AskChoiceOption, onAcceptRecommended: (() => void) | undefined) {
  if (!option.recommended) return { className: OPTION_ROW_CLASS }
  return {
    className: OPTION_RECOMMENDED_ROW_CLASS,
    'data-ask-recommended': '',
    [ACCEPTS_ENTER_ATTRIBUTE]: onAcceptRecommended ? '' : undefined,
    onKeyDown: onAcceptRecommended
      ? (event: Pick<React.KeyboardEvent<HTMLElement>, 'key' | 'repeat' | 'preventDefault' | 'ctrlKey' | 'metaKey' | 'altKey'> & { nativeEvent: Pick<KeyboardEvent, 'isComposing'> }) => {
          if (!isPlainEnter(event)) return
          event.preventDefault()
          onAcceptRecommended()
        }
      : undefined
  }
}

/**
 * Whether an arrow key is moving the pick. Radix clicks the row an arrow key moves focus to (from a timer, so after the old row's blur), and that
 * click must not commit the card (#1435). Focus moving between rows is the move itself, so only leaving the group, the key coming up, or a pointer or
 * non-arrow key press ends it.
 */
export function createArrowGuard() {
  let moving = false
  return {
    keyDown(key: string) {
      moving = /^(Arrow|Home$|End$)/.test(key)
    },
    keyUp() {
      moving = false
    },
    pointerDown() {
      moving = false
    },
    blur(event: { currentTarget: { contains(other: Node | null): boolean }; relatedTarget: Node | null }) {
      if (!event.currentTarget.contains(event.relatedTarget)) moving = false
    },
    isMoving: () => moving
  }
}

/** Ticked options plus a typed "Other" answer, which is what Submit sends. */
function selectedCount(selected: readonly string[], other: AskChoiceOther, otherSelected: boolean): number {
  return selected.length + (otherSelected && other.text.trim().length > 0 ? 1 : 0)
}

/** The radio or checkbox rows of one question, the "Other" row, and its free-text box; shared by every ask card. */
export function AskChoiceGroup(props: AskChoiceGroupProps) {
  const { multi, options, selected, otherSelected, disabled, idPrefix, other } = props
  const [arrowGuard] = React.useState(createArrowGuard)
  const otherValue = otherSentinel(options)
  const ids = (index: number) => ({ labelId: `${idPrefix}-opt-${index}-label`, descId: `${idPrefix}-opt-${index}-desc`, reasonId: `${idPrefix}-opt-${index}-reason` })
  const otherInput = other.visible ? <OtherInput other={other} disabled={disabled} /> : null
  const hintId = `${idPrefix}-multi-hint`
  // The wrapper marks which option a focused control belongs to, so the N key can find it (askChoiceKeys).
  const withNote = (option: AskChoiceOption, picked: boolean, row: React.ReactElement) =>
    props.notes ? (
      <div key={option.value} {...{ [ASK_OPTION_ATTRIBUTE]: '' }} className="flex flex-col gap-1">
        {row}
        <OptionNoteSlot value={option.value} label={option.label} picked={picked} disabled={disabled} notes={props.notes} />
      </div>
    ) : (
      React.cloneElement(row, { key: option.value })
    )

  if (multi) {
    return (
      <div
        role="group"
        aria-labelledby={props.groupLabelledBy}
        aria-label={props.groupLabel}
        aria-describedby={[props.groupDescribedBy, hintId].filter(Boolean).join(' ')}
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs text-muted-foreground">
          <span>
            <span id={hintId}>Select all that apply</span>
          </span>
          <span role="status" className="tabular-nums">
            {selectedCount(selected, other, otherSelected)} selected
          </span>
        </div>
        {options.map((option, index) => {
          const { labelId, descId, reasonId } = ids(index)
          const picked = selected.includes(option.value)
          return withNote(
            option,
            picked,
            <CheckboxItem
              checked={picked}
              aria-disabled={disabled}
              onCheckedChange={() => !disabled && props.onToggle(option.value)}
              aria-labelledby={labelId}
              aria-keyshortcuts={index < MAX_DIGIT_OPTIONS ? String(index + 1) : undefined}
              aria-describedby={describedByOf(option, descId, reasonId)}
              {...rowProps(option, props.onAcceptRecommended)}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, CHECKBOX_BOX_CLASS, CHECKED_MARK_CLASS)}>
                <CheckboxIndicator />
              </span>
              <OptionLabel option={option} labelId={labelId} descId={descId} reasonId={reasonId} />
            </CheckboxItem>
          )
        })}
        <CheckboxItem checked={otherSelected} aria-disabled={disabled} onCheckedChange={() => !disabled && props.onToggleOther()} aria-label="Other" className={OPTION_ROW_CLASS}>
          <span aria-hidden className={cn(OPTION_MARK_CLASS, CHECKBOX_BOX_CLASS, CHECKED_MARK_CLASS)}>
            <CheckboxIndicator />
          </span>
          <span className="col-start-2 min-w-0 break-words">Other</span>
        </CheckboxItem>
        {otherInput}
      </div>
    )
  }

  return (
    <>
      <RadioGroup
        aria-labelledby={props.groupLabelledBy}
        aria-label={props.groupLabel}
        aria-describedby={props.groupDescribedBy}
        aria-required={props.groupRequired}
        className="gap-2"
        onKeyDownCapture={(event) => arrowGuard.keyDown(event.key)}
        onKeyUpCapture={arrowGuard.keyUp}
        onBlurCapture={arrowGuard.blur}
        onPointerDownCapture={arrowGuard.pointerDown}
        value={otherSelected ? otherValue : (selected[0] ?? '')}
        onValueChange={(value) => {
          if (disabled) return
          if (value === otherValue) props.onSelectOther()
          else props.onSelect(value)
        }}
      >
        {options.map((option, index) => {
          const { labelId, descId, reasonId } = ids(index)
          return withNote(
            option,
            selected[0] === option.value && !otherSelected,
            <RadioGroupItem
              value={option.value}
              aria-disabled={disabled}
              aria-labelledby={labelId}
              aria-keyshortcuts={index < MAX_DIGIT_OPTIONS ? String(index + 1) : undefined}
              aria-describedby={describedByOf(option, descId, reasonId)}
              // A double-click's second click would otherwise pick the same slot in the next question.
              onClick={(event) => props.onPick && !arrowGuard.isMoving() && event.detail < 2 && props.onPick(option.value)}
              {...rowProps(option, props.onAcceptRecommended)}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, RADIO_RING_CLASS)}>
                <RadioGroupIndicator />
              </span>
              <OptionLabel option={option} labelId={labelId} descId={descId} reasonId={reasonId} />
            </RadioGroupItem>
          )
        })}
        <RadioGroupItem value={otherValue} aria-disabled={disabled} aria-label="Other" className={OPTION_ROW_CLASS}>
          <span aria-hidden className={cn(OPTION_MARK_CLASS, RADIO_RING_CLASS)}>
            <RadioGroupIndicator />
          </span>
          <span className="col-start-2 min-w-0 break-words">Other</span>
        </RadioGroupItem>
      </RadioGroup>
      {otherInput}
    </>
  )
}
