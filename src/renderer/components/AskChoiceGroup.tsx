import * as React from 'react'
import { RecommendedBadge } from '@/components/RecommendedBadge'
import { CHECKBOX_BOX_CLASS, CheckboxIndicator, CheckboxItem, OPTION_MARK_CLASS, OPTION_RECOMMENDED_ROW_CLASS, OPTION_ROW_CLASS } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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

function OptionLabel({ option, labelId, descId }: { option: AskChoiceOption; labelId: string; descId: string }) {
  return (
    <>
      <span id={labelId} className="col-start-2 min-w-0 break-words">
        {option.label}
        {option.recommended && <RecommendedBadge />}
      </span>
      {option.description && (
        <span id={descId} className="col-start-2 w-full min-w-0 break-words text-xs text-muted-foreground">
          {option.description}
        </span>
      )}
    </>
  )
}

/** Row styling and the recommended row's Enter shortcut, shared by the radio and tick-box rows. */
function rowProps(option: AskChoiceOption, onAcceptRecommended: (() => void) | undefined) {
  if (!option.recommended) return { className: OPTION_ROW_CLASS }
  return {
    className: OPTION_RECOMMENDED_ROW_CLASS,
    'data-ask-recommended': '',
    onKeyDown: onAcceptRecommended
      ? (event: React.KeyboardEvent<HTMLElement>) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.repeat) return
          event.preventDefault()
          onAcceptRecommended()
        }
      : undefined
  }
}

/** The radio or checkbox rows of one question, the "Other" row, and its free-text box; shared by every ask card. */
export function AskChoiceGroup(props: AskChoiceGroupProps) {
  const { multi, options, selected, otherSelected, disabled, idPrefix, other } = props
  const arrowKey = React.useRef(false)
  const otherValue = otherSentinel(options)
  const ids = (index: number) => ({ labelId: `${idPrefix}-opt-${index}-label`, descId: `${idPrefix}-opt-${index}-desc` })
  const otherInput = other.visible ? <OtherInput other={other} disabled={disabled} /> : null

  if (multi) {
    return (
      <div role="group" aria-labelledby={props.groupLabelledBy} aria-label={props.groupLabel} aria-describedby={props.groupDescribedBy} className="flex flex-col gap-2">
        {options.map((option, index) => {
          const { labelId, descId } = ids(index)
          return (
            <CheckboxItem
              key={option.value}
              checked={selected.includes(option.value)}
              aria-disabled={disabled}
              onCheckedChange={() => !disabled && props.onToggle(option.value)}
              aria-labelledby={labelId}
              aria-describedby={option.description ? descId : undefined}
              {...rowProps(option, props.onAcceptRecommended)}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, CHECKBOX_BOX_CLASS, CHECKED_MARK_CLASS)}>
                <CheckboxIndicator />
              </span>
              <OptionLabel option={option} labelId={labelId} descId={descId} />
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
        onKeyDownCapture={(event) => {
          arrowKey.current = /^(Arrow|Home$|End$)/.test(event.key)
        }}
        onKeyUpCapture={() => {
          arrowKey.current = false
        }}
        onBlurCapture={() => {
          arrowKey.current = false
        }}
        onPointerDownCapture={() => {
          arrowKey.current = false
        }}
        value={otherSelected ? otherValue : (selected[0] ?? '')}
        onValueChange={(value) => {
          if (disabled) return
          if (value === otherValue) props.onSelectOther()
          else props.onSelect(value)
        }}
      >
        {options.map((option, index) => {
          const { labelId, descId } = ids(index)
          return (
            <RadioGroupItem
              key={option.value}
              value={option.value}
              aria-disabled={disabled}
              aria-labelledby={labelId}
              aria-describedby={option.description ? descId : undefined}
              // A double-click's second click would otherwise pick the same slot in the next question.
              onClick={(event) => props.onPick && !arrowKey.current && event.detail < 2 && props.onPick(option.value)}
              {...rowProps(option, props.onAcceptRecommended)}
            >
              <span aria-hidden className={cn(OPTION_MARK_CLASS, RADIO_RING_CLASS)}>
                <RadioGroupIndicator />
              </span>
              <OptionLabel option={option} labelId={labelId} descId={descId} />
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
