import { describe, expect, test } from 'vitest'
import { parseAskHtml, type AskFormChoiceField, type AskFormInputField, type AskFormSelectField, type AskFormTextField } from './parseAskHtml'

const PROBE_FORM = `<form>
<fieldset><legend>Which database?</legend>
<label><input type="radio" name="db" value="Postgres" checked> Postgres</label>
<label><input type="radio" name="db" value="SQLite"> SQLite</label>
</fieldset>
<fieldset><legend>Which features?</legend>
<label><input type="checkbox" name="features" value="Auth"> Auth</label>
<label><input type="checkbox" name="features" value="Billing" checked> Billing</label>
</fieldset>
</form>`

describe('parseAskHtml', () => {
  test('Given the OMP 18.18.3 probe form, When parsed, Then a radio group and a checkbox group keep question, options and defaults', () => {
    expect(parseAskHtml(PROBE_FORM)).toEqual([
      {
        kind: 'radio',
        name: 'db',
        question: 'Which database?',
        required: false,
        options: [
          { value: 'Postgres', label: 'Postgres' },
          { value: 'SQLite', label: 'SQLite' },
        ],
        defaultValue: ['Postgres'],
      },
      {
        kind: 'checkbox',
        name: 'features',
        question: 'Which features?',
        required: false,
        options: [
          { value: 'Auth', label: 'Auth' },
          { value: 'Billing', label: 'Billing' },
        ],
        defaultValue: ['Billing'],
      },
    ])
  })

  test('Given text and textarea fields, When parsed, Then each becomes a text field with its label and default', () => {
    const fields = parseAskHtml(`<label for="n">Your name</label><input id="n" type="text" name="who" value="Ada">
      <label>Notes <textarea name="notes">
line one
line two</textarea></label>
      <input name="plain" placeholder="Nickname">`)
    expect(fields).toEqual([
      { kind: 'text', name: 'who', question: 'Your name', required: false, defaultValue: 'Ada' },
      { kind: 'textarea', name: 'notes', question: 'Notes', required: false, defaultValue: 'line one\nline two' },
      { kind: 'text', name: 'plain', question: 'Nickname', required: false, defaultValue: '' },
    ])
  })

  test('Given a text field under a legend, When parsed, Then the legend is its question', () => {
    const [field] = parseAskHtml('<fieldset><legend>Project name</legend><input type="text" name="p"></fieldset>') ?? []
    expect(field?.question).toBe('Project name')
  })

  test('Given a group with no fieldset, When parsed, Then the text before it is the question and trailing text labels each option', () => {
    const [field] = parseAskHtml('<div><p>Pick a colour</p><input type="radio" name="c" value="r"> Red<br><input type="radio" name="c" value="b"> <b>Blue</b></div>') ?? []
    expect(field).toMatchObject({ question: 'Pick a colour', options: [{ value: 'r', label: 'Red' }, { value: 'b', label: 'Blue' }] })
  })

  test('Given one outer fieldset holding two groups, When parsed, Then each group takes its own preceding heading, not the shared legend', () => {
    const fields = parseAskHtml(`<fieldset><legend>Questions</legend>
      <h3>First?</h3><label><input type="radio" name="a" value="1">One</label>
      <h3>Second?</h3><label><input type="checkbox" name="b" value="2">Two</label></fieldset>`)
    expect(fields?.map((f) => f.question)).toEqual(['First?', 'Second?'])
  })

  test('Given the required attribute on any member, When parsed, Then the field is required', () => {
    const fields = parseAskHtml(`<fieldset><legend>Pick</legend><input type="radio" name="p" value="a">A<input type="radio" name="p" value="b" required>B</fieldset>
      <label>Why <input type="text" name="why" required></label><label>Opt <input type="text" name="opt"></label>`)
    expect(fields?.map((f) => f.required)).toEqual([true, true, false])
  })

  test('Given the document order, When fields interleave, Then fields keep the order the agent asks for them', () => {
    const fields = parseAskHtml('<input name="t" aria-label="T"><input type="radio" name="r" value="x">X<input name="u" aria-label="U">')
    expect(fields?.map((f) => f.name)).toEqual(['t', 'r', 'u'])
  })

  test('Given entities, comments, a doctype and unknown markup, When parsed, Then entities decode and the unknown markup is ignored', () => {
    const fields = parseAskHtml(`<!DOCTYPE html><!-- hi --><main data-x="1"><h1>Intro</h1><custom-tag>
      <fieldset><legend>Fish &amp; chips&#63; &#x41;</legend><label><input type="radio" name="f" value="a&lt;b"> A &lt; B</label></fieldset></custom-tag></main>`)
    expect(fields).toEqual([
      { kind: 'radio', name: 'f', question: 'Fish & chips? A', required: false, options: [{ value: 'a<b', label: 'A < B' }], defaultValue: [] },
    ])
  })

  test('Given script, style, hidden and button elements, When parsed, Then they never become fields or leak into labels', () => {
    const fields = parseAskHtml(`<style>.x{}</style><script>alert(1)</script><input type="hidden" name="h" value="1">
      <label>Name <script>evil()</script><input name="n"></label><button type="submit">Send</button><input type="submit" value="Go">`)
    expect(fields).toEqual([{ kind: 'text', name: 'n', question: 'Name', required: false, defaultValue: '' }])
  })

  test('Given markup that is only HTML, never DOM, When parsed, Then attributes such as onclick and inline handlers are not retained anywhere', () => {
    const fields = parseAskHtml('<label>Q <input name="q" onfocus="steal()" style="x"></label><img src=x onerror=alert(1)>')
    expect(JSON.stringify(fields)).not.toMatch(/steal|onerror|alert/)
  })

  test.each([
    ['date', '<label>When <input type="date" name="d"></label>'],
    ['password', '<label>Secret <input type="password" name="p"></label>'],
    ['file', '<label>Doc <input type="file" name="f"></label>'],
    ['a select with no options', '<input name="ok" aria-label="Ok"><select name="s"></select>'],
  ])('Given an unsupported %s field, When parsed, Then the whole form is rejected', (_label, html) => {
    expect(parseAskHtml(html)).toBeNull()
  })

  test('Given a single select with no option marked, When parsed, Then the first enabled option is the default', () => {
    const html = '<label>Pick <select name="s"><option value="x" disabled>X</option><option value="a">A</option><option value="b">B</option></select></label>'
    expect(parseAskHtml(html)).toEqual([
      {
        kind: 'select',
        name: 's',
        question: 'Pick',
        required: false,
        multiple: false,
        options: [
          { value: 'x', label: 'X', disabled: true },
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        defaultValue: ['a'],
      },
    ])
  })

  test('Given a single select with an option marked selected, When parsed, Then that option is the default and an option without a value uses its text', () => {
    const [field] = parseAskHtml('<label>Pick <select name="s" required><option>One</option><option selected>Two</option></select></label>') as [AskFormSelectField]
    expect(field.required).toBe(true)
    expect(field.options.map((option) => option.value)).toEqual(['One', 'Two'])
    expect(field.defaultValue).toEqual(['Two'])
  })

  test('Given a multiple select, When parsed, Then every selected option is a default and none is forced', () => {
    const multi = '<label>Pick <select name="s" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select></label>'
    expect((parseAskHtml(multi) as [AskFormSelectField])[0]).toMatchObject({ multiple: true, defaultValue: ['a', 'c'] })
    const none = '<label>Pick <select name="s" multiple><option value="a">A</option><option value="b">B</option></select></label>'
    expect((parseAskHtml(none) as [AskFormSelectField])[0].defaultValue).toEqual([])
  })

  test('Given a number input with limits and a default, When parsed, Then min, max, step and the default are carried', () => {
    const [field] = parseAskHtml('<label>Age <input type="number" name="a" min="1" max="9.5" step="0.5" value="3" required></label>') as [AskFormInputField]
    expect(field).toEqual({ kind: 'number', name: 'a', question: 'Age', required: true, defaultValue: '3', min: 1, max: 9.5, step: 0.5 })
  })

  test('Given a range input, When parsed, Then it is a range field with its limits and default', () => {
    const [field] = parseAskHtml('<label>Level <input type="range" name="l" min="0" max="10" value="4"></label>') as [AskFormInputField]
    expect(field).toMatchObject({ kind: 'range', min: 0, max: 10, defaultValue: '4' })
  })

  test('Given email and url inputs with length and pattern rules, When parsed, Then each rule is carried', () => {
    const html = '<label>Mail <input type="email" name="m" minlength="3" maxlength="40" pattern=".+@x\\.com" value="a@x.com"></label><label>Site <input type="url" name="u"></label>'
    const [email, url] = parseAskHtml(html) as [AskFormInputField, AskFormInputField]
    expect(email).toMatchObject({ kind: 'email', minLength: 3, maxLength: 40, pattern: '.+@x\\.com', defaultValue: 'a@x.com' })
    expect(url.kind).toBe('url')
    expect(url).not.toHaveProperty('pattern')
  })

  test('Given text controls with length and pattern rules, When parsed, Then a text input carries all three and a textarea only the lengths', () => {
    const html = '<label>T <input name="t" minlength="2" maxlength="5" pattern="[a-z]+"></label><label>N <textarea name="n" maxlength="9" pattern="x"></textarea></label>'
    const [text, area] = parseAskHtml(html) as [AskFormTextField, AskFormTextField]
    expect(text).toMatchObject({ minLength: 2, maxLength: 5, pattern: '[a-z]+' })
    expect(area).toMatchObject({ kind: 'textarea', maxLength: 9 })
    expect(area).not.toHaveProperty('pattern')
  })

  test('Given a numeric attribute that is blank or not a number, When parsed, Then the limit is left off', () => {
    const [field] = parseAskHtml('<label>Age <input type="number" name="a" min="" max="abc"></label>') as [AskFormInputField]
    expect(field).not.toHaveProperty('min')
    expect(field).not.toHaveProperty('max')
  })

  test('Given a disabled radio option and an unnamed control, When parsed, Then the option is flagged and the field is marked unnamed', () => {
    const [group, loose] = parseAskHtml('<fieldset><legend>Pick</legend><label><input type="radio" name="p" value="a"> A</label><label><input type="radio" name="p" value="b" disabled> B</label></fieldset><label>Free <input></label>') as [AskFormChoiceField, AskFormTextField]
    expect(group.options[1]).toEqual({ value: 'b', label: 'B', disabled: true })
    expect(loose.unnamed).toBe(true)
    expect(group).not.toHaveProperty('unnamed')
  })

  test.each([
    ['not a string', undefined],
    ['empty', ''],
    ['text only', 'just some prose'],
    ['no controls', '<form><p>nothing to answer</p></form>'],
    ['oversized', `<input name="a" aria-label="A">${' '.repeat(200_001)}`],
  ])('Given %s, When parsed, Then there is no form', (_label, html) => {
    expect(parseAskHtml(html)).toBeNull()
  })

  test('Given a group whose options have no usable label or value, When parsed, Then the empty group is dropped', () => {
    expect(parseAskHtml('<input type="radio" name="e"><input name="t" aria-label="T">')?.map((f) => f.name)).toEqual(['t'])
  })

  test('Given duplicate option values and unnamed inputs, When parsed, Then duplicates collapse and unnamed fields get stable names', () => {
    const fields = parseAskHtml('<fieldset><legend>Q</legend><input type="checkbox" name="c" value="a">A<input type="checkbox" name="c" value="a">A again</fieldset><input aria-label="Free">')
    expect((fields?.[0] as AskFormChoiceField).options).toHaveLength(1)
    expect((fields?.[1] as AskFormTextField).name).toBe('field-2')
  })

  test('Given deeply nested and unterminated markup, When parsed, Then it still returns a result without throwing', () => {
    const deep = `${'<div>'.repeat(5000)}<input name="d" aria-label="Deep"><input name="x" aria-label="Open`
    expect(parseAskHtml(deep)?.[0]?.name).toBe('d')
  })

  const manyFields = (count: number) => Array.from({ length: count }, (_, i) => `<input name="f${i}" aria-label="F${i}">`).join('')
  const manyOptions = (count: number) => `<fieldset><legend>Pick</legend>${Array.from({ length: count }, (_, i) => `<label><input type="radio" name="p" value="v${i}"> V${i}</label>`).join('')}</fieldset>`

  test('Given exactly the field cap and one past it, When parsed, Then the cap is accepted and one more falls back to per-field cards', () => {
    expect(parseAskHtml(manyFields(100))).toHaveLength(100)
    expect(parseAskHtml(manyFields(101))).toBeNull()
  })

  test('Given exactly the option cap and one past it, When parsed, Then the cap is accepted and one more falls back to per-field cards', () => {
    expect((parseAskHtml(manyOptions(200))?.[0] as AskFormChoiceField).options).toHaveLength(200)
    expect(parseAskHtml(manyOptions(201))).toBeNull()
  })

  test('Given a legend holding a Markdown table, When parsed, Then the table keeps its rows on separate lines', () => {
    const [field] = parseAskHtml(`<fieldset><legend>Pick one:
  | Name | Size |
  |------|------|
  | A    |  1   |
</legend><input type="radio" name="t" value="a">A</fieldset>`) ?? []
    expect(field?.question).toBe('Pick one:\n| Name | Size |\n|------|------|\n| A | 1 |')
  })

  test('Given a preceding paragraph holding a Markdown list and a fenced block, When parsed, Then lines, nesting, blank lines and the code survive verbatim', () => {
    const [field] = parseAskHtml('<p>Which?\n\n- one\n  - two\n\n```ts\nconst a   =\t1\n```</p><input type="radio" name="l" value="x">X') ?? []
    expect(field?.question).toBe('Which?\n\n- one\n  - two\n\n```ts\nconst a   =\t1\n```')
  })

  test('Given a label wrapped across source lines, When parsed, Then the soft break reads as one space', () => {
    const [field] = parseAskHtml('<label>Choose a\n      colour <input name="c"></label>') ?? []
    expect(field?.question).toBe('Choose a colour')
  })

  test('Given a Python fence indented by the HTML source, When parsed, Then only the source indent goes and the code keeps its own', () => {
    const [field] = parseAskHtml(`<fieldset><legend>
    Run this?

    \`\`\`python
    def f(x):
        return x  +  1
    \`\`\`
  </legend><input type="radio" name="p" value="a">A</fieldset>`) ?? []
    expect(field?.question).toBe('Run this?\n\n```python\ndef f(x):\n    return x  +  1\n```')
  })

  test('Given a nested list with a wrapped item, When parsed, Then nesting stays and the wrapped prose joins its item', () => {
    const [field] = parseAskHtml(`<legend>Pick:
  - one
    - nested
  - two that
    wraps
  1) third
</legend><input type="radio" name="n" value="a">A`) ?? []
    expect(field?.question).toBe('Pick:\n- one\n  - nested\n- two that wraps\n1) third')
  })

  test('Given a heading followed by prose, When parsed, Then the heading keeps its own line', () => {
    const [field] = parseAskHtml('<legend>Intro\n# Title\nbody text\nmore</legend><input type="radio" name="h" value="a">A') ?? []
    expect(field?.question).toBe('Intro\n# Title\nbody text more')
  })

  test('Given plain single-line question text with stray spaces, When parsed, Then it is unchanged apart from collapsed spaces', () => {
    const [field] = parseAskHtml('<fieldset><legend>  Which   database?  </legend><input type="radio" name="p" value="a">A</fieldset>') ?? []
    expect(field?.question).toBe('Which database?')
  })

  test('Given the same html twice, When parsed, Then the second read reuses the first result', () => {
    expect(parseAskHtml(PROBE_FORM)).toBe(parseAskHtml(PROBE_FORM))
  })

  test('Given more distinct forms than the cache holds, When the oldest is read again, Then it is parsed afresh but equal', () => {
    const first = parseAskHtml('<input name="lru0" aria-label="L0">')
    for (let i = 1; i <= 16; i++) parseAskHtml(`<input name="lru${i}" aria-label="L${i}">`)
    const again = parseAskHtml('<input name="lru0" aria-label="L0">')
    expect(again).toEqual(first)
    expect(again).not.toBe(first)
  })
})
