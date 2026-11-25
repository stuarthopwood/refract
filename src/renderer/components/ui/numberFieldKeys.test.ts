import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NumberField } from './NumberField'
import { blocksNumberKey } from './numberFieldKeys'

const press = (key: string, extra: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  ctrlKey: extra.ctrlKey ?? false,
  metaKey: extra.metaKey ?? false,
  altKey: extra.altKey ?? false
})

describe('blocksNumberKey', () => {
  it.each(['e', 'E', '+', '-'])('Given the default field, When %s is typed, Then it is blocked', (key) => {
    expect(blocksNumberKey(press(key), false)).toBe(true)
  })

  it('Given allowNegative, When - is typed, Then it passes', () => {
    expect(blocksNumberKey(press('-'), true)).toBe(false)
  })

  it.each(['e', 'E', '+'])('Given allowNegative, When %s is typed, Then it is still blocked', (key) => {
    expect(blocksNumberKey(press(key), true)).toBe(true)
  })

  it('Given digits and editing keys, When typed, Then they pass', () => {
    expect(blocksNumberKey(press('7'), false)).toBe(false)
    expect(blocksNumberKey(press('Backspace'), false)).toBe(false)
  })

  it('Given a modifier chord such as Ctrl+E, When typed, Then it passes', () => {
    expect(blocksNumberKey(press('e', { ctrlKey: true }), false)).toBe(false)
    expect(blocksNumberKey(press('-', { metaKey: true }), false)).toBe(false)
  })
})

describe('NumberField allowNegative', () => {
  it('Given allowNegative, When rendered, Then the prop is not forwarded to the input as an attribute', () => {
    const html = renderToStaticMarkup(createElement(NumberField, { allowNegative: true, value: '-3', onChange: () => undefined }))
    expect(html).toContain('type="number"')
    expect(html.toLowerCase()).not.toContain('allownegative')
  })
})
