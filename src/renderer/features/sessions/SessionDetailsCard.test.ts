import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../../../shared/ipc'

const captured = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))

vi.mock('@/state', () => ({
  useSessionsStore: { getState: () => ({ refresh: () => undefined }) },
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))
vi.mock('@/components/ui/exclusive-menu', () => ({ useAnyMenuOpen: () => false }))
vi.mock('./useWorktreeActions', () => ({ useWorktreeActions: () => ({ copyPath: () => undefined, reveal: () => undefined }) }))
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: (props: Record<string, unknown> & { children: ReactNode }) => {
    captured.props = props
    return props.children
  },
  HoverCardTrigger: ({ children }: { children: ReactNode }) => children,
  HoverCardContent: () => null
}))

import { SESSION_DETAILS_OPEN_DELAY_MS, SessionDetailsCard } from './SessionDetailsCard'

describe('SessionDetailsCard hover card wiring (issue #1760, FR-192)', () => {
  const session = {
    id: 's1',
    name: 'Alpha',
    status: 'idle',
    unread: false,
    lastActivityAt: '2026-11-27T10:00:00.000Z'
  } as unknown as SessionSummary
  const renderCard = (): void => {
    renderToStaticMarkup(
      createElement(SessionDetailsCard, { session, worktreeMissing: false, children: createElement('button', null, 'Row') })
    )
  }

  it('opens after 1200 ms, not Radix 700 ms or the old 750 ms', () => {
    renderCard()
    expect(SESSION_DETAILS_OPEN_DELAY_MS).toBe(1200)
    expect(captured.props?.openDelay).toBe(1200)
  })

  it('opts in to staying closed after a click until the pointer leaves and returns', () => {
    renderCard()
    expect(captured.props?.suppressAfterClick).toBe(true)
  })
})
