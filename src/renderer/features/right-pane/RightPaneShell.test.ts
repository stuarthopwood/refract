// The repo has no jsdom, so the shell renders to a string from the stores' initial snapshots.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useRightPaneStore, useSessionsStore } from '@/state'
import type { PersonalSession } from '../../../shared/model'
import { RightPaneShell } from './RightPaneShell'

// The state barrel registers dev stores on `window` as it loads; hoisting runs this before the imports above.
vi.hoisted(() => {
  const noop = (): void => undefined
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
})

// Server rendering reads the initial snapshot, so patch that as well as the live state.
function seed(): void {
  const personal: PersonalSession = {
    id: 'personal-1',
    name: 'Personal',
    kind: 'personal',
    repositoryId: null,
    branch: null,
    baseBranch: null,
    worktreePath: null,
    sessionDir: null,
    currentConversation: null,
    lastMessageCount: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    lastActivityAt: '2026-11-20T00:00:00.000Z',
    archivedAt: null
  }
  const panes = { open: true, openPanelIds: ['checklist' as const], activePanelId: 'checklist' as const }
  const sessions = { sessions: [personal] }
  useRightPaneStore.setState(panes)
  useSessionsStore.setState(sessions)
  Object.assign(useRightPaneStore.getInitialState(), panes)
  Object.assign(useSessionsStore.getInitialState(), sessions)
}

describe('RightPaneShell', () => {
  it('shell renders checklist panel without repository', () => {
    seed()
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(RightPaneShell, { sessionId: 'personal-1' })))
    expect(html).toContain('aria-label="Checklist"')
    expect(html).toContain('Loading checklist')
    expect(html).not.toContain('No repository')
  })
})
