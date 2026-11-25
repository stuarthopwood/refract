import * as React from 'react'
import { choiceDigitIndex, focusChoiceRow } from '@/components/askChoiceKeys'
import { AskChoiceGroup } from '@/components/AskChoiceGroup'
import { InlineStatus } from '@/components/InlineStatus'
import { CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NumberField } from '@/components/ui/NumberField'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import type { AskFieldValue } from './answerPlan'
import type { AskFormChoiceField, AskFormInputField, AskFormSelectField, AskFormTextField } from './parseAskHtml'

type ChoiceValue = Extract<AskFieldValue, { kind: 'choice' }>

function FieldHeading({ id, question, required }: { id: string; question: string; required: boolean }) {
  return (
    <p id={id} className="whitespace-pre-line break-words text-sm font-medium">
      {question}
      {required && <span className="font-normal text-muted-foreground">, required</span>}
    </p>
  )
}

function FieldError({ id, error }: { id: string; error: string | null | undefined }) {
  return error ? (
    <InlineStatus tone="error" density="compact" id={id} className="p-0 text-sm break-words">
      {error}
    </InlineStatus>
  ) : null
}

/** A number field takes a minus sign only when its range can go below zero. */
export function allowsNegative(min: number | undefined): boolean {
  return min === undefined || min < 0
}

