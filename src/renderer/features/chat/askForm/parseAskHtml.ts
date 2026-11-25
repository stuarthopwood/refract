import { closestAncestor, containsControl, descendantElements, parseHtmlTree, textContent, type HtmlElement, type HtmlNode } from './htmlTree'

export interface AskFormOption {
  readonly value: string
  readonly label: string
  /** Disabled options are shown but never submitted, as OMP leaves them out of the form data. */
  readonly disabled?: true
}

interface AskFormFieldBase {
  readonly name: string
  /** The control had no `name`; the generated name is for the UI only and never goes into the submitted data. */
  readonly unnamed?: true
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

/** A `<select>`: a dropdown, or a list when `multiple`. A single select always starts with an enabled option chosen. */
export interface AskFormSelectField extends AskFormFieldBase {
  readonly kind: 'select'
  readonly multiple: boolean
  readonly options: readonly AskFormOption[]
  readonly defaultValue: readonly string[]
}

export interface AskFormTextField extends AskFormFieldBase {
  readonly kind: 'text' | 'textarea'
  readonly defaultValue: string
  readonly minLength?: number
  readonly maxLength?: number
  /** Not read from a textarea, which HTML gives no `pattern`. */
  readonly pattern?: string
}

/** An `<input>` with a typed shape: number and range are also range-limited, email and url shape-checked. */
export interface AskFormInputField extends AskFormFieldBase {
  readonly kind: 'number' | 'range' | 'email' | 'url'
  readonly defaultValue: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
}

export type AskFormField = AskFormChoiceField | AskFormSelectField | AskFormTextField | AskFormInputField

/** The field kinds OMP 18.x's per-field frames can carry; select and the typed inputs exist only in a v19 whole form. */
export type AskFormFrameField = AskFormChoiceField | AskFormTextField

const MAX_HTML_LENGTH = 200_000
const IGNORED_INPUT_TYPES: Record<string, true> = { hidden: true, submit: true, button: true, reset: true, image: true }
const TYPED_INPUT_TYPES: Record<string, true> = { number: true, range: true, email: true, url: true }
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
  draft.options.push({ value, label: label || value, ...(el.attrs.has('disabled') && { disabled: true as const }) })
  if (!el.attrs.has('checked')) return
  if (draft.kind === 'radio') draft.defaults = [value]
  else draft.defaults.push(value)
}

function numberAttr(el: HtmlElement, name: string): number | undefined {
  const raw = el.attrs.get(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function lengthRules(el: HtmlElement): { minLength?: number; maxLength?: number } {
  const minLength = numberAttr(el, 'minlength')
  const maxLength = numberAttr(el, 'maxlength')
  return { ...(minLength !== undefined && { minLength }), ...(maxLength !== undefined && { maxLength }) }
}

function rangeRules(el: HtmlElement): { min?: number; max?: number; step?: number } {
  const min = numberAttr(el, 'min')
  const max = numberAttr(el, 'max')
  const step = numberAttr(el, 'step')
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...(step !== undefined && { step }) }
}

function patternRule(el: HtmlElement): { pattern?: string } {
  const pattern = el.attrs.get('pattern')
  return pattern ? { pattern } : {}
}

/**
 * Reads a `<select>`. A single select always starts with a choice, the first enabled option unless
 * one is marked, as OMP does. `null` when it has no options or more than the card caps.
 */
function readSelect(el: HtmlElement, base: Pick<AskFormSelectField, 'name' | 'unnamed' | 'question' | 'required'>): AskFormSelectField | null {
  const multiple = el.attrs.has('multiple')
  const options: AskFormOption[] = []
  let defaults: string[] = []
  for (const option of descendantElements(el)) {
    if (option.tag !== 'option') continue
    // Own text only: an unclosed `<option>` nests the next one in the tree.
    const text = clean(option.children.map((child) => (child.type === 'text' ? child.text : '')).join(''))
    const value = option.attrs.get('value') ?? text
    if (options.some((existing) => existing.value === value)) continue
    options.push({ value, label: text || value, ...(option.attrs.has('disabled') && { disabled: true as const }) })
    if (option.attrs.has('selected')) defaults.push(value)
  }
  if (options.length === 0 || options.length > MAX_OPTIONS) return null
  if (!multiple) {
    defaults = defaults.slice(0, 1)
    const first = options.find((option) => !option.disabled)
    if (defaults.length === 0 && first) defaults = [first.value]
  }
  return { kind: 'select', ...base, multiple, options, defaultValue: defaults }
}

/** Past these the form is no longer a card a person can fill, so the caller shows per-field cards. */
const MAX_FIELDS = 100
const MAX_OPTIONS = 200
const CACHE_SIZE = 16

// Both transcript rows and the live card read the same `html`; the parse is the costly part.
const parseCache = new Map<string, AskFormField[] | null>()

/**
 * Reads the agent's `ask` HTML into allow-listed fields. The markup is tokenised into plain
 * objects and never rendered. `null` means nothing usable, a field type the combined card
 * does not support, or more fields or options than the card caps, so the caller shows today's
 * per-field cards. Results are memoised on the string in a small LRU.
 */
export function parseAskHtml(html: unknown): AskFormField[] | null {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_HTML_LENGTH) return null
  if (parseCache.has(html)) {
    const hit = parseCache.get(html) ?? null
    parseCache.delete(html)
    parseCache.set(html, hit)
    return hit
  }
  const parsed = parseUncached(html)
  parseCache.set(html, parsed)
  if (parseCache.size > CACHE_SIZE) {
    const oldest = parseCache.keys().next()
    if (!oldest.done) parseCache.delete(oldest.value)
  }
  return parsed
}

