// The repo has no jsdom: each field is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AskFieldValue } from './answerPlan'
import { allowsNegative, ChoiceField, DropdownField, InputField, TextField } from './AskFormFields'
import type { AskFormChoiceField, AskFormInputField, AskFormSelectField, AskFormTextField } from './parseAskHtml'

// The real Markdown renderer is under test (#2033); the state barrel it imports needs a browser `window`, so it is stubbed.
vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))

const noop = () => undefined
const EMPTY_CHOICE: Extract<AskFieldValue, { kind: 'choice' }> = { kind: 'choice', selected: [], otherSelected: false, otherText: '' }

const RADIO: AskFormChoiceField = {
  kind: 'radio',
  name: 'r',
  question: 'Pick one',
  required: true,
  defaultValue: [],
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' }
  ]
}
const SELECT: AskFormSelectField = { ...RADIO, kind: 'select', multiple: false, question: 'Pick a size' }

function choice(field: AskFormChoiceField, error: string | null, disabled = false) {
  return renderToStaticMarkup(
    createElement(ChoiceField, { field, value: EMPTY_CHOICE, disabled, idPrefix: 'f0', showInvalid: false, error, onChange: noop, onOtherBlur: noop })
  )
}

function dropdown(error: string | null, disabled = false) {
  return renderToStaticMarkup(createElement(DropdownField, { field: SELECT, value: EMPTY_CHOICE, disabled, idPrefix: 'f1', error, onChange: noop }))
}

function input(field: Partial<AskFormInputField> & Pick<AskFormInputField, 'kind'>, error: string | null = null) {
  const full: AskFormInputField = { name: 'n', question: 'How many', required: false, defaultValue: '5', ...field }
  return renderToStaticMarkup(createElement(InputField, { field: full, value: full.defaultValue, disabled: false, idPrefix: 'f2', error, onChange: noop, onBlur: noop }))
}

const TEXT: AskFormTextField = { kind: 'text', name: 't', question: 'Why', required: false, defaultValue: '' }

describe('field error presentation', () => {
  it.each([
    ['choice', () => choice(RADIO, 'Pick an option')],
    ['dropdown', () => dropdown('Pick an option')],
    ['text', () => renderToStaticMarkup(createElement(TextField, { field: TEXT, value: '', disabled: false, idPrefix: 'f3', error: 'Pick an option', onChange: noop }))],
    ['number', () => input({ kind: 'number' }, 'Pick an option')]
  ])('announces the %s error in an alert that wraps long text', (_name, render) => {
    const html = render()
    const alert = html.match(/<p[^>]*role="alert"[^>]*>/)?.[0] ?? ''
    expect(alert).toMatch(/id="f\d-error"/)
    expect(alert).toMatch(/class="[^"]*(?<![:\w-])break-words/)
    expect(html).toContain('Pick an option')
  })

  it('renders no error markup without an error', () => {
    expect(choice(RADIO, null)).not.toContain('role="alert"')
  })

  it('lets a long question wrap', () => {
    expect(choice(RADIO, null)).toMatch(/id="f0-heading"[^>]*class="[^"]*break-words/)
  })

  it('renders a GFM table in the question as a table with header cells, and keeps the ", required" cue and heading id (#2033)', () => {
    const question = 'Which plan?\n\n| Plan | Cost |\n| --- | --- |\n| Fast | high |'
    const html = choice({ ...RADIO, question }, null)
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).not.toContain('| --- |')
    expect(html).toMatch(/id="f0-heading"/)
    expect(html).toContain(', required')
  })

  it('renders bold and links in the question as Markdown (#2033)', () => {
    const field = createElement(TextField, { field: { ...TEXT, question: 'Why **now**? See [docs](https://example.com)' }, value: '', disabled: false, idPrefix: 'f3', onChange: noop })
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, field))
    expect(html).toContain('<strong>now</strong>')
    expect(html).toContain('href="https://example.com/"')
  })

  it('renders a malformed table in the question as text, not a table (#2033)', () => {
    const html = choice({ ...RADIO, question: '| A | B |\n| 1 | 2 |' }, null)
    expect(html).not.toContain('<table')
    expect(html).toContain('| 1 | 2 |')
  })

  it('ties the error to a single-choice group and marks it invalid and required', () => {
    const html = choice(RADIO, 'Pick an option')
    const group = html.match(/<div[^>]*role="radiogroup"[^>]*>/)?.[0] ?? ''
    expect(group).toContain('aria-invalid="true"')
    expect(group).toContain('aria-describedby="f0-error"')
    expect(group).toContain('aria-required="true"')
  })

  it('ties the error to a tick-box group and marks it required, even with no error', () => {
    const checkbox: AskFormChoiceField = { ...RADIO, kind: 'checkbox' }
    const group = choice(checkbox, 'Pick an option').match(/<div[^>]*role="group"[^>]*>/)?.[0] ?? ''
    expect(group).toContain('aria-invalid="true"')
    expect(group).toContain('f0-error')
    expect(group).toContain('aria-required="true"')
    expect(choice(checkbox, null).match(/<div[^>]*role="group"[^>]*>/)?.[0]).not.toContain('aria-invalid')
  })
})

describe('dropdown field', () => {
  const trigger = (html: string) => html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0] ?? ''

  it('fills the card width and is named by its question and its own value', () => {
    const tag = trigger(dropdown(null))
    expect(tag).toMatch(/class="[^"]*(?<![:\w-])w-full/)
    expect(tag).not.toMatch(/class="[^"]*(?<![:\w-])w-fit/)
    expect(tag).toContain('id="f1-trigger"')
    expect(tag).toContain('aria-labelledby="f1-heading f1-trigger"')
  })

  it('stays focusable but reads as disabled while sending', () => {
    const tag = trigger(dropdown(null, true))
    expect(tag).toContain('aria-disabled="true"')
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('is neither aria-disabled nor really disabled when idle', () => {
    const tag = trigger(dropdown(null))
    expect(tag).not.toContain('aria-disabled="true"')
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/)
  })
})

describe('number and range fields', () => {
  it('stretches the number field to the card width', () => {
    expect(input({ kind: 'number' })).toContain('<div class="flex flex-col"><div data-slot="number-field-root"')
  })

  it.each([
    ['no minimum', undefined, true],
    ['a negative minimum', -5, true],
    ['a zero minimum', 0, false],
    ['a positive minimum', 1, false]
  ])('allows a minus sign for %s: %s', (_name, min, expected) => {
    expect(allowsNegative(min)).toBe(expected)
  })

  it('hides the range readout from assistive tech, as the slider already speaks its value', () => {
    const html = input({ kind: 'range', min: 0, max: 10 })
    expect(html).toMatch(/<output[^>]*aria-hidden="true"[^>]*>5<\/output>/)
  })

  it('spaces the slider and its readout on the 8px grid', () => {
    const html = input({ kind: 'range', min: 0, max: 10 })
    expect(html).toContain('flex items-center gap-2')
    expect(html).not.toContain('gap-3')
  })
})
