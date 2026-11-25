import { describe, expect, test } from 'vitest'
import type { AskFieldValue } from './answerPlan'
import { initialValue } from './answerPlan'
import { parseAskHtml, type AskFormField } from './parseAskHtml'
import { toFormData, validateAskForm } from './validateAskForm'

const fieldsOf = (html: string): AskFormField[] => parseAskHtml(html) as AskFormField[]
const text = (value: string): AskFieldValue => ({ kind: 'text', text: value })
const choice = (selected: string[], otherText = '', otherSelected = otherText !== ''): AskFieldValue => ({ kind: 'choice', selected, otherSelected, otherText })
const errorOf = (html: string, value: AskFieldValue): string | null => validateAskForm(fieldsOf(html), [value])[0] ?? null

describe('validateAskForm text rules', () => {
  test.each([
    ['a blank required field', '<input name="a" aria-label="A" required>', '  ', 'Required'],
    ['a blank optional field', '<input name="a" aria-label="A">', '', null],
    ['text under minlength', '<input name="a" aria-label="A" minlength="3">', 'ab', 'Needs at least 3 characters'],
    ['text at minlength', '<input name="a" aria-label="A" minlength="3">', 'abc', null],
    ['text over maxlength', '<input name="a" aria-label="A" maxlength="3">', 'abcd', 'At most 3 characters'],
    ['text at maxlength', '<input name="a" aria-label="A" maxlength="3">', 'abc', null],
    ['text off its pattern', '<input name="a" aria-label="A" pattern="[a-z]+">', 'ab1', 'Must match [a-z]+'],
    ['a pattern matched in part only', '<input name="a" aria-label="A" pattern="[a-z]">', 'ab', 'Must match [a-z]'],
    ['text on its pattern', '<input name="a" aria-label="A" pattern="[a-z]+">', 'ab', null],
    ['an invalid pattern', '<input name="a" aria-label="A" pattern="(">', 'anything', null],
    ['a textarea under minlength', '<textarea name="a" aria-label="A" minlength="4"></textarea>', 'abc', 'Needs at least 4 characters'],
  ])('Given %s, When validated, Then the message is %s', (_label, html, value, expected) => {
    expect(errorOf(html, text(value))).toBe(expected)
  })

  test('Given a pattern longer than 40 characters, When it fails, Then the message shortens it to 39 characters and an ellipsis', () => {
    const pattern = 'a'.repeat(50)
    expect(errorOf(`<input name="a" aria-label="A" pattern="${pattern}">`, text('b'))).toBe(`Must match ${'a'.repeat(39)}…`)
  })
})