function parseUncached(html: string): AskFormField[] | null {
  const root = parseHtmlTree(html)
  const forLabels = new Map<string, HtmlElement>()
  for (const el of descendantElements(root)) {
    const target = el.attrs.get('for')
    if (el.tag === 'label' && target && !forLabels.has(target)) forLabels.set(target, el)
  }

  const slots: (AskFormField | ChoiceDraft)[] = []
  const groups = new Map<string, ChoiceDraft>()
  for (const el of descendantElements(root)) {
    const isTextarea = el.tag === 'textarea'
    const isSelect = el.tag === 'select'
    if (!isTextarea && !isSelect && el.tag !== 'input') continue
    const type = isTextarea ? 'textarea' : isSelect ? 'select' : inputType(el)
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
        if (slots.length > MAX_FIELDS) return null
      }
      draft.required ||= required
      addOption(draft, el, forLabels)
      if (draft.options.length > MAX_OPTIONS) return null
      continue
    }
    if (!isSelect && !isTextarea && !TYPED_INPUT_TYPES[type] && type !== 'text') return null

    const name = rawName || `field-${slots.length + 1}`
    const question = controlLabel(el, forLabels) || precedingText(el) || clean(el.attrs.get('placeholder')) || name
    const base = { name, ...(rawName ? {} : { unnamed: true as const }), question, required }
    if (isSelect) {
      const select = readSelect(el, base)
      if (!select) return null
      slots.push(select)
    } else if (isTextarea) {
      const defaultValue = el.children.map((child) => (child.type === 'text' ? child.text : '')).join('')
      slots.push({ kind: 'textarea', ...base, defaultValue, ...lengthRules(el) })
    } else if (type === 'text') {
      slots.push({ kind: 'text', ...base, defaultValue: el.attrs.get('value') ?? '', ...lengthRules(el), ...patternRule(el) })
    } else {
      slots.push({ kind: type as AskFormInputField['kind'], ...base, defaultValue: el.attrs.get('value') ?? '', ...rangeRules(el), ...lengthRules(el), ...patternRule(el) })
    }
    if (slots.length > MAX_FIELDS) return null
  }

  const fields: AskFormField[] = []
  for (const slot of slots) {
    if (!('first' in slot)) fields.push(slot)
    else if (slot.options.length > 0) {
      fields.push({
        kind: slot.kind,
        name: slot.name,
        ...(slot.rawName ? {} : { unnamed: true as const }),
        question: groupQuestion(slot) || slot.name,
        required: slot.required,
        options: slot.options,
        defaultValue: slot.defaults,
      })
    }
  }
  return fields.length > 0 ? fields : null
}
