// The repo has no jsdom: the line is rendered to a string, and the real SourceTag is wrapped only to
// capture the props the line hands it. The checklist hook reads the real store's current state
// because zustand's server snapshot would otherwise always be the empty initial state.
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as ChecklistStoreModule from '@/state/checklist-store'
import type * as SourceTagModule from '@/components/SourceTag'
import type { SessionChecklist } from '@/state/checklist-store'
import type { MessageSource } from '../../../shared/model'
import { makeChecklist, makeItem } from '../right-pane/checklist/checklist-fixtures'

const captured = vi.hoisted(() => ({ tag: undefined as undefined | { action?: { label: string; onActivate: () => void } } }))

vi.mock('@/state/checklist-store', async (importActual) => {
  const actual = await importActual<typeof ChecklistStoreModule>()
  const hook = Object.assign((selector: (state: unknown) => unknown) => selector(actual.useChecklistStore.getState()), actual.useChecklistStore)
  return { ...actual, useChecklistStore: hook }
})
vi.mock('@/components/SourceTag', async (importActual) => {
  const actual = await importActual<typeof SourceTagModule>()
  return {
    SourceTag: (props: ComponentProps<typeof actual.SourceTag>) => {
      captured.tag = props
      return actual.SourceTag(props)
    }
  }
})

import { useChecklistStore } from '@/state/checklist-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { frontSessionIdOf, useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'
import { ChecklistItemSourceLine, hydrateIfUnseen } from './ChecklistItemSourceLine'

type ItemSource = Extract<MessageSource, { kind: 'checklist-item' }>
const SOURCE: ItemSource = { kind: 'checklist-item', checklistId: 'p1', itemId: 'i2', action: 'ask' }
const checklist = makeChecklist({ items: [makeItem({ id: 'i1', text: 'Plan it' }), makeItem({ id: 'i2', text: 'Run the migration above the bucket' })] })

const known = (sessionId: string, overrides: Partial<SessionChecklist> = {}) => {
  useChecklistStore.setState({ bySession: { ...useChecklistStore.getState().bySession, [sessionId]: { ...entry(), ...overrides } } })
}
const entry = (): SessionChecklist => ({ checklist, toolUnavailable: false, loaded: true, error: null, errorCode: null, pending: {}, refusals: {}, announcement: null, supersededIds: [], seq: 1 })

const render = (source: ItemSource = SOURCE, sessionId: string | null = 's1') =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChecklistItemSourceLine, { source, sessionId, id: 'line-1' })))

beforeEach(() => {
  const refract = { settings: { setSplit: () => Promise.resolve({ ok: true }) }, checklist: { get: vi.fn(() => Promise.resolve({ ok: true, value: { checklist: null, toolUnavailable: false } })) } }
  vi.stubGlobal('window', { refract, setTimeout: () => 0, clearTimeout: () => undefined })
  vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null, getElementById: () => null })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  useViewStore.setState({ view: 'chat' })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, chatCollapsed: false })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0, pristineIds: new Set() })
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
  captured.tag = undefined
})

afterEach(() => vi.unstubAllGlobals())

describe('ChecklistItemSourceLine', () => {
  it('renders_position_and_clamped_text', () => {
    known('s1')
    const html = render()
    expect(html).toContain('Checklist item 2:')
    expect(html).toMatch(/<span class="line-clamp-2 min-w-0 break-words">Run the migration above the bucket<\/span>/)
    expect(html).toContain('id="line-1"')
    expect(html).toMatch(/<button[^>]*>Show in checklist<\/button>/)
  })

  it('removed_has_no_button', () => {
    known('s1', { checklist: makeChecklist({ items: [makeItem({ id: 'i1' })] }) })
    const html = render()
    expect(html).toContain('Checklist item (removed)')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('line-clamp')
  })

  it('replaced_has_no_button', () => {
    known('s1', { checklist: makeChecklist({ id: 'p2' }) })
    const html = render()
    expect(html).toContain('Checklist item (replaced checklist)')
    expect(html).not.toContain('<button')
  })

  it('unknown_shows_label_without_number', () => {
    const html = render()
    expect(html).toContain('Checklist item')
    expect(html).not.toMatch(/Checklist item \d/)
    expect(html).not.toContain('(removed)')
    expect(html).not.toContain('<button')
  })

  it('a_turn_with_no_session_has_no_button', () => {
    known('s1')
    expect(render(SOURCE, null)).not.toContain('<button')
  })

  it('action_calls_reveal', () => {
    known('s1')
    render()
    captured.tag?.action?.onActivate()
    expect(useChecklistStore.getState().revealRequest).toEqual({ sessionId: 's1', checklistId: 'p1', itemId: 'i2' })
  })

  it('activation_opens_panel_without_focus_then_sets_request', () => {
    known('s1')
    const order: string[] = []
    const openPanel = vi.fn((id: string, options?: { focus?: boolean }) => order.push(`open:${id}:${String(options?.focus)}`))
    useRightPaneStore.setState({ openPanel: openPanel as never })
    const requestReveal = useChecklistStore.getState().requestReveal
    useChecklistStore.setState({ requestReveal: (request) => { order.push('reveal'); requestReveal(request) } })
    render()
    captured.tag?.action?.onActivate()
    expect(order).toEqual(['open:checklist:false', 'reveal'])
  })

  it('activation_activates_session_first_in_split', () => {
    known('s2')
    useSplitStore.setState({ paneSessionIds: ['s1', 's2'], focusedIndex: 0 })
    let frontAtReveal: string | null = null
    const requestReveal = useChecklistStore.getState().requestReveal
    useChecklistStore.setState({
      requestReveal: (request) => {
        frontAtReveal = frontSessionIdOf(useSplitStore.getState())
        requestReveal(request)
      }
    })
    render(SOURCE, 's2')
    captured.tag?.action?.onActivate()
    expect(frontAtReveal).toBe('s2')
    expect(useSplitStore.getState().focusedIndex).toBe(1)
    expect(useSplitStore.getState().paneSessionIds).toEqual(['s1', 's2'])
    expect(useChecklistStore.getState().revealRequest?.sessionId).toBe('s2')
  })
})

describe('hydrateIfUnseen', () => {
  it('asks_once_for_a_session_nobody_has_read', async () => {
    hydrateIfUnseen('s2')
    hydrateIfUnseen('s2')
    await vi.waitFor(() => expect(useChecklistStore.getState().bySession['s2']?.loaded).toBe(true))
    expect(window.refract.checklist.get).toHaveBeenCalledTimes(1)
  })

  it('leaves_a_session_that_already_has_state', () => {
    known('s1')
    hydrateIfUnseen('s1')
    expect(window.refract.checklist.get).not.toHaveBeenCalled()
  })
})
