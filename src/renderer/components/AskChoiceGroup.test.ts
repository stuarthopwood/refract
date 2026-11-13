// The repo has no jsdom: the group is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AskChoiceGroup, type AskChoiceOption } from './AskChoiceGroup'
import { OPTION_RECOMMENDED_ROW_CLASS } from '@/components/ui/checkbox'

const OPTIONS: AskChoiceOption[] = [
  { value: 'Alpha', label: 'Alpha' },
  { value: 'Beta', label: 'Beta', recommended: true }
]

function render(multi: boolean, options: AskChoiceOption[] = OPTIONS) {
  return renderToStaticMarkup(
    createElement(AskChoiceGroup, {
      multi,
      options,
      selected: [],
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

describe.each([
  ['single choice', false],
  ['multiple choice', true]
])('recommended option, %s (#1985)', (_name, multi) => {
  it('shows a visible, non-colour "Recommended" cue plus the screen-reader suffix', () => {
    const html = render(multi)
    expect(html).toContain('data-recommended-badge')
    expect(html).toMatch(/aria-hidden="true"[^>]*data-recommended-badge[^>]*>.*Recommended/)
    expect(html).toContain('<span class="sr-only">, Recommended</span>')
    expect(html).toMatch(/data-recommended-badge[^>]*>/)
    expect(html).toContain('text-severity-success')
  })

  it('tints only the recommended row with the success token, and marks it for focus and Enter', () => {
    const html = render(multi)
    expect(html.match(/data-ask-recommended/g)).toHaveLength(1)
    expect(html.match(/bg-severity-success-bg/g)?.length).toBeGreaterThan(0)
    expect(OPTION_RECOMMENDED_ROW_CLASS).toContain('bg-severity-success-bg')
  })

  it('renders no cue or marker when nothing is recommended', () => {
    const html = render(multi, [{ value: 'Alpha', label: 'Alpha' }])
    expect(html).not.toContain('data-recommended-badge')
    expect(html).not.toContain('data-ask-recommended')
    expect(html).not.toContain('bg-severity-success-bg')
  })
})
