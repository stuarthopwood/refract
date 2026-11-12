// The repo has no jsdom: the row is rendered to a string, the pure line is called as a function.
// `@/state` is mocked so the sessions list the row reads is controllable (zustand's server snapshot
// would otherwise always be the empty initial state).
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { MessageSource } from '../../../shared/model'

const mocks = vi.hoisted(() => {
  const state = {
    sessions: [] as { id: string }[],
    open: undefined as unknown as (id: string, userAction?: boolean) => Promise<null>,
    replaceFocused: undefined as unknown as (id: string) => void
  }
  const select = vi.fn()
  const useSessionsStore = Object.assign(
    (selector: (s: typeof state) => unknown) => {
      select()
      return selector(state)
    },
    { getState: () => state }
  )
  const useSplitStore = { getState: () => state }
  return { state, select, useSessionsStore, useSplitStore, focusSessionPane: vi.fn(), focusSessionsNav: vi.fn() }
})
vi.mock('@/state', () => ({ useSessionsStore: mocks.useSessionsStore, useSplitStore: mocks.useSplitStore }))
vi.mock('@/lib/focus', () => ({ focusSessionPane: mocks.focusSessionPane, focusSessionsNav: mocks.focusSessionsNav }))

import { SessionSourceLine } from './SessionSourceLine'
import { UserMessageRow, type UserItem } from './UserMessageRow'

const SOURCE: MessageSource = { kind: 'session', sessionId: 'sess-1', name: 'Alpha' }
const base: UserItem = { kind: 'user', id: 'u1', text: 'hello there', at: 0 }

function findAll(node: ReactNode, match: (el: ReactElement<Record<string, any>>) => boolean, out: ReactElement<Record<string, any>>[] = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, out))
  else if (isValidElement<Record<string, any>>(node)) {
    if (match(node)) out.push(node)
    findAll(node.props.children as ReactNode, match, out)
  }
  return out
}

const render = (item: UserItem, userAvatarUrl?: string) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(UserMessageRow, { item, userName: 'Stuart', userAvatarUrl })))

beforeEach(() => {
  mocks.state.sessions = [{ id: 'sess-1' }]
  mocks.state.open = vi.fn(() => Promise.resolve(null))
  mocks.state.replaceFocused = vi.fn()
  mocks.select.mockClear()
  mocks.focusSessionPane.mockReset().mockReturnValue(true)
  mocks.focusSessionsNav.mockReset()
  // The focus hop waits a frame for the new pane to mount; run it synchronously here.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb())
})

describe('SessionSourceLine', () => {
  it('gives the SourceTag a name action that opens the sender with the user-initiated flag', () => {
    const tree = SessionSourceLine({ source: SOURCE, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    expect(tag!.props.label).toBe('From Session')
    expect(tag!.props.action.label).toBe('Alpha')
    expect(tag!.props.action.ariaLabel).toBeUndefined()
    tag!.props.action.onActivate()
    expect(mocks.state.open).toHaveBeenCalledTimes(1)
    expect(mocks.state.open).toHaveBeenCalledWith('sess-1', true)
    expect(mocks.state.replaceFocused).toHaveBeenCalledWith('sess-1')
  })

  it('moves focus to the newly shown pane after the switch', () => {
    const tree = SessionSourceLine({ source: SOURCE, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    tag!.props.action.onActivate()
    expect(mocks.focusSessionPane).toHaveBeenCalledWith('sess-1')
    expect(mocks.focusSessionsNav).not.toHaveBeenCalled()
  })

  it('falls back to the Sessions nav when the sender pane is not there to take focus', () => {
    mocks.focusSessionPane.mockReturnValue(false)
    const tree = SessionSourceLine({ source: SOURCE, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    tag!.props.action.onActivate()
    expect(mocks.focusSessionsNav).toHaveBeenCalledTimes(1)
  })

  it('shows the sender name marked deleted, with no action, once the sender is gone', () => {
    mocks.state.sessions = []
    const tree = SessionSourceLine({ source: SOURCE, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    expect(tag!.props.label).toBe('From Session Alpha (deleted)')
    expect(tag!.props.action).toBeUndefined()
    expect(mocks.state.open).not.toHaveBeenCalled()
  })
})

describe('UserMessageRow session source', () => {
  it('shows a From Session line with the sender name as a button, above the bubble', () => {
    const html = render({ ...base, source: SOURCE })
    expect(html).toMatch(/From Session <button[^>]*type="button"[^>]*>Alpha<\/button>/)
    expect(html).not.toContain('Open Session')
    expect(html.indexOf('From Session')).toBeLessThan(html.indexOf('hello there'))
  })

  it('names the bubble after the line so a screen reader hears the sender first', () => {
    const html = render({ ...base, source: SOURCE })
    const lineId = /<div id="([^"]+)" class="mb-1 flex justify-end text-xs">/.exec(html)?.[1]
    expect(lineId).toBeDefined()
    expect(html).toContain(`role="group" aria-labelledby="${lineId}"`)
    const line = new RegExp(`<div id="${lineId}"[^>]*>(.*?)</div>`).exec(html)?.[1] ?? ''
    const text = [...line.matchAll(/>([^<]*)</g)].map((m) => m[1]).join('')
    expect(text).toBe('From Session Alpha')
  })

  it('authors a sourced turn as the Session: its name and glyph, never the user name or initials', () => {
    const html = render({ ...base, source: SOURCE }, 'https://example.test/me.png')
    expect(html).not.toContain('Stuart')
    expect(html).not.toContain('me.png')
    expect(html).not.toContain('>S<')
    expect(html).toMatch(/data-slot="message-header"[^>]*>Alpha<\/div>/)
    expect(/data-slot="message-avatar".*?data-slot="message-content"/.exec(html)?.[0]).toContain('<svg')
  })

  it('keeps the user name and avatar on an ordinary user item', () => {
    const html = render(base)
    expect(html).toMatch(/data-slot="message-header"[^>]*>Stuart<\/div>/)
    expect(html).toContain('>S<')
  })

  it('shows the sender name marked deleted, with no button, when the sender Session is gone', () => {
    mocks.state.sessions = []
    const html = render({ ...base, source: SOURCE })
    expect(html).toContain('From Session Alpha (deleted)')
    expect(html).not.toContain('sess-1')
    expect(/<span data-slot="source-tag".*?<\/span>/.exec(html)?.[0]).not.toContain('<button')
  })

  it('adds no line, group role, button or sessions-store lookup to an ordinary user item', () => {
    const html = render(base)
    expect(html).not.toContain('From Session')
    expect(html).not.toContain('aria-labelledby')
    expect(html).not.toContain('role="group"')
    expect(html).toContain('hello there')
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