/** Props the text-like controls share: the label, the requirement and the error are tied to the control, not just drawn beside it. */
function controlA11y(idPrefix: string, required: boolean, error: string | null | undefined) {
  return {
    'aria-labelledby': `${idPrefix}-heading`,
    'aria-required': required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${idPrefix}-error` : undefined
  } as const
}

interface ChoiceFieldProps {
  field: AskFormChoiceField | AskFormSelectField
  value: ChoiceValue
  disabled: boolean
  idPrefix: string
  /** Whether an empty Other box reads as invalid: only after a blocked Submit or leaving the box. */
  showInvalid: boolean
  /** Whether the free-text "Other" row shows; a whole v19 form offers it only where OMP does. Defaults to true. */
  offerOther?: boolean
  error?: string | null
  onChange: (value: ChoiceValue) => void
  /** Focus left the whole field, not just a row inside it. */
  onBlur?: () => void
  onOtherBlur: () => void
}

/** The container takes programmatic focus when every control in the field is disabled; it is never a Tab stop. */
const FIELD_FOCUS_CLASS = 'space-y-2 outline-none'

export function ChoiceField({ field, value, disabled, idPrefix, showInvalid, offerOther, error, onChange, onBlur, onOtherBlur }: ChoiceFieldProps) {
  const headingId = `${idPrefix}-heading`
  const errorId = `${idPrefix}-error`
  const toggle = (optionValue: string) => {
    const selected = value.selected.includes(optionValue) ? value.selected.filter((entry) => entry !== optionValue) : [...value.selected, optionValue]
    onChange({ ...value, selected })
  }
  const select = (optionValue: string) => onChange({ ...value, selected: [optionValue], otherSelected: false })
  const multi = field.kind === 'checkbox' || (field.kind === 'select' && field.multiple)

  // Digits address this field's options by position, only while focus is inside the field and not in a text box.
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const index = choiceDigitIndex(event, field.options.length)
    const option = index === null ? undefined : field.options[index]
    if (index === null || !option || option.disabled) return
    event.preventDefault()
    if (multi) toggle(option.value)
    else select(option.value)
    focusChoiceRow(event.currentTarget, index)
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <CardContent
      data-ask-field={idPrefix}
      tabIndex={-1}
      className={FIELD_FOCUS_CLASS}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.()
      }}
    >
      <FieldHeading id={headingId} question={field.question} required={field.required} />
      <AskChoiceGroup
        multi={multi}
        options={field.options}
        selected={value.selected}
        otherSelected={value.otherSelected}
        disabled={disabled}
        idPrefix={idPrefix}
        groupLabelledBy={headingId}
        groupRequired={field.required}
        groupInvalid={error ? true : undefined}
        groupDescribedBy={error ? errorId : undefined}
        offerOther={offerOther}
        other={{
          visible: value.otherSelected,
          text: value.otherText,
          ariaLabel: `Other answer for ${field.question}`,
          invalid: showInvalid && value.otherText.trim().length === 0,
          focusOnShow: true,
          onTextChange: (otherText) => onChange({ ...value, otherText }),
          onBlur: onOtherBlur
        }}
        onSelect={select}
        onToggle={toggle}
        onSelectOther={() => onChange({ ...value, selected: [], otherSelected: true })}
        onToggleOther={() => onChange({ ...value, otherSelected: !value.otherSelected })}
      />
      <FieldError id={errorId} error={error} />
    </CardContent>
  )
}

interface TextFieldProps {
  field: AskFormTextField
  value: string
  disabled: boolean
  idPrefix: string
  error?: string | null
  onChange: (text: string) => void
  onBlur?: () => void
}

export function TextField({ field, value, disabled, idPrefix, error, onChange, onBlur }: TextFieldProps) {
  const shared = {
    value,
    readOnly: disabled,
    'aria-disabled': disabled,
    ...controlA11y(idPrefix, field.required, error),
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(event.target.value)
  }
  return (
    <CardContent data-ask-field={idPrefix} tabIndex={-1} className={FIELD_FOCUS_CLASS}>
      <FieldHeading id={`${idPrefix}-heading`} question={field.question} required={field.required} />
      {field.kind === 'textarea' ? <Textarea {...shared} /> : <Input {...shared} />}
      <FieldError id={`${idPrefix}-error`} error={error} />
    </CardContent>
  )
}

interface DropdownFieldProps {
  field: AskFormSelectField
  value: ChoiceValue
  disabled: boolean
  idPrefix: string
  error?: string | null
  onChange: (value: ChoiceValue) => void
  onBlur?: () => void
}

/** A single-choice `<select>`. Items are keyed by position because the dropdown cannot hold an empty option value. */
export function DropdownField({ field, value, disabled, idPrefix, error, onChange, onBlur }: DropdownFieldProps) {
  const picked = field.options.findIndex((option) => value.selected.includes(option.value))
  const [open, setOpen] = React.useState(false)
  const headingId = `${idPrefix}-heading`
  const triggerId = `${idPrefix}-trigger`
  return (
    <CardContent data-ask-field={idPrefix} tabIndex={-1} className={FIELD_FOCUS_CLASS}>
      <FieldHeading id={headingId} question={field.question} required={field.required} />
      {/* While sending the trigger stays focusable (aria-disabled, not disabled) but cannot open or change. */}
      <Select
        value={picked === -1 ? '' : String(picked)}
        open={open && !disabled}
        onOpenChange={(next) => setOpen(next && !disabled)}
        onValueChange={(next) => {
          const option = field.options[Number(next)]
          if (option && !disabled) onChange({ ...value, selected: [option.value] })
        }}
      >
        <SelectTrigger
          id={triggerId}
          {...controlA11y(idPrefix, field.required, error)}
          // Focus moves into the list while it is open, which is not the user leaving the field.
          onBlur={() => !open && onBlur?.()}
          aria-labelledby={`${headingId} ${triggerId}`}
          aria-disabled={disabled}
          className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent dark:aria-disabled:hover:bg-transparent"
        >
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option, index) => (
            <SelectItem key={index} value={String(index)} disabled={option.disabled === true}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id={`${idPrefix}-error`} error={error} />
    </CardContent>
  )
}

interface InputFieldProps {
  field: AskFormInputField
  value: string
  disabled: boolean
  idPrefix: string
  error?: string | null
  onChange: (text: string) => void
  onBlur: () => void
}

/** A number, range, email or url control. The value stays text; `toFormData` turns number and range into numbers. */
export function InputField({ field, value, disabled, idPrefix, error, onChange, onBlur }: InputFieldProps) {
  const a11y = controlA11y(idPrefix, field.required, error)
  const text = {
    value,
    readOnly: disabled,
    'aria-disabled': disabled,
    ...a11y,
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)
  }
  const min = field.min ?? 0
  const max = field.max ?? 100
  const asNumber = Number(value)
  let control: React.ReactNode
  if (field.kind === 'number') {
    control = (
      // A column wrapper stretches the field's inline-flex root to the card width.
      <div className="flex flex-col">
        <NumberField {...text} min={field.min} max={field.max} step={field.step} allowNegative={allowsNegative(field.min)} />
      </div>
    )
  } else if (field.kind === 'range') {
    control = (
      <div className="flex items-center gap-2">
        <Slider
          value={Number.isFinite(asNumber) ? asNumber : min}
          min={min}
          max={max}
          step={field.step ?? 1}
          disabled={disabled}
          aria-labelledby={a11y['aria-labelledby']}
          aria-describedby={a11y['aria-describedby']}
          onValueChange={(next) => onChange(String(next))}
          onBlur={onBlur}
        />
        <output aria-hidden="true" className="min-w-8 text-right text-sm tabular-nums">
          {value}
        </output>
      </div>
    )
  } else {
    control = <Input {...text} type={field.kind} autoComplete="off" />
  }
  return (
    <CardContent data-ask-field={idPrefix} tabIndex={-1} className={FIELD_FOCUS_CLASS}>
      <FieldHeading id={`${idPrefix}-heading`} question={field.question} required={field.required} />
      {control}
      <FieldError id={`${idPrefix}-error`} error={error} />
    </CardContent>
  )
}
