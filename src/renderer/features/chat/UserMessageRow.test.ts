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
  const useSessionsStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state })
  const useSplitStore = { getState: () => state }
  return { state, useSessionsStore, useSplitStore }
})
vi.mock('@/state', () => ({ useSessionsStore: mocks.useSessionsStore, useSplitStore: mocks.useSplitStore }))

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

const render = (item: UserItem) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(UserMessageRow, { item, userName: 'Stuart' })))

beforeEach(() => {
  mocks.state.sessions = [{ id: 'sess-1' }]
  mocks.state.open = vi.fn(() => Promise.resolve(null))
  mocks.state.replaceFocused = vi.fn()
})

describe('SessionSourceLine', () => {
  it('gives the SourceTag a name action that opens the sender with the user-initiated flag', () => {
    const tree = SessionSourceLine({ source: SOURCE, senderExists: true, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    expect(tag!.props.label).toBe('From Session')
    expect(tag!.props.action.label).toBe('Alpha')
    tag!.props.action.onActivate()
    expect(mocks.state.open).toHaveBeenCalledTimes(1)
    expect(mocks.state.open).toHaveBeenCalledWith('sess-1', true)
    expect(mocks.state.replaceFocused).toHaveBeenCalledWith('sess-1')
  })

  it('shows the id as plain text with no action once the sender is deleted', () => {
    const tree = SessionSourceLine({ source: SOURCE, senderExists: false, id: 'line-1' })
    const [tag] = findAll(tree, (el) => typeof el.type !== 'string' && el.props.label !== undefined)
    expect(tag!.props.label).toBe('From Session sess-1')
    expect(tag!.props.action).toBeUndefined()
    expect(mocks.state.open).not.toHaveBeenCalled()
  })
})

describe('UserMessageRow session source', () => {
  it('shows a From Session line with the sender name as a button, above the bubble', () => {
    const html = render({ ...base, source: SOURCE })
    expect(html).toMatch(/From Session<button type="button"[^>]*>Alpha<\/button>/)
    expect(html.indexOf('From Session')).toBeLessThan(html.indexOf('hello there'))
  })

  it('names the bubble after the line so a screen reader hears the sender first', () => {
    const html = render({ ...base, source: SOURCE })
    const lineId = /<div id="([^"]+)" class="mb-1 flex justify-end text-xs">/.exec(html)?.[1]
    expect(lineId).toBeDefined()
    expect(html).toContain(`role="group" aria-labelledby="${lineId}"`)
  })

  it('shows the sender id as plain text, with no button, when the sender Session is gone', () => {
    mocks.state.sessions = []
    const html = render({ ...base, source: SOURCE })
    expect(html).toContain('From Session sess-1')
    expect(/<span data-slot="source-tag".*?<\/span>/.exec(html)?.[0]).not.toContain('<button')
    expect(html).not.toContain('>Alpha<')
  })

  it('adds no line, group role or button to an ordinary user item', () => {
    const html = render(base)
    expect(html).not.toContain('From Session')
    expect(html).not.toContain('aria-labelledby')
    expect(html).not.toContain('role="group"')
    expect(html).toContain('hello there')
  })
})
