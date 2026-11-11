import { closestAncestor, containsControl, descendantElements, parseHtmlTree, textContent, type HtmlElement, type HtmlNode } from './htmlTree'

export interface AskFormOption {
  readonly value: string
  readonly label: string
}

interface AskFormFieldBase {
  readonly name: string
  readonly question: string
  /** The HTML marks the field `required`; Submit stays disabled until it is answered. */
  readonly required: boolean
}

export interface AskFormChoiceField extends AskFormFieldBase {
  readonly kind: 'radio' | 'checkbox'
  readonly options: readonly AskFormOption[]
  /** Option values that start selected; at most one for a radio group. */
  readonly defaultValue: readonly string[]
}

export interface AskFormTextField extends AskFormFieldBase {
  readonly kind: 'text' | 'textarea'
  readonly defaultValue: string
}

export type AskFormField = AskFormChoiceField | AskFormTextField

const MAX_HTML_LENGTH = 200_000
const IGNORED_INPUT_TYPES: Record<string, true> = { hidden: true, submit: true, button: true, reset: true, image: true }
const INLINE_LABEL_TAGS: Record<string, true> = { span: true, b: true, strong: true, i: true, em: true, small: true, code: true, u: true, mark: true }

interface ChoiceDraft {
  kind: 'radio' | 'checkbox'
  name: string
  rawName: string
  first: HtmlElement
  options: AskFormOption[]
  defaults: string[]
  required: boolean
}

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function inputType(el: HtmlElement): string {
  return clean(el.attrs.get('type') ?? 'text').toLowerCase()
}

/** Nearest text before `start` at its own level, without walking out of the form or fieldset. */
function precedingText(start: HtmlNode): string {
  for (let cur: HtmlNode | null = start; cur?.parent; cur = cur.parent) {
    const siblings: HtmlNode[] = cur.parent.children
    for (let k = siblings.indexOf(cur) - 1; k >= 0; k--) {
      const sib = siblings[k]
      if (!sib) continue
      if (containsControl(sib)) return ''
      const text = textContent(sib)
      if (text) return text
    }
    if (cur.parent.tag === 'fieldset' || cur.parent.tag === 'form') return ''
  }
  return ''
}

function trailingText(el: HtmlElement): string {
  const siblings = el.parent?.children ?? []
  const parts: string[] = []
  for (let k = siblings.indexOf(el) + 1; k < siblings.length; k++) {
    const sib = siblings[k]
    if (!sib) continue
    if (sib.type === 'element' && (!INLINE_LABEL_TAGS[sib.tag] || containsControl(sib))) break
    parts.push(sib.type === 'text' ? sib.text : textContent(sib))
  }
  return clean(parts.join(' '))
}

function controlLabel(el: HtmlElement, forLabels: ReadonlyMap<string, HtmlElement>): string {
  const wrapping = closestAncestor(el, 'label')
  const id = el.attrs.get('id')
  const forLabel = id ? forLabels.get(id) : undefined
  return (wrapping && textContent(wrapping)) || (forLabel && textContent(forLabel)) || clean(el.attrs.get('aria-label')) || ''
}

function legendOf(fieldset: HtmlElement): string {
  for (const el of descendantElements(fieldset)) if (el.tag === 'legend') return textContent(el)
  return ''
}

function fieldsetHoldsOnlyGroup(fieldset: HtmlElement, draft: ChoiceDraft): boolean {
  for (const el of descendantElements(fieldset)) {
    if (el.tag === 'textarea' || el.tag === 'select') return false
    if (el.tag !== 'input' || IGNORED_INPUT_TYPES[inputType(el)]) continue
    if (inputType(el) !== draft.kind || (el.attrs.get('name') ?? '') !== draft.rawName) return false
  }
  return true
}

function groupQuestion(draft: ChoiceDraft): string {
  const fieldset = closestAncestor(draft.first, 'fieldset')
  const legend = fieldset ? legendOf(fieldset) : ''
  if (fieldset && legend && fieldsetHoldsOnlyGroup(fieldset, draft)) return legend
  return precedingText(closestAncestor(draft.first, 'label') ?? draft.first) || legend
}

function addOption(draft: ChoiceDraft, el: HtmlElement, forLabels: ReadonlyMap<string, HtmlElement>): void {
  const label = controlLabel(el, forLabels) || trailingText(el)
  const value = el.attrs.get('value') || label
  if (!value) return
  if (draft.options.some((option) => option.value === value)) return
  draft.options.push({ value, label: label || value })
  if (!el.attrs.has('checked')) return
  if (draft.kind === 'radio') draft.defaults = [value]
  else draft.defaults.push(value)
}

/**
 * Reads the agent's `ask` HTML into allow-listed fields. The markup is tokenised into plain
 * objects and never rendered. `null` means nothing usable or a field type the combined card
 * does not support, so the caller shows today's per-field cards.
 */
export function parseAskHtml(html: unknown): AskFormField[] | null {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_HTML_LENGTH) return null
  const root = parseHtmlTree(html)
  const forLabels = new Map<string, HtmlElement>()
  for (const el of descendantElements(root)) {
    const target = el.attrs.get('for')
    if (el.tag === 'label' && target && !forLabels.has(target)) forLabels.set(target, el)
  }

  const slots: (AskFormTextField | ChoiceDraft)[] = []
  const groups = new Map<string, ChoiceDraft>()
  for (const el of descendantElements(root)) {
    if (el.tag === 'select') return null
    const isTextarea = el.tag === 'textarea'
    if (!isTextarea && el.tag !== 'input') continue
    const type = isTextarea ? 'textarea' : inputType(el)
    if (IGNORED_INPUT_TYPES[type]) continue
    const rawName = clean(el.attrs.get('name'))
    const required = el.attrs.has('required')

    if (type === 'radio' || type === 'checkbox') {
      const key = rawName ? `${type}:${rawName}` : `${type}:#${slots.length}`
      let draft = groups.get(key)
      if (!draft) {
        draft = { kind: type, name: rawName || `field-${slots.length + 1}`, rawName, first: el, options: [], defaults: [], required: false }
        groups.set(key, draft)
        slots.push(draft)
      }
      draft.required ||= required
      addOption(draft, el, forLabels)
      continue
    }
    if (type !== 'text' && type !== 'textarea') return null

    const name = rawName || `field-${slots.length + 1}`
    const question = controlLabel(el, forLabels) || precedingText(el) || clean(el.attrs.get('placeholder')) || name
    const defaultValue = isTextarea ? el.children.map((child) => (child.type === 'text' ? child.text : '')).join('') : (el.attrs.get('value') ?? '')
    slots.push({ kind: type, name, question, required, defaultValue })
  }

  const fields: AskFormField[] = []
  for (const slot of slots) {
    if (!('options' in slot)) fields.push(slot)
    else if (slot.options.length > 0) {
      fields.push({ kind: slot.kind, name: slot.name, question: groupQuestion(slot) || slot.name, required: slot.required, options: slot.options, defaultValue: slot.defaults })
    }
  }
  return fields.length > 0 ? fields : null
}