describe('validateAskForm pattern safety', () => {
  const patternOf = (pattern: string) => `<input name="a" aria-label="A" pattern="${pattern}">`

  test.each(['(a+)+$', '(a*)*', '(a|a)*', '(a|aa)+', '((a+))+', '(a+){2,}', `${'.*'.repeat(14)}x`, '.*.*x'])(
    'Given the backtracking pattern %s, When a long near-match is validated, Then it is skipped at once without an error',
    (pattern) => {
      const started = performance.now()
      expect(errorOf(patternOf(pattern), text(`${'a'.repeat(30)}!`))).toBeNull()
      expect(performance.now() - started).toBeLessThan(200)
    }
  )

  test.each(['(a)\\1', '(?<x>a)\\k<x>', '(?=a)a', '(?!b)a', '(?<=b)a', '(?<!b)a', '(ab){2}', '(ab)?'])(
    'Given the pattern %s that has a backreference, lookaround or repeated group, When it would fail, Then it is skipped',
    (pattern) => {
      expect(errorOf(patternOf(pattern), text('zz'))).toBeNull()
    }
  )

  test.each(['a+?b*', 'a{2,}b?', 'a{1,3}b*', 'a*?b+'])('Given the two-quantifier pattern %s, When it would fail, Then it is skipped', (pattern) => {
    expect(errorOf(patternOf(pattern), text('zz'))).toBeNull()
  })

  test.each([
    ['(a|a) repeated', `${'(a|a)'.repeat(24)}b`],
    ['(a|) repeated', `${'(a|)'.repeat(24)}b`]
  ])('Given the alternation pattern %s, When a long near-match is validated, Then it is skipped within the time bound', (_label, pattern) => {
    const started = performance.now()
    expect(errorOf(patternOf(pattern), text(`${'a'.repeat(24)}c`))).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })

  test('Given a top-level alternation that would fail, When validated, Then it is skipped', () => {
    expect(errorOf(patternOf('(ab|cd)e+'), text('xe'))).toBeNull()
  })
  test('Given a pattern of 201 characters, When it would fail, Then it is skipped', () => {
    expect(errorOf(patternOf('a'.repeat(201)), text('b'))).toBeNull()
  })

  test('Given a pattern of 200 characters, When it fails, Then it is enforced', () => {
    expect(errorOf(patternOf('a'.repeat(200)), text('b'))).not.toBeNull()
  })

  test('Given an input of 1,001 characters, When it would fail, Then the check is skipped', () => {
    expect(errorOf(patternOf('a+'), text('b'.repeat(1001)))).toBeNull()
  })

  test('Given an input of 1,000 characters, When it fails, Then the pattern is enforced', () => {
    expect(errorOf(patternOf('a+'), text('b'.repeat(1000)))).toBe('Must match a+')
  })

  test.each([
    ['a repeat inside a character class, on pattern', '[*+]x', '+x', null],
    ['a repeat inside a character class, off pattern', '[*+]x', 'ax', 'Must match [*+]x'],
    ['fixed counts, on pattern', '\\d{3}-\\d{4}', '123-4567', null],
    ['fixed counts, off pattern', '\\d{3}-\\d{4}', '123-456', 'Must match \\d{3}-\\d{4}'],
    ['one repeat, on pattern', '^[A-Z][a-z]*$', 'Hello', null],
    ['one repeat, off pattern', '^[A-Z][a-z]*$', 'hello', 'Must match ^[A-Z][a-z]*$'],
    ['an escaped star before one repeat, on pattern', 'a\\*b*', 'a*bb', null],
    ['an escaped star before one repeat, off pattern', 'a\\*b*', 'abb', 'Must match a\\*b*'],
    ['an escaped backslash before a digit, off pattern', '\\\\1a+', 'x', 'Must match \\\\1a+'],
    ['an escaped bar, on pattern', 'a\\|b', 'a|b', null],
    ['an escaped bar, off pattern', 'a\\|b', 'ab', 'Must match a\\|b'],
    ['an escaped bar in a character class, on pattern', '[\\|]x', '|x', null],
    ['an escaped bar in a character class, off pattern', '[\\|]x', 'ax', 'Must match [\\|]x'],
    ['an unescaped bar in a class, which the v flag rejects as invalid, on any value', '[|]x', 'ax', null]
  ])('Given %s, When validated, Then the pattern is still enforced', (_label, pattern, value, expected) => {
    expect(errorOf(patternOf(pattern), text(value))).toBe(expected)
  })
})

describe('validateAskForm typed inputs', () => {
  test.each([
    ['below min', '<input type="number" name="a" aria-label="A" min="2">', '1', 'Must be at least 2'],
    ['at min', '<input type="number" name="a" aria-label="A" min="2">', '2', null],
    ['above max', '<input type="number" name="a" aria-label="A" max="5">', '6', 'Must be at most 5'],
    ['at max', '<input type="number" name="a" aria-label="A" max="5">', '5', null],
    ['not a number', '<input type="number" name="a" aria-label="A">', 'abc', 'Enter a number'],
    ['a range below min', '<input type="range" name="a" aria-label="A" min="0" max="10">', '-1', 'Must be at least 0'],
    ['a bad email', '<input type="email" name="a" aria-label="A">', 'nope', 'Enter an email address'],
    ['an email with a space', '<input type="email" name="a" aria-label="A">', 'a b@c', 'Enter an email address'],
    ['a good email', '<input type="email" name="a" aria-label="A">', 'a@b.co', null],
    ['a bad url', '<input type="url" name="a" aria-label="A">', 'example', 'Enter a full URL'],
    ['a good url', '<input type="url" name="a" aria-label="A">', 'https://example.com', null],
    ['an empty optional url', '<input type="url" name="a" aria-label="A">', '', null],
    ['an empty required number', '<input type="number" name="a" aria-label="A" required>', '', 'Required'],
  ])('Given %s, When validated, Then the message is %s', (_label, html, value, expected) => {
    expect(errorOf(html, text(value))).toBe(expected)
  })
})

