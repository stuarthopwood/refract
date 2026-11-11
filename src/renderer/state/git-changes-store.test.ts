// Spec 124 FR-021 (#1888): an agent-driven stage or unstage returns once git answers; the
// follow-up reload still runs but is not awaited. The panel's own path keeps awaiting it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitChangesStore } from './git-changes-store'

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
