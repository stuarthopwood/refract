// #1862: the archive decision, the dialog model, the result text and the call each button makes are pure,
// so they are tested over plain Session fixtures with no DOM.
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx (home of `isRunning`) imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSessionsStore: () => undefined, useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import { archiveDecision, archiveResultMessage, runArchive, type ArchiveDialogModel } from './useArchiveSession'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: 'project',
    id,
    name: `Session ${id}`,
    repositoryId: 'r1',
    branch: `b-${id}`,
    baseBranch: 'main',
    worktreePath: `/w/${id}`,
    sessionDir: null,
    currentConversation: null,
    lastMessageCount: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    status: 'stopped',
    unread: false,
    launchedMode: 'ask',
    pendingMode: null,
    ...over
  } as SessionSummary
}

function model(sessions: SessionSummary[], id = 'p'): ArchiveDialogModel {
  const decision = archiveDecision(sessions, id)
  if (decision.kind !== 'confirm') throw new Error('expected the dialog')
  return decision.model
}

describe('archiveDecision', () => {
  it('archives directly when there is no live descendant', () => {
    expect(archiveDecision([session('p')], 'p')).toEqual({ kind: 'direct' })
    expect(archiveDecision([session('p'), session('c', { parentSessionId: 'p', archivedAt: '2026-01-02T00:00:00Z' })], 'p')).toEqual({ kind: 'direct' })
    expect(archiveDecision([], 'missing')).toEqual({ kind: 'direct' })
  })

  it('counts every depth in N and only direct children in the parent-only count', () => {
    const m = model([session('p'), session('c1', { parentSessionId: 'p' }), session('c2', { parentSessionId: 'p' }), session('g', { parentSessionId: 'c1' })])
    expect(m.total).toBe(3)
    expect(m.direct).toBe(2)
    expect(m.title).toBe("Archive 'Session p' and its 3 child Sessions?")
    expect(m.nestedLine).toBe('Includes 1 nested Session.')
  })

  it('uses singular text and no nested line for one direct child', () => {
    const m = model([session('p'), session('c', { parentSessionId: 'p' })])
    expect(m.title).toBe("Archive 'Session p' and its 1 child Session?")
    expect(m.nestedLine).toBeNull()
  })

  it('pluralises the nested line', () => {
    const m = model([session('p'), session('c', { parentSessionId: 'p' }), session('g1', { parentSessionId: 'c' }), session('g2', { parentSessionId: 'c' })])
    expect(m.nestedLine).toBe('Includes 2 nested Sessions.')
  })

  it('excludes archived descendants themselves from N but still reaches live ones below them', () => {
    const m = model([
      session('p'),
      session('c1', { parentSessionId: 'p' }),
      session('c2', { parentSessionId: 'p', archivedAt: '2026-01-02T00:00:00Z' }),
      session('g', { parentSessionId: 'c2' })
    ])
    expect(m.total).toBe(2)
    expect(m.direct).toBe(1)
  })

  it('lists running descendants, marks hidden ones and tells equal names apart by branch', () => {
    const m = model([
      session('p'),
      session('a', { parentSessionId: 'p', name: 'Same', status: 'idle', branch: 'one' }),
      session('b', { parentSessionId: 'p', name: 'Same', status: 'idle', branch: 'two', hiddenAt: '2026-01-02T00:00:00Z' }),
      session('c', { parentSessionId: 'p', name: 'Quiet', status: 'stopped' })
    ])
    expect(m.running.map((entry) => entry.label)).toEqual(['Same (one)', 'Same (two) (hidden)'])
  })
})

describe('archiveResultMessage', () => {
  const m = model([session('p'), session('c1', { parentSessionId: 'p' }), session('c2', { parentSessionId: 'p' })])

  it('names the whole subtree for Archive all', () => {
    expect(archiveResultMessage(m, true)).toBe('Archived Session p and 2 child Sessions')
  })

  it('names the children left at the top level for Archive parent only', () => {
    expect(archiveResultMessage(m, false)).toBe('Archived Session p; 2 child Sessions are now at the top level')
    expect(archiveResultMessage({ ...m, direct: 1 }, false)).toBe('Archived Session p; 1 child Session is now at the top level')
    expect(archiveResultMessage({ ...m, direct: 0 }, false)).toBe('Archived Session p')
  })
})

describe('runArchive', () => {
  it('Archive all passes includeChildren', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    await expect(runArchive(call, 'p', true)).resolves.toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('p', true)
  })

  it('Archive parent only sends the one-argument call', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    await runArchive(call, 'p', false)
    expect(call.mock.calls[0]).toEqual(['p'])
  })

  it('returns the failure message for a failed result and for a throw', async () => {
    await expect(runArchive(vi.fn().mockResolvedValue({ ok: false, error: { message: 'No' } }), 'p', true)).resolves.toEqual({ ok: false, message: 'No' })
    await expect(runArchive(vi.fn().mockRejectedValue(new Error('Boom')), 'p', false)).resolves.toEqual({ ok: false, message: 'Boom' })
  })
})
