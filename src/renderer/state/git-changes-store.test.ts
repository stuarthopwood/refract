// Spec 124 FR-021 (#1888): an agent-driven stage or unstage returns once git answers; the
// follow-up reload still runs but is not awaited. The panel's own path keeps awaiting it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUP_OPEN, useGitChangesStore } from './git-changes-store'

const never = new Promise<never>(() => {})
const list = vi.fn()
const stage = vi.fn()

beforeEach(() => {
  useGitChangesStore.setState({ bySession: {} })
  list.mockReset().mockReturnValue(never)
  stage.mockReset().mockResolvedValue({ ok: true, value: undefined })
  ;(globalThis as unknown as { window: unknown }).window = { refract: { gitChanges: { list, stage } } }
})

describe('useGitChangesStore.stage', () => {
  // The reload in flight is module state keyed by Session, so each test uses its own.
  it('returns without waiting for the reload when awaitRefresh is false, and still starts it', async () => {
    const result = await useGitChangesStore.getState().stage('no-wait', ['a.txt'], { awaitRefresh: false })
    expect(result.ok).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('waits for the reload by default', async () => {
    let release: (value: unknown) => void = () => {}
    list.mockReturnValue(new Promise((resolve) => (release = resolve)))
    let settled = false
    const pending = useGitChangesStore.getState().stage('waits', ['a.txt']).then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release({ ok: true, value: { snapshot: null } })
    await pending
    expect(settled).toBe(true)
  })
})

// #2075 FR-028: switching tabs unmounts the panel, whose last-watcher cleanup calls `forgetSession`.
describe('useGitChangesStore group open state', () => {
  beforeEach(() => useGitChangesStore.setState({ groupOpenBySession: {}, commitDraftsBySession: {} }))

  it('starts every group open', () => {
    expect(useGitChangesStore.getState().groupOpenBySession.s1 ?? DEFAULT_GROUP_OPEN).toEqual({ conflicts: true, staged: true, changes: true, untracked: true })
  })

  it('keeps a collapsed group across a panel unmount and remount', () => {
    useGitChangesStore.getState().setGroupOpen('s1', 'staged', false)
    useGitChangesStore.getState().forgetSession('s1')
    expect(useGitChangesStore.getState().groupOpenBySession.s1).toEqual({ ...DEFAULT_GROUP_OPEN, staged: false })
  })

  it('keeps each Session apart', () => {
    useGitChangesStore.getState().setGroupOpen('s1', 'staged', false)
    expect(useGitChangesStore.getState().groupOpenBySession.s2).toBeUndefined()
  })

  it('does not touch the shared default when a group changes', () => {
    useGitChangesStore.getState().setGroupOpen('s1', 'changes', false)
    expect(DEFAULT_GROUP_OPEN.changes).toBe(true)
  })

  it('prunes group state and commit drafts of Sessions not kept, and returns the same state when nothing goes', () => {
    useGitChangesStore.getState().setGroupOpen('keep', 'staged', false)
    useGitChangesStore.getState().setGroupOpen('gone', 'staged', false)
    useGitChangesStore.getState().setCommitDraft('gone', { subject: 's', body: 'b' })
    useGitChangesStore.getState().pruneSessionUi(new Set(['keep']))
    expect(Object.keys(useGitChangesStore.getState().groupOpenBySession)).toEqual(['keep'])
    expect(useGitChangesStore.getState().commitDraftsBySession).toEqual({})
    const before = useGitChangesStore.getState()
    before.pruneSessionUi(new Set(['keep']))
    expect(useGitChangesStore.getState()).toBe(before)
  })
})