describe('validateAskForm choice rules', () => {
  const radios = '<fieldset><legend>P</legend><label><input type="radio" name="p" value="a" required> A</label><label><input type="radio" name="p" value="b"> B</label></fieldset>'
  const boxes = '<fieldset><legend>P</legend><label><input type="checkbox" name="p" value="a" required> A</label><label><input type="checkbox" name="p" value="b"> B</label></fieldset>'
  const lone = '<label><input type="checkbox" name="p" value="a" required> A</label>'

  test.each([
    ['an unanswered required radio group', radios, choice([]), 'Required'],
    ['an answered radio group', radios, choice(['a']), null],
    ['a radio group answered with Other text', radios, choice([], 'mine'), null],
    ['an Other box with blank text', radios, choice([], '  ', true), 'Required'],
    ['an unanswered required checkbox group', boxes, choice([]), 'Select at least one'],
    ['an answered checkbox group', boxes, choice(['b']), null],
    ['an unticked required lone checkbox', lone, choice([]), 'Required'],
    ['a ticked required lone checkbox', lone, choice(['a']), null],
  ])('Given %s, When validated, Then the message is %s', (_label, html, value, expected) => {
    expect(errorOf(html, value)).toBe(expected)
  })

  test('Given required selects, When unanswered, Then a multi-select asks for at least one and a single select for a value', () => {
    const single = '<select name="s" aria-label="S" required><option value="a" disabled>A</option></select>'
    const multi = '<select name="s" aria-label="S" multiple required><option value="a">A</option><option value="b">B</option></select>'
    expect(errorOf(single, choice([]))).toBe('Required')
    expect(errorOf(multi, choice([]))).toBe('Select at least one')
    expect(errorOf(multi, choice(['b']))).toBeNull()
  })

  test('Given a disabled option that is selected, When validated, Then it does not count as an answer', () => {
    const html = '<select name="s" aria-label="S" required><option value="a" disabled>A</option><option value="b">B</option></select>'
    expect(errorOf(html, choice(['a']))).toBe('Required')
  })

  test('Given several fields, When validated, Then the messages line up with the fields', () => {
    const fields = fieldsOf('<input name="a" aria-label="A" required><input name="b" aria-label="B">')
    expect(validateAskForm(fields, [text(''), text('x')])).toEqual(['Required', null])
  })
})

describe('toFormData', () => {
  const html = `
    <fieldset><legend>Radio</legend><label><input type="radio" name="r" value="a"> A</label><label><input type="radio" name="r" value="b"> B</label></fieldset>
    <fieldset><legend>Boxes</legend><label><input type="checkbox" name="c" value="x"> X</label><label><input type="checkbox" name="c" value="y"> Y</label></fieldset>
    <label>Lone <input type="checkbox" name="lone" value="yes"></label>
    <label>Drop <select name="d"><option value="p">P</option><option value="q" disabled>Q</option></select></label>
    <label>Multi <select name="m" multiple><option value="k">K</option><option value="l">L</option></select></label>
    <label>Num <input type="number" name="n"></label>
    <label>Rng <input type="range" name="g"></label>
    <label>Mail <input type="email" name="e"></label>
    <label>Note <textarea name="t"></textarea></label>
    <label>Loose <input></label>`
  const fields = fieldsOf(html)
  const base = fields.map(initialValue)
  const filled = (overrides: Record<number, AskFieldValue>): AskFieldValue[] => base.map((value, index) => overrides[index] ?? value)

  test('Given a filled form, When converted, Then every value has the type OMP expects and unnamed controls are left out', () => {
    const data = toFormData(
      fields,
      filled({ 0: choice(['b']), 1: choice(['x', 'y']), 2: choice(['yes']), 4: choice(['k', 'l']), 5: text('12.5'), 6: text('3'), 7: text('a@b.co'), 8: text('hello'), 9: text('ignored') }),
    )
    expect(data).toEqual({ r: 'b', c: ['x', 'y'], lone: 'yes', d: 'p', m: ['k', 'l'], n: 12.5, g: 3, e: 'a@b.co', t: 'hello' })
    expect(typeof data.n).toBe('number')
    expect(typeof data.g).toBe('number')
  })

  test('Given nothing chosen, When converted, Then single choices are absent, groups are empty arrays and text is an empty string', () => {
    const data = toFormData(fields, base)
    expect(data).not.toHaveProperty('r')
    expect(data).not.toHaveProperty('lone')
    expect(data).toMatchObject({ c: [], m: [], d: 'p', n: '', g: '', e: '', t: '' })
  })

  test('Given Other text on a radio and a checkbox group, When converted, Then it replaces the radio value and joins the array', () => {
    const data = toFormData(fields, filled({ 0: choice([], ' mine '), 1: choice(['x'], 'extra') }))
    expect(data.r).toBe('mine')
    expect(data.c).toEqual(['x', 'extra'])
  })

  test('Given a disabled option selected, When converted, Then it is not submitted', () => {
    expect(toFormData(fields, filled({ 3: choice(['q']) }))).not.toHaveProperty('d')
  })

  test('Given a number field holding text that is not a number, When converted, Then the text is kept for validation to refuse', () => {
    expect(toFormData(fields, filled({ 5: text('abc') })).n).toBe('abc')
  })

  test('Given a control named __proto__, When converted, Then it is an ordinary key', () => {
    const data = toFormData(fieldsOf('<input name="__proto__" aria-label="P">'), [text('v')])
    expect(Object.keys(data)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(data)).toBeNull()
  })
})
