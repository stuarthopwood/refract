// #1862 FR-012: the creation announcement for a child, and the per-update decision of what to say, are pure.
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import { createdChildAnnouncement, newSessionAnnouncements, wasHiddenByFilter } from './createdSessionAnnouncement'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { kind: 'project', id, name: `Session ${id}`, repositoryId: 'r1', archivedAt: null, ...over } as SessionSummary
}

const never = () => false
const open = () => false

describe('createdChildAnnouncement', () => {
  it('names the child and its parent', () => {
    expect(createdChildAnnouncement({ name: 'Fix bug' }, { name: 'Plan' }, false)).toBe('Fix bug created under Plan')
  })

  it('adds "(collapsed)" when the parent is collapsed', () => {
    expect(createdChildAnnouncement({ name: 'Fix bug' }, { name: 'Plan' }, true)).toBe('Fix bug created under Plan (collapsed)')
  })
})

describe('newSessionAnnouncements', () => {
  const parent = session('p')
  const child = session('c', { parentSessionId: 'p' })

  it('announces a child that appears after startup, once', () => {
    expect(newSessionAnnouncements(new Set(['p']), [parent, child], open, never)).toEqual(['Session c created under Session p'])
  })

  it('reads collapsed from the parent, not the child', () => {
    const collapsedIds = new Set(['p'])
    const messages = newSessionAnnouncements(new Set(['p']), [parent, child], (id) => collapsedIds.has(id), never)
    expect(messages).toEqual(['Session c created under Session p (collapsed)'])
  })

  it('is silent on the first load, when no Session was known before', () => {
    expect(newSessionAnnouncements(new Set(), [parent, child], open, never)).toEqual([])
  })

  it('is silent when a refresh adds no new id', () => {
    expect(newSessionAnnouncements(new Set(['p', 'c']), [parent, child], open, never)).toEqual([])
  })

  it('is silent for a new Session with no parent, and for one whose parent is not in the list', () => {
    expect(newSessionAnnouncements(new Set(['p']), [parent, session('x')], open, never)).toEqual([])
    expect(newSessionAnnouncements(new Set(['p']), [parent, session('y', { parentSessionId: 'gone' })], open, never)).toEqual([])
  })

  it('skips a new archived Session', () => {
    expect(newSessionAnnouncements(new Set(['p']), [parent, session('c', { parentSessionId: 'p', archivedAt: '2026-01-02T00:00:00Z' })], open, never)).toEqual([])
  })

  it('keeps one message per new child, in list order', () => {
    const messages = newSessionAnnouncements(new Set(['p']), [parent, child, session('d', { parentSessionId: 'p' })], open, never)
    expect(messages).toEqual(['Session c created under Session p', 'Session d created under Session p'])
  })

  it('appends the filter suffix to a child the query hides, and still announces a hidden non-child as before', () => {
    const hidden = newSessionAnnouncements(new Set(['p']), [parent, child], open, () => true)
    expect(hidden).toEqual(['Session c created under Session p, hidden by the session filter'])
    expect(hidden.every((text) => wasHiddenByFilter(text))).toBe(true)
    expect(newSessionAnnouncements(new Set(['p']), [parent, session('x')], open, (s) => s.id === 'x')).toEqual([
      'Created session Session x, hidden by the session filter'
    ])
  })
})
