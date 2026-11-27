import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../../../shared/ipc'

vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))

import {
  activeSessionEntries,
  activeSessionLine,
  activeSessionsAccessibleText,
  activeSessionText,
  collapsedActiveSessions,
  isActiveSession
} from './sessionDisplay'

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { name: over.id, status: 'idle', unread: false, archivedAt: undefined, ...over } as unknown as SessionSummary
}

const working = (id: string, name = id): SessionSummary => session({ id, name, status: 'working' })

describe('isActiveSession (issue #1854)', () => {
  it.each([
    ['working', { status: 'working' }, true],
    ['needs you', { status: 'needs-you' }, true],
    ['paused mid-turn', { status: 'idle', pause: 'paused' }, true],
    ['pausing', { status: 'working', pause: 'pausing' }, true],
    ['idle', { status: 'idle' }, false],
    ['idle with an unseen reply', { status: 'idle', unread: true }, false],
    ['stopped', { status: 'stopped' }, false]
  ] as const)('%s -> %s', (_name, fields, expected) => {
    expect(isActiveSession(fields as Pick<SessionSummary, 'status' | 'unread' | 'pause'>)).toBe(expected)
  })
})

describe('activeSessionLine', () => {
  it('reads the row line for subagents', () => {
    const s = session({ id: 'a', status: 'working', activity: { runningSubagents: 2 } } as Partial<SessionSummary> & { id: string })
    expect(activeSessionLine(s)).toBe('Waiting for 2 subagents')
  })

  it('reads the pause label for a paused Session', () => {
    expect(activeSessionLine(session({ id: 'a', status: 'idle', pause: 'paused' }))).toBe('Paused')
  })

  it('reads the needs-you line', () => {
    expect(activeSessionLine(session({ id: 'a', status: 'needs-you' }))).toBe('Waiting for your answer')
  })
})

describe('activeSessionEntries', () => {
  it('lists only active Sessions with their name and line, in order', () => {
    const entries = activeSessionEntries([working('a', 'Alpha'), session({ id: 'b', status: 'idle' }), session({ id: 'c', name: 'Gamma', status: 'needs-you' })])
    expect(entries.map((entry) => entry.name)).toEqual(['Alpha', 'Gamma'])
    expect(entries).toHaveLength(2)
  })

  it('is empty when every Session is idle or stopped', () => {
    expect(activeSessionEntries([session({ id: 'a' }), session({ id: 'b', status: 'stopped' })])).toEqual([])
  })
})

describe('collapsedActiveSessions', () => {
  const sessions = [working('a'), working('b'), session({ id: 'c' })]

  it('counts the active Sessions while the group is collapsed', () => {
    expect(collapsedActiveSessions(sessions, false)).toHaveLength(2)
  })

  it('shows nothing while the group is expanded', () => {
    expect(collapsedActiveSessions(sessions, true)).toEqual([])
  })

  it('shows nothing for a collapsed group with only idle Sessions', () => {
    expect(collapsedActiveSessions([session({ id: 'a' })], false)).toEqual([])
  })
})

describe('tooltip and accessible text', () => {
  it('formats a line as "Name: status"', () => {
    expect(activeSessionText({ id: 'a', name: 'Refract Dev Team', line: 'Waiting for 2 subagents' })).toBe('Refract Dev Team: Waiting for 2 subagents')
  })

  it('names the count and every Session in the accessible name', () => {
    const text = activeSessionsAccessibleText([
      { id: 'a', name: 'Alpha', line: 'Working...' },
      { id: 'b', name: 'Beta', line: 'Waiting for your answer' }
    ])
    expect(text).toBe('2 active Sessions: Alpha: Working...; Beta: Waiting for your answer')
  })

  it('uses the singular for one Session and null for none', () => {
    expect(activeSessionsAccessibleText([{ id: 'a', name: 'Alpha', line: 'x' }])).toBe('1 active Session: Alpha: x')
    expect(activeSessionsAccessibleText([])).toBeNull()
  })
})
