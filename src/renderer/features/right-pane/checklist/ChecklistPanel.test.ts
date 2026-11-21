// The repo has no jsdom, so the panel renders to a string; the list is a pure component, so its element tree is read directly for keys.
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { selectSessionChecklist, useChecklistStore, type SessionChecklist } from '@/state/checklist-store'
import { ChecklistList, ChecklistPanel } from './ChecklistPanel'
import { makeChecklist, makeItem } from './checklist-fixtures'

// Server rendering reads the store's initial snapshot, so patch that too.
function seed(session: Partial<SessionChecklist> | null, sessionId = 's1'): void {
  const bySession = session === null ? {} : { [sessionId]: { ...selectSessionChecklist({ bySession: {} }, sessionId), ...session } }
  useChecklistStore.setState({ bySession })
  Object.assign(useChecklistStore.getInitialState(), { bySession })
}

const render = (sessionId: string | null = 's1'): string => renderToStaticMarkup(createElement(ChecklistPanel, { sessionId }))
const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

beforeEach(() => seed(null))

describe('ChecklistPanel', () => {
  it('renders_one_li_per_item_keyed_by_id', () => {
    const checklist = makeChecklist({ items: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })] })
    seed({ checklist, loaded: true })
    const html = render()
    expect(html.match(/<ol[ >]/g)).toHaveLength(1)
    expect(html).toContain('<ol aria-label="Ship it">')
    expect(html.match(/<li[ >]/g)).toHaveLength(3)
    expect([...html.matchAll(/data-checklist-item="([^"]+)"/g)].map((m) => m[1])).toEqual(['a', 'b', 'c'])

    const list = ChecklistList({ sessionId: 's1', checklist, pending: {}, refusals: {}, onTick: () => {} })
    const rows = list.props.children as ReactElement[]
    expect(rows.every(isValidElement)).toBe(true)
    expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'c'])
  })

  it('list_ticks_report_the_item_id', () => {
    const onTick = vi.fn()
    const checklist = makeChecklist({ items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })] })
    const rows = ChecklistList({ sessionId: 's1', checklist, pending: {}, refusals: {}, onTick }).props.children as ReactElement<{ onTick: (itemId: string) => void }>[]
    rows[1]?.props.onTick('b')
    expect(onTick).toHaveBeenCalledWith('b')
  })

  it('rows_get_their_pending_and_refusal_state', () => {
    seed({
      checklist: makeChecklist({ items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })] }),
      loaded: true,
      pending: { a: true },
      refusals: { b: { code: 'item_changed', message: 'm', op: 'tick', status: 'blocked' } }
    })
    const html = render()
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1)
    expect(html).toContain('The agent changed this item to blocked.')
  })

  it('live_region_stays_mounted', () => {
    for (const state of [null, { loaded: true }, { toolUnavailable: true }, { loaded: true, checklist: makeChecklist() }]) {
      seed(state)
      expect(render()).toMatch(/<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">/)
    }
    expect(render(null)).toContain('role="status"')
  })

  it('shows_tool_unavailable', () => {
    seed({ toolUnavailable: true, loaded: true })
    const html = render()
    expect(textOf(html)).toContain('The agent can&#x27;t use checklists in this session. Restart the session to try again.')
    expect(html).not.toContain('No checklist yet')
  })

  it('never_silently_empty', () => {
    seed(null)
    expect(textOf(render())).toContain('Loading checklist')
    expect(textOf(render(null))).toContain('No Session open')
    seed({ loaded: true })
    expect(textOf(render())).toContain('No checklist yet')
    seed({ loaded: true, checklist: makeChecklist({ items: [] }) })
    expect(textOf(render())).toContain('This checklist has no items yet.')
    expect(textOf(render())).not.toContain('0 of 0')
  })

  it('store_error_shows_user_copy_and_retry_never_the_raw_message', () => {
    seed({ error: 'rust exploded', errorCode: 'store-failed', loaded: true })
    const html = render()
    expect(html).toMatch(/role="alert"[^>]*>(?:(?!<\/div>).)*Couldn&#x27;t read this session&#x27;s checklist/)
    expect(html).toContain('Retry')
    expect(textOf(html)).not.toContain('rust exploded')
  })

  it('unsupported_store_error_offers_no_retry', () => {
    seed({ error: 'newer', errorCode: 'store-unsupported', loaded: true })
    const html = render()
    expect(textOf(html)).toContain('newer version of Refract')
    expect(html).not.toContain('Retry')
  })

  it('only_complete_items_count_as_done', () => {
    const items = [makeItem({ id: 'a', status: 'complete' }), makeItem({ id: 'b', status: 'next' }), makeItem({ id: 'c', status: 'in_progress' }), makeItem({ id: 'd', status: 'blocked' })]
    seed({ loaded: true, checklist: makeChecklist({ items }) })
    expect(textOf(render())).toContain('1 of 4 items complete')
  })

  it('region_is_programmatically_focusable_and_named', () => {
    seed(null)
    expect(render()).toMatch(/<section[^>]*aria-label="Checklist"[^>]*tabindex="-1"|<section[^>]*tabindex="-1"[^>]*aria-label="Checklist"/)
  })

  it('error_keeps_the_held_checklist_visible', () => {
    seed({ error: 'store-failed', loaded: true, checklist: makeChecklist({ title: 'Ship it' }) })
    expect(textOf(render())).toContain('Ship it')
  })

  it('header_counts_completed_items_in_item_wording', () => {
    seed({
      loaded: true,
      checklist: makeChecklist({ items: [makeItem({ id: 'a', status: 'complete' }), makeItem({ id: 'b' })] })
    })
    expect(textOf(render())).toContain('1 of 2 items complete')
    seed({ loaded: true, checklist: makeChecklist({ items: [makeItem({ id: 'a' })] }) })
    expect(textOf(render())).toContain('0 of 1 item complete')
  })
})
