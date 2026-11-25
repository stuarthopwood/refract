// The repo has no jsdom: the group is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AskChoiceGroup, createArrowGuard, describedByOf, rowProps, type AskChoiceOption } from './AskChoiceGroup'

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
const HOVER_MIX = 'bg-severity-success-hover-bg'

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

describe.each([
  ['single choice', false],
  ['multiple choice', true]
])('recommendation reason, %s (#1985 rest)', (_name, multi) => {
  const REASONED: AskChoiceOption[] = [
    { value: 'Alpha', label: 'Alpha' },
    { value: 'Beta', label: 'Beta', recommended: true, reason: 'Fastest to ship, and it keeps the API stable' }
  ]

  it('shows the full reason after the Recommended cue, muted and hidden from the row name', () => {
    const html = render(multi, REASONED)
    expect(html).toMatch(/data-recommended-badge[^>]*>.*Recommended<\/span><span aria-hidden="true" data-recommended-reason[^>]*>· Fastest to ship, and it keeps the API stable<\/span>/)
    expect(html).toMatch(/data-recommended-reason[^>]*class="[^"]*text-muted-foreground/)
  })

  it('reads the reason as the recommended row description', () => {
    const html = render(multi, REASONED)
    expect(html).toContain('aria-describedby="p-opt-1-reason"')
    expect(html).toContain('<span id="p-opt-1-reason" class="sr-only">Fastest to ship, and it keeps the API stable</span>')
  })

  it('shows no reason text on a row that is not recommended', () => {
    const html = render(multi, [{ value: 'Alpha', label: 'Alpha', reason: 'Stray' }])
    expect(html).not.toContain('Stray')
    expect(html).not.toContain('data-recommended-reason')
  })

  it('tints and marks every recommended row, not only the first', () => {
    const html = render(multi, [
      { value: 'A', label: 'A', recommended: true, reason: 'Cheap' },
      { value: 'B', label: 'B', recommended: true, reason: 'Quick' },
      { value: 'C', label: 'C' }
    ])
    expect(html.match(/data-ask-recommended/g)).toHaveLength(2)
    expect(html.match(/data-recommended-reason/g)).toHaveLength(2)
  })
})

describe('describedByOf', () => {
  it('joins the description and the recommended reason, and returns nothing when there is neither', () => {
    expect(describedByOf({ value: 'A', label: 'A', description: 'd', recommended: true, reason: 'r' }, 'd1', 'r1')).toBe('d1 r1')
    expect(describedByOf({ value: 'A', label: 'A', description: 'd' }, 'd1', 'r1')).toBe('d1')
    expect(describedByOf({ value: 'A', label: 'A', recommended: true, reason: 'r' }, 'd1', 'r1')).toBe('r1')
    expect(describedByOf({ value: 'A', label: 'A', reason: 'r' }, 'd1', 'r1')).toBeUndefined()
  })
})

