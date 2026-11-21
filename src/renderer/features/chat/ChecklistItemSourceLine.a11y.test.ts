// The repo has no jsdom, so keyboard behaviour is proven the way SourceTag's own test does it: the
// action is a native button wired through onClick alone, which the browser activates on Enter and
// Space. The real line and the real SourceTag render inside the real row; only the context menu
// (its own tab stop, tested elsewhere) is replaced by a passthrough.
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as ChecklistStoreModule from '@/state/checklist-store'
import type * as SourceTagModule from '@/components/SourceTag'
import type { SessionChecklist } from '@/state/checklist-store'
import type { MessageSource } from '../../../shared/model'
import { makeChecklist, makeItem } from '../right-pane/checklist/checklist-fixtures'

// Importing the state modules registers dev stores and unload listeners on `window`, so a stub must
// exist before the imports run.
const captured = vi.hoisted(() => {
  Object.assign(globalThis, { window: { addEventListener: () => undefined, removeEventListener: () => undefined } })
  return { props: undefined as undefined | Record<string, unknown>, tag: undefined as undefined | ((props: never) => ReactNode) }
})

vi.mock('./MessageMenu', () => ({ MessageMenu: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/state/checklist-store', async (importActual) => {
  const actual = await importActual<typeof ChecklistStoreModule>()
  const hook = Object.assign((selector: (state: unknown) => unknown) => selector(actual.useChecklistStore.getState()), actual.useChecklistStore)
  return { ...actual, useChecklistStore: hook }
})
vi.mock('@/components/SourceTag', async (importActual) => {
  const actual = await importActual<typeof SourceTagModule>()
  captured.tag = actual.SourceTag as never
  return {
    SourceTag: (props: ComponentProps<typeof actual.SourceTag>) => {
      captured.props = props as never
      return actual.SourceTag(props)
    }
  }
})

import { useChecklistStore } from '@/state/checklist-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'
import { UserMessageRow, type UserItem } from './UserMessageRow'

const SOURCE: MessageSource = { kind: 'checklist-item', checklistId: 'p1', itemId: 'i2', action: 'ask' }
const ITEM: UserItem = { kind: 'user', id: 'u1', text: 'Is this safe?', at: 0, source: SOURCE }

const known = () => {
  const entry: SessionChecklist = {
    checklist: makeChecklist({ items: [makeItem({ id: 'i1', text: 'Plan it' }), makeItem({ id: 'i2', text: 'Run the migration' })] }),
    toolUnavailable: false,
    loaded: true,
    error: null,
    errorCode: null,
    pending: {},
    refusals: {},
    announcement: null,
    supersededIds: [],
    seq: 1
  }
  useChecklistStore.setState({ bySession: { s1: entry } })
}

const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(UserMessageRow, { item: ITEM, sessionId: 's1', userName: 'Stuart' })))
const lineMarkup = (html: string) => /<div class="mb-1 flex min-w-0 justify-end text-xs">.*?<\/div>/.exec(html)?.[0] ?? ''

function findAll(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, out))
  else if (isValidElement<Record<string, unknown>>(node)) {
    if (match(node)) out.push(node)
    findAll(node.props.children as ReactNode, match, out)
  }
  return out
}

beforeEach(() => {
  const refract = { settings: { setSplit: () => Promise.resolve({ ok: true }) }, checklist: { get: vi.fn(() => Promise.resolve({ ok: true, value: { checklist: null, toolUnavailable: false } })) } }
  vi.stubGlobal('window', { refract, setTimeout: () => 0, clearTimeout: () => undefined })
  vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null, getElementById: () => null })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  useViewStore.setState({ view: 'chat' })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, chatCollapsed: false })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0, pristineIds: new Set() })
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
  known()
  captured.props = undefined
})

afterEach(() => vi.unstubAllGlobals())

describe('checklist source line keyboard and screen reader', () => {
  it('tab_reaches_only_the_action_button', () => {
    const line = lineMarkup(render())
    expect(line.match(/<button/g)).toHaveLength(1)
    // The tooltip trigger carries tabindex="-1" (focusable by pointer only); any other value is a tab stop.
    expect(line).not.toMatch(/tabindex="(?!-1")/)
    expect(line).not.toContain('<a ')
  })

  it('enter_and_space_activate', () => {
    render()
    const tree = captured.tag?.(captured.props as never)
    const [button] = findAll(tree, (el) => el.props.type === 'button')
    expect(button).toBeDefined()
    // A key handler on top of a native button would run the action twice on Enter and Space.
    expect(button!.props.onKeyDown).toBeUndefined()
    expect(button!.props.onKeyUp).toBeUndefined()
    expect(typeof button!.props.onClick).toBe('function')
    ;(button!.props.onClick as () => void)()
    expect(useChecklistStore.getState().revealRequest).toEqual({ sessionId: 's1', checklistId: 'p1', itemId: 'i2' })
  })

  it('bubble_name_reads_the_words_not_the_action', () => {
    const html = render()
    const lineId = /<span id="([^"]+)" class="inline-flex min-w-0 items-start gap-1">/.exec(html)?.[1]
    expect(lineId).toBeDefined()
    expect(html).toContain(`role="group" aria-labelledby="${lineId}"`)
    // The labelled span ends at the detail span's close, before the "Show in checklist" button.
    const named = new RegExp(`<span id="${lineId}"[^>]*>(.*?)</span></span>`).exec(html)?.[1] ?? ''
    expect(named).toContain('Checklist item 2:')
    expect(named).toContain('Run the migration')
    expect(named).not.toContain('Show in checklist')
    expect(lineMarkup(html)).toContain('Show in checklist')
    expect(lineMarkup(html)).not.toContain('aria-hidden="true">Checklist')
  })
})
