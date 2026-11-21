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

  it('status_word_visible_for_blocked_and_screen_reader_only_for_complete', () => {
    expect(render(makeItem({ id: 'a', status: 'blocked' }))).toMatch(/<span>Blocked<\/span>/)
    expect(render(makeItem({ id: 'a', status: 'complete', completedBy: 'agent' }))).toMatch(/<span class="sr-only">Complete<\/span>/)
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
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1]?.split(' ') ?? []
    expect(describedBy).toHaveLength(1)
    expect(html).toMatch(new RegExp(`id="${describedBy[0]}"[^>]*>This item needs a value before it can be ticked.<`))
  })

  it('tick_is_described_by_the_visible_status_and_the_reason', () => {
    const html = render(makeItem({ id: 'a', status: 'blocked', requiresValue: true }))
    const ids = /aria-describedby="([^"]+)"/.exec(tickTag(html))?.[1]?.split(' ') ?? []
    expect(ids).toHaveLength(2)
    expect(html).toMatch(new RegExp(`id="${ids[0]}"[^>]*>.*Blocked`))
  })

  it('upcoming_row_renders_no_status_line', () => {
    const html = render(makeItem({ id: 'a', status: 'upcoming' }))
    expect(textOf(html)).not.toContain('Upcoming')
    expect(tickTag(html)).not.toContain('aria-describedby')
  })

  it('requires_value_with_value_shows_no_reason', () => {
    const html = render(makeItem({ id: 'a', requiresValue: true, value: 'abc' }))
    expect(html).not.toContain('needs a value')
    expect(tickTag(html)).toContain('aria-disabled="false"')
  })

  it('item_changed_is_a_quiet_notice_naming_the_new_status', () => {
    const html = render(makeItem({ id: 'a' }), { refusal: { code: 'item_changed', message: 'raw', op: 'tick', status: 'blocked' } })
    expect(html).toMatch(/<p[^>]*data-tone="notice"[^>]*role="status"[^>]*>The agent changed this item to blocked\. Tick again if you still want it\.<\/p>/)
  })

  it('item_changed_to_complete_does_not_ask_for_another_tick', () => {
    const html = render(makeItem({ id: 'a' }), { refusal: { code: 'item_changed', message: 'raw', op: 'tick', status: 'complete' } })
    expect(textOf(html)).toContain('The agent already marked this item complete.')
    expect(textOf(html)).not.toContain('Tick again')
  })

  it('other_refusal_shows_its_message_as_an_error', () => {
    expect(render(makeItem({ id: 'a' }), { refusal: { code: 'x', message: 'Not allowed', op: 'tick' } })).toMatch(/data-tone="error"[^>]*role="alert"[^>]*>/)
    expect(textOf(render(makeItem({ id: 'a' }), { refusal: { code: 'x', message: 'Not allowed', op: 'tick' } }))).toContain('Not allowed')
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
      render(makeItem({ id: 'a', requiresValue: true }), { refusal: { code: 'item_changed', message: 'm', op: 'tick', status: 'next' } }),
      render(makeItem({ id: 'a', status: 'complete', completedBy: 'agent', value: 'v' }), { pending: true })
    ]
    for (const html of states) expect(textOf(html)).not.toMatch(/\bsteps?\b/i)
  })
})

describe('ChecklistRow memo comparator', () => {
  type Props = Parameters<typeof ChecklistRow>[0]
  // React's memo type does not expose its comparator, but the memo object carries it.
  const compare = (ChecklistRow as unknown as { compare: (a: Props, b: Props) => boolean }).compare
  const onTick = (): void => {}
  const base: Props = { item: makeItem({ id: 'a', rev: 1 }), pending: false, onTick, refusal: undefined }

  it('same_rev_pending_refusal_and_onTick_skip_the_render', () => {
    expect(compare(base, { ...base, item: { ...base.item } })).toBe(true)
  })

  it.each([
    ['rev', { item: makeItem({ id: 'a', rev: 2 }) }],
    ['pending', { pending: true }],
    ['refusal', { refusal: { code: 'item_changed', message: 'm', op: 'tick' as const } }],
    ['onTick', { onTick: () => {} }]
  ])('a_changed_%s_re_renders', (_name, change) => {
    expect(compare(base, { ...base, ...change })).toBe(false)
  })
})
