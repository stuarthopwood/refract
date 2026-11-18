// The repo has no jsdom, so the radios render to a string (see `GhStackNotice.test.ts`).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '../../../shared/model'
import { RoleReasoningRadios } from './RoleReasoningRadios'
import type { RoleReasoningRadiosProps } from './RoleReasoningRadios'

const ENTRY: ModelCatalogEntry = { provider: 'anthropic', id: 'opus', selector: 'anthropic/opus', name: 'Opus', reasoning: true, thinking: ['low', 'medium', 'high'] }

function render(overrides: Partial<RoleReasoningRadiosProps>): string {
  return renderToStaticMarkup(
    createElement(RoleReasoningRadios, {
      role: 'default',
      roleLabel: 'Default',
      labelId: 'model-role-default-label',
      currentValue: 'anthropic/opus:low',
      catalogEntry: ENTRY,
      catalogStatus: 'loaded',
      disabled: false,
      saveState: 'idle',
      onPick: () => {},
      announcePolite: () => {},
      ...overrides
    })
  )
}

/** The opening tag of the element with this id, so one radio's attributes are not read off another's. */
function openingTag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? ''
}

/** The text (icons stripped) of each save-status region, in document order. */
function statusTexts(html: string): string[] {
  return [...html.matchAll(/<div role="status"[^>]*>(.*?)<\/div>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ''))
}

describe('RoleReasoningRadios save state (#2002)', () => {
  it('marks the group busy and says Saving… while the role saves', () => {
    const html = render({ disabled: true, saveState: 'saving' })
    expect(html).toMatch(/role="radiogroup"[^>]*aria-busy="true"|aria-busy="true"[^>]*role="radiogroup"/)
    expect(statusTexts(html)).toEqual(['Saving…'])
  })

  it('is not busy and keeps an empty status region when idle', () => {
    const html = render({ disabled: false, saveState: 'idle' })
    expect(html).not.toContain('aria-busy')
    expect(statusTexts(html)).toEqual([''])
  })

  it('says Saved once the write lands', () => {
    expect(statusTexts(render({ saveState: 'saved' }))).toEqual(['Saved'])
  })

  // Native `disabled` on the focused radio would drop focus mid-save (#1114), so saving must not set it.
  it('does not natively disable the supported radios while saving, so keyboard focus survives', () => {
    const html = render({ disabled: true, saveState: 'saving' })
    expect(openingTag(html, 'model-role-default-reasoning-inherit')).not.toMatch(/\bdisabled(=|\s|>)/)
    expect(openingTag(html, 'model-role-default-reasoning-low')).not.toMatch(/\bdisabled(=|\s|>)/)
  })

  it('still natively disables a level the model does not support', () => {
    expect(openingTag(render({}), 'model-role-default-reasoning-xhigh')).toMatch(/\bdisabled(=|\s|>)/)
  })
})
