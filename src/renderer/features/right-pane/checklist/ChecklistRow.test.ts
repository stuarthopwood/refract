// The repo has no jsdom, so rows render to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItemRefusal } from '@/state/checklist-store'
import type { ChecklistItem } from '../../../../shared/checklist'
import { ChecklistRow } from './ChecklistRow'
import { makeItem } from './checklist-fixtures'

const render = (item: ChecklistItem, extra: { pending?: boolean; refusal?: ItemRefusal } = {}): string =>
  renderToStaticMarkup(createElement('ol', null, createElement(ChecklistRow, { item, pending: extra.pending ?? false, onTick: () => {}, refusal: extra.refusal })))

const tickTag = (html: string): string => /<button[^>]*role="checkbox"[^>]*>/.exec(html)?.[0] ?? ''
const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ')

describe('ChecklistRow', () => {
  it('tick_labelled_by_item_text', () => {
    const html = render(makeItem({ id: 'a', text: 'Write the spec' }))
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(tickTag(html))?.[1]
    expect(labelledBy).toBeDefined()
    expect(html).toContain(`id="${labelledBy}"`)
    expect(new RegExp(`id="${labelledBy}"[^>]*>Write the spec<`).test(html)).toBe(true)
  })

  it('tick_has_a_24px_target_around_a_16px_box', () => {
    const html = render(makeItem({ id: 'a' }))
    expect(html).toContain('size-6')
    expect(tickTag(html)).toContain('size-4')
    expect(tickTag(html)).toContain('after:-inset-1')
  })

  it('pending_is_aria_disabled_not_disabled', () => {
    const tag = tickTag(render(makeItem({ id: 'a' }), { pending: true }))
    expect(tag).toContain('aria-disabled="true"')
    expect(tag).toContain('aria-busy="true"')
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('pending_keeps_focus_on_tick', () => {
    const html = render(makeItem({ id: 'a' }), { pending: true })
    expect(tickTag(html)).not.toBe('')
    expect(html).toMatch(/<button[^>]*role="checkbox"[^>]*>(?:(?!<\/button>).)*animate-spin/)
  })

  it('idle_tick_is_enabled_and_not_busy', () => {
    const tag = tickTag(render(makeItem({ id: 'a' })))
    expect(tag).toContain('aria-disabled="false"')
    expect(tag).not.toContain('aria-busy="true"')
  })

  it('next_row_has_aria_current_step', () => {
    expect(render(makeItem({ id: 'a', status: 'next' }))).toMatch(/<li[^>]*aria-current="step"/)
    expect(render(makeItem({ id: 'a', status: 'upcoming' }))).not.toContain('aria-current')
  })

  it('status_word_visible_for_next_and_screen_reader_only_for_upcoming', () => {
    expect(render(makeItem({ id: 'a', status: 'blocked' }))).toMatch(/<span>Blocked<\/span>/)
    expect(render(makeItem({ id: 'a', status: 'upcoming' }))).toMatch(/<span class="sr-only">Upcoming<\/span>/)
  })

  it('completed_by_visible', () => {
    expect(textOf(render(makeItem({ id: 'a', status: 'complete', completedBy: 'agent' })))).toContain('Completed by the agent')
    expect(textOf(render(makeItem({ id: 'a', status: 'complete', completedBy: 'developer' })))).toContain('Completed by you')
    expect(textOf(render(makeItem({ id: 'a', status: 'complete', updatedBy: 'developer' })))).toContain('Completed by you')
    expect(textOf(render(makeItem({ id: 'a', status: 'next' })))).not.toContain('Completed by')
  })

  it('value_shown_as_plain_text', () => {
    const html = render(makeItem({ id: 'a', requiresValue: true, value: 'line1\nline2' }))
    expect(html).toMatch(/whitespace-pre-wrap break-words[^>]*><span[^>]*>Value: <\/span>line1\nline2/)
  })

  it('empty_value_shows_no_value_line', () => {
    expect(textOf(render(makeItem({ id: 'a', requiresValue: true, value: '' })))).not.toContain('Value:')
  })

  it('requires_value_tick_aria_disabled_with_reason', () => {
    const html = render(makeItem({ id: 'a', requiresValue: true }))
    const tag = tickTag(html)
    expect(tag).toContain('aria-disabled="true"')
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/)
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1]
    expect(describedBy).toBeDefined()
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>This item needs a value before it can be ticked.<`))
  })

  it('requires_value_with_value_shows_no_reason', () => {
    const html = render(makeItem({ id: 'a', requiresValue: true, value: 'abc' }))
    expect(html).not.toContain('needs a value')
    expect(tickTag(html)).toContain('aria-disabled="false"')
  })

  it('item_changed_alert_text', () => {
    const html = render(makeItem({ id: 'a' }), { refusal: { code: 'item_changed', message: 'raw', status: 'complete' } })
    expect(html).toMatch(/<p role="alert"[^>]*>The agent changed this item to complete\. Tick again if you still want it\.<\/p>/)
  })

  it('other_refusal_shows_its_message_in_an_alert', () => {
    expect(render(makeItem({ id: 'a' }), { refusal: { code: 'x', message: 'Not allowed' } })).toMatch(/role="alert"[^>]*>Not allowed</)
  })

  it('no_alert_without_a_refusal', () => {
    expect(render(makeItem({ id: 'a' }))).not.toContain('role="alert"')
  })

  it('text_rendered_as_plain_text', () => {
    const html = render(makeItem({ id: 'a', text: '<b>bold</b> & more' }))
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more')
    expect(html).not.toContain('<b>')
    expect(html).toMatch(/whitespace-pre-wrap break-words/)
  })

  it('no_step_wording', () => {
    const states = [
      render(makeItem({ id: 'a', status: 'next' })),
      render(makeItem({ id: 'a', requiresValue: true }), { refusal: { code: 'item_changed', message: 'm', status: 'next' } }),
      render(makeItem({ id: 'a', status: 'complete', completedBy: 'agent', value: 'v' }), { pending: true })
    ]
    for (const html of states) expect(textOf(html)).not.toMatch(/\bsteps?\b/i)
  })
})
