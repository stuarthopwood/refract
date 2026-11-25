// A control that cannot take focus is skipped so a blocked Submit never lands on a dead control.
const FOCUSABLE = ':is(input, textarea, button, [role="radio"], [role="checkbox"], [role="slider"]):not(:disabled):not([aria-disabled="true"]):not([data-disabled])'

export interface FieldSelectors {
  readonly control: string
  readonly container: string
  /** A ticked Other box left empty: that box is what the error is about, so it is where focus goes. */
  readonly invalidOther: string
}

/** `fieldId` is the field's `data-ask-field` value. */
export function fieldSelectors(fieldId: string): FieldSelectors {
  const container = `[data-ask-field="${fieldId}"]`
  return { control: `${container} ${FOCUSABLE}`, container, invalidOther: `${container} input[data-ask-other][aria-invalid="true"]:not(:disabled):not([aria-disabled="true"])` }
}

/** Focuses the invalid Other box, else the field's first usable control, else the field itself. Returns what took focus. */
export function focusField(root: Pick<ParentNode, 'querySelector'> | null, fieldId: string): HTMLElement | null {
  if (!root) return null
  const { control, container, invalidOther } = fieldSelectors(fieldId)
  const target = root.querySelector<HTMLElement>(invalidOther) ?? root.querySelector<HTMLElement>(control) ?? root.querySelector<HTMLElement>(container)
  target?.focus()
  return target
}
