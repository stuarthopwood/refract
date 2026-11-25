// A control that cannot take focus is skipped so a blocked Submit never lands on a dead control.
const FOCUSABLE = ':is(input, textarea, button, [role="radio"], [role="checkbox"], [role="slider"]):not(:disabled):not([aria-disabled="true"]):not([data-disabled])'

export interface FieldSelectors {
  readonly control: string
  readonly container: string
}

/** `fieldId` is the field's `data-ask-field` value. */
export function fieldSelectors(fieldId: string): FieldSelectors {
  const container = `[data-ask-field="${fieldId}"]`
  return { control: `${container} ${FOCUSABLE}`, container }
}

/** Focuses the field's first usable control, or the field itself when every control is disabled. Returns what took focus. */
export function focusField(root: Pick<ParentNode, 'querySelector'> | null, fieldId: string): HTMLElement | null {
  if (!root) return null
  const { control, container } = fieldSelectors(fieldId)
  const target = root.querySelector<HTMLElement>(control) ?? root.querySelector<HTMLElement>(container)
  target?.focus()
  return target
}
