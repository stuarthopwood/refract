// The repo has no jsdom: the group is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AskChoiceGroup, rowProps, type AskChoiceOption } from './AskChoiceGroup'

const OPTIONS: AskChoiceOption[] = [
  { value: 'Alpha', label: 'Alpha' },
  { value: 'Beta', label: 'Beta', recommended: true }
]

function render(multi: boolean, options: AskChoiceOption[] = OPTIONS, selected: string[] = []) {
  return renderToStaticMarkup(
    createElement(AskChoiceGroup, {
      multi,
      options,
      selected,
      otherSelected: false,
      disabled: false,
      idPrefix: 'p',
      groupLabel: 'Pick',
      other: { visible: false, text: '', ariaLabel: 'Other answer', onTextChange: () => undefined },
      onSelect: () => undefined,
      onToggle: () => undefined,
      onSelectOther: () => undefined,
      onToggleOther: () => undefined,
      onAcceptRecommended: () => undefined
    })
  )
}

/** The opening tag of the recommended row, where Radix puts `data-state` and the merged class. */
function recommendedRowTag(html: string): string {
  const tag = html.match(/<button[^>]*data-ask-recommended[^>]*>/)?.[0]
  if (!tag) throw new Error('no recommended row rendered')
  return tag
}

/** Whole-token class set: a substring match would also hit the `dark:` and `data-[state=checked]:` variants of the same utility. */
function classTokens(tag: string): Set<string> {
  const value = tag.match(/ class="([^"]*)"/)?.[1]
  if (value === undefined) throw new Error('row has no class attribute')
  return new Set(value.split(/\s+/).filter(Boolean))
}

const TINT = 'bg-severity-success-bg'
const HOVER_MIX = 'bg-[color-mix(in_oklch,var(--severity-success-bg),var(--foreground)_5%)]'

describe.each([
  ['single choice', false],
  ['multiple choice', true]
])('recommended option, %s (#1985)', (_name, multi) => {
  it('shows a visible, non-colour "Recommended" cue plus the screen-reader suffix', () => {
    const html = render(multi)
    expect(html).toMatch(/aria-hidden="true"[^>]*data-recommended-badge[^>]*>.*Recommended/)
    expect(html).toContain('<span class="sr-only">, Recommended</span>')
    expect(html).toContain('text-severity-success')
  })

  it('tints exactly one row with the success token, and marks it for focus and Enter', () => {
    const html = render(multi)
    expect(html.match(/data-ask-recommended/g)).toHaveLength(1)
    expect(html.match(/class="[^"]*(?<![:\w-])bg-severity-success-bg(?=[\s"])[^"]*"/g)).toHaveLength(1)
    const tokens = classTokens(recommendedRowTag(html))
    for (const token of [TINT, `dark:${TINT}`]) expect(tokens.has(token), token).toBe(true)
  })

  it('keeps the success tint when the recommended row is checked, instead of the base primary wash', () => {
    const tag = recommendedRowTag(render(multi, OPTIONS, ['Beta']))
    expect(tag).toContain('data-state="checked"')
    const tokens = classTokens(tag)
    for (const token of [`data-[state=checked]:${TINT}`, `dark:data-[state=checked]:${TINT}`]) expect(tokens.has(token), token).toBe(true)
    expect(tokens.has('data-[state=checked]:bg-primary/5')).toBe(false)
  })

  it('keeps the success tint on hover, with a subtle foreground mix as the cue, and none while busy', () => {
    const tokens = classTokens(recommendedRowTag(render(multi)))
    const hover = [`hover:${HOVER_MIX}`, `data-[state=checked]:hover:${HOVER_MIX}`, `dark:hover:${HOVER_MIX}`, `dark:data-[state=checked]:hover:${HOVER_MIX}`]
    for (const token of hover) expect(tokens.has(token), token).toBe(true)
    expect(tokens.has('hover:bg-muted')).toBe(false)
    const busy = [`aria-disabled:hover:${TINT}`, `dark:aria-disabled:hover:${TINT}`, `aria-disabled:data-[state=checked]:hover:${TINT}`, `dark:aria-disabled:data-[state=checked]:hover:${TINT}`]
    for (const token of busy) expect(tokens.has(token), token).toBe(true)
  })

  it('renders no cue or marker when nothing is recommended', () => {
    const html = render(multi, [{ value: 'Alpha', label: 'Alpha' }])
    expect(html).not.toContain('data-recommended-badge')
    expect(html).not.toContain('data-ask-recommended')
    expect(html).not.toContain('bg-severity-success-bg')
  })
})

describe('rowProps Enter shortcut (#1985)', () => {
  const RECOMMENDED: AskChoiceOption = { value: 'Beta', label: 'Beta', recommended: true }
  function press(key: string, extra: { repeat?: boolean; isComposing?: boolean } = {}) {
    const accept = vi.fn()
    const preventDefault = vi.fn()
    rowProps(RECOMMENDED, accept).onKeyDown?.({ key, repeat: extra.repeat ?? false, preventDefault, nativeEvent: { isComposing: extra.isComposing ?? false } })
    return { accept, preventDefault }
  }

  it('accepts and prevents the default on a plain Enter', () => {
    const { accept, preventDefault } = press('Enter')
    expect(accept).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it.each([
    ['a held Enter', 'Enter', { repeat: true }],
    ['Enter during IME composition', 'Enter', { isComposing: true }],
    ['Space', ' ', {}],
    ['ArrowDown', 'ArrowDown', {}]
  ])('does not accept on %s', (_name, key, extra) => {
    const { accept, preventDefault } = press(key, extra)
    expect(accept).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('adds no key handler without an accept callback, or to a row that is not recommended', () => {
    expect(rowProps(RECOMMENDED, undefined).onKeyDown).toBeUndefined()
    expect('onKeyDown' in rowProps({ value: 'Alpha', label: 'Alpha' }, vi.fn())).toBe(false)
  })
})
