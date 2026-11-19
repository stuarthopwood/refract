import { describe, expect, it } from 'vitest'
import type { GitChangesFileEntry, GitChangesSnapshot } from '../../../../shared/model'
import { entrySignature, findLiveEntry, isNoLongerChanged, nextDiffState, noLongerChangedAnnouncement, patchStats } from './git-diff-state'

const entry = (path: string, over: Partial<GitChangesFileEntry> = {}): GitChangesFileEntry => ({
  path,
  folder: '',
  mark: 'modified',
  additions: 1,
  deletions: 2,
  partial: false,
  ...over
})

const snapshot = (groups: Partial<GitChangesSnapshot['groups']>): GitChangesSnapshot => ({
  header: { branch: 'main', baseBranch: 'main', aheadBehind: null },
  groups: { conflicts: [], staged: [], changes: [], untracked: [], ...groups }
})

describe('isNoLongerChanged', () => {
  it('is false until a snapshot has loaded', () => {
    expect(isNoLongerChanged(null, 'changes', 'a.ts')).toBe(false)
    expect(isNoLongerChanged(undefined, 'changes', 'a.ts')).toBe(false)
  })

  it('is false while the file is still in its group', () => {
    expect(isNoLongerChanged(snapshot({ changes: [entry('a.ts')] }), 'changes', 'a.ts')).toBe(false)
  })

  it('is true when the file left its group, even if it moved to another one', () => {
    expect(isNoLongerChanged(snapshot({ staged: [entry('a.ts')] }), 'changes', 'a.ts')).toBe(true)
    expect(isNoLongerChanged(snapshot({}), 'changes', 'a.ts')).toBe(true)
  })
})

describe('findLiveEntry', () => {
  it('matches by group and path only', () => {
    const live = entry('a.ts')
    expect(findLiveEntry(snapshot({ changes: [live] }), 'changes', 'a.ts')).toBe(live)
    expect(findLiveEntry(snapshot({ changes: [live] }), 'staged', 'a.ts')).toBeNull()
    expect(findLiveEntry(null, 'changes', 'a.ts')).toBeNull()
  })
})

describe('entrySignature', () => {
  it('changes when the stat or mark changes and is stable otherwise', () => {
    expect(entrySignature(entry('a.ts'))).toBe(entrySignature(entry('a.ts')))
    expect(entrySignature(entry('a.ts'))).not.toBe(entrySignature(entry('a.ts', { additions: 5 })))
    expect(entrySignature(entry('a.ts'))).not.toBe(entrySignature(entry('a.ts', { partial: true })))
    expect(entrySignature(null)).toBe('unknown')
  })
})

describe('nextDiffState', () => {
  const ok = (patch: string, reason: string | null = null) => ({ ok: true as const, value: { patch, reason } })

  it('keeps the same object for an identical patch', () => {
    const first = nextDiffState('loading', ok('@@ -1 +1 @@'))
    expect(nextDiffState(first, ok('@@ -1 +1 @@'))).toBe(first)
  })

  it('replaces the state when the patch or the reason differs', () => {
    const first = nextDiffState('loading', ok('a'))
    expect(nextDiffState(first, ok('b'))).toEqual({ patch: 'b', reason: null })
    expect(nextDiffState(first, ok('a', 'binary file'))).toEqual({ patch: 'a', reason: 'binary file' })
  })

  it('reports an error result', () => {
    expect(nextDiffState('loading', { ok: false, error: { code: 'x', message: 'boom' } as never })).toEqual({ error: 'boom' })
  })
})

describe('patchStats', () => {
  it('counts added and removed lines', () => {
    expect(patchStats('@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+more\n\\ No newline at end of file')).toEqual({ additions: 2, deletions: 1 })
    expect(patchStats('')).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('noLongerChangedAnnouncement', () => {
  it('names the file by its last segment', () => {
    expect(noLongerChangedAnnouncement('src/a/Button.tsx')).toBe('No longer changed: Button.tsx')
  })
})