describe('rowProps Enter shortcut (#1985)', () => {
  const RECOMMENDED: AskChoiceOption = { value: 'Beta', label: 'Beta', recommended: true }
  function press(key: string, extra: { repeat?: boolean; isComposing?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
    const accept = vi.fn()
    const preventDefault = vi.fn()
    rowProps(RECOMMENDED, accept).onKeyDown?.({
      key,
      repeat: extra.repeat ?? false,
      ctrlKey: extra.ctrlKey ?? false,
      altKey: extra.altKey ?? false,
      metaKey: extra.metaKey ?? false,
      preventDefault,
      nativeEvent: { isComposing: extra.isComposing ?? false }
    })
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
    ['Ctrl+Enter', 'Enter', { ctrlKey: true }],
    ['Alt+Enter', 'Enter', { altKey: true }],
    ['Meta+Enter', 'Enter', { metaKey: true }],
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

describe('arrow guard (#1435, #1985)', () => {
  const row = { id: 'row' } as unknown as Node
  const outside = { id: 'outside' } as unknown as Node
  const group = { contains: (other: Node | null) => other === row }
  const moveFocusWithinGroup = { currentTarget: group, relatedTarget: row }
  const leaveGroup = { currentTarget: group, relatedTarget: outside }

  it('starts not moving', () => {
    expect(createArrowGuard().isMoving()).toBe(false)
  })

  // Radix moves focus from a timer and then clicks the new row: the old row's blur lands between the key press and that click.
  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])('still ignores the click after %s once focus has moved to another row', (key) => {
    const guard = createArrowGuard()
    guard.keyDown(key)
    guard.blur(moveFocusWithinGroup)
    expect(guard.isMoving()).toBe(true)
  })

  it('stops ignoring clicks once the arrow key comes up', () => {
    const guard = createArrowGuard()
    guard.keyDown('ArrowUp')
    guard.blur(moveFocusWithinGroup)
    guard.keyUp()
    expect(guard.isMoving()).toBe(false)
  })

  it.each([
    ['Space', ' '],
    ['Enter', 'Enter'],
    ['a letter', 'a']
  ])('lets %s commit after an arrow key', (_name, key) => {
    const guard = createArrowGuard()
    guard.keyDown('ArrowDown')
    guard.keyDown(key)
    expect(guard.isMoving()).toBe(false)
  })

  it('lets a pointer press commit after an arrow key', () => {
    const guard = createArrowGuard()
    guard.keyDown('ArrowDown')
    guard.pointerDown()
    expect(guard.isMoving()).toBe(false)
  })

  it.each([
    ['to somewhere outside it', leaveGroup],
    ['to nowhere', { currentTarget: group, relatedTarget: null }]
  ])('forgets the arrow key when focus leaves the group %s, so its keyup landing elsewhere cannot leave it stuck', (_name, event) => {
    const guard = createArrowGuard()
    guard.keyDown('ArrowDown')
    guard.blur(event)
    expect(guard.isMoving()).toBe(false)
  })
})

describe('option notes slot (#1987)', () => {
  const notes = { texts: { Alpha: 'why' }, editing: null, onEdit: () => undefined, onSave: () => undefined, onCancel: () => undefined, onRemove: () => undefined }
  function renderWithNotes(multi: boolean, selected: string[]) {
    return renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(AskChoiceGroup, {
          multi,
          options: OPTIONS,
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
          notes
        })
      )
    )
  }

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('shows a picked option\'s note and, on an unpicked option, only a hover-revealed Note button, %s', (_name, multi) => {
    const html = renderWithNotes(multi, ['Alpha'])
    expect(html.match(/data-ask-option/g)).toHaveLength(2)
    expect(html).toContain('Note:')
    expect(html).toContain('aria-label="Add a note to Beta"')
    expect(html).toContain('group/option')
  })

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('hides the note of an unpicked option but offers its Note button, %s', (_name, multi) => {
    const html = renderWithNotes(multi, ['Beta'])
    expect(html).not.toContain('Note:')
    expect(html).toContain('Add a note to Beta')
  })

  it('renders no note markers without the notes prop', () => {
    expect(render(false, OPTIONS, ['Alpha'])).not.toContain('data-ask-option')
  })
})

describe('disabled option, group state and Other row', () => {
  const base = {
    options: [
      { value: 'Alpha', label: 'Alpha', disabled: true },
      { value: 'Beta', label: 'Beta' }
    ] satisfies AskChoiceOption[],
    selected: [],
    otherSelected: false,
    disabled: false,
    idPrefix: 'p',
    groupLabel: 'Pick',
    other: { visible: true, text: '', ariaLabel: 'Other answer', onTextChange: () => undefined },
    onSelect: () => undefined,
    onToggle: () => undefined,
    onSelectOther: () => undefined,
    onToggleOther: () => undefined
  }
  const html = (multi: boolean, extra: Partial<Parameters<typeof AskChoiceGroup>[0]> = {}) => renderToStaticMarkup(createElement(AskChoiceGroup, { ...base, multi, ...extra }))
  const rowTag = (markup: string, label: string) => {
    const tag = markup.match(new RegExp(`<button[^>]*aria-labelledby="p-opt-${label}-label"[^>]*>`))?.[0]
    if (!tag) throw new Error('row not rendered')
    return tag
  }

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('marks only the disabled option aria-disabled so it dims and drops hover, %s', (_name, multi) => {
    const markup = html(multi)
    expect(rowTag(markup, '0')).toContain('aria-disabled="true"')
    expect(rowTag(markup, '1')).not.toContain('aria-disabled="true"')
  })

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('marks every option aria-disabled while the whole group is busy, %s', (_name, multi) => {
    const markup = html(multi, { disabled: true })
    expect(rowTag(markup, '0')).toContain('aria-disabled="true"')
    expect(rowTag(markup, '1')).toContain('aria-disabled="true"')
  })

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('renders no Other row or input when offerOther is false, %s', (_name, multi) => {
    const markup = html(multi, { offerOther: false })
    expect(markup).not.toContain('data-ask-other')
    expect(markup).not.toContain('aria-label="Other"')
    expect(html(multi)).toContain('data-ask-other')
  })

  it.each([
    ['single choice', false],
    ['multiple choice', true]
  ])('puts required, invalid and the described-by id on the group, %s', (_name, multi) => {
    const markup = html(multi, { groupRequired: true, groupInvalid: true, groupDescribedBy: 'p-error' })
    const group = markup.match(/<div[^>]*role="(?:radiogroup|group)"[^>]*>/)?.[0] ?? ''
    expect(group).toContain('aria-required="true"')
    expect(group).toContain('aria-invalid="true"')
    expect(group).toContain('p-error')
  })
})
