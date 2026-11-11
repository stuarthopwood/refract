// Spec 124 FR-019, FR-021 (#1888): a mutating panel action tells Rust it is about to change files,
// changes nothing when Rust refuses, and does not wait for the follow-up reload.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_ACTION_HANDLERS, type PanelActionContext } from './agent-panel-actions'

const calls: string[] = []
const git = vi.hoisted(() => ({
  state: {
    load: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    requestShowFile: vi.fn(),
    bySession: {} as Record<string, unknown>
  }
}))

vi.mock('@/state', () => ({ useGitChangesStore: { getState: () => git.state } }))

function snapshotWith(group: 'staged' | 'changes', path: string) {
  const groups = { staged: [] as { path: string }[], changes: [] as { path: string }[], untracked: [] as { path: string }[] }
  groups[group].push({ path })
  return { s1: { snapshot: { groups } } }
}

function context(started: () => Promise<boolean>): PanelActionContext {
  return { sessionId: 's1', open: () => calls.push('open'), started }
}

function handler(panel: string, action: string) {
  const found = PANEL_ACTION_HANDLERS[panel]?.[action]
  if (!found) throw new Error(`no handler ${panel}.${action}`)
  return found
}

const stageFile = handler('git-changes', 'stage_file')
const unstageFile = handler('git-changes', 'unstage_file')

beforeEach(() => {
  calls.length = 0
  git.state.load.mockReset().mockImplementation(async () => {
    calls.push('load')
  })
  git.state.stage.mockReset().mockImplementation(async () => {
    calls.push('stage')
    return { ok: true, value: undefined }
  })
  git.state.unstage.mockReset().mockImplementation(async () => {
    calls.push('unstage')
    return { ok: true, value: undefined }
  })
  git.state.bySession = snapshotWith('changes', 'a.txt')
})

describe('stage_file', () => {
  it('signals started after the pre-action reload and before it stages, without awaiting the follow-up reload', async () => {
    const started = vi.fn(async () => {
      calls.push('started')
      return true
    })
    const outcome = await stageFile(context(started), { path: 'a.txt' })
    expect(outcome).toEqual({ ok: true, value: { path: 'a.txt', staged: true } })
    expect(calls).toEqual(['load', 'started', 'open', 'stage'])
    expect(git.state.stage).toHaveBeenCalledWith('s1', ['a.txt'], { awaitRefresh: false })
  })

  it('changes nothing and opens nothing when Rust refuses started', async () => {
    const outcome = await stageFile(context(async () => false), { path: 'a.txt' })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(git.state.stage).not.toHaveBeenCalled()
    expect(calls).not.toContain('open')
  })

  it.each([
    ['an unsafe path', { path: '../a.txt' }],
    ['a file that is not changed', { path: 'other.txt' }]
  ])('does not signal started for %s', async (_name, input) => {
    const started = vi.fn(async () => true)
    const outcome = await stageFile(context(started), input)
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(started).not.toHaveBeenCalled()
  })

  it('does not signal started for a file that is already staged', async () => {
    git.state.bySession = snapshotWith('staged', 'a.txt')
    const started = vi.fn(async () => true)
    expect(await stageFile(context(started), { path: 'a.txt' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(started).not.toHaveBeenCalled()
  })

  it('reports a git failure as action_failed', async () => {
    git.state.stage.mockResolvedValue({ ok: false, error: { code: 'git-failed', message: 'index locked' } })
    expect(await stageFile(context(async () => true), { path: 'a.txt' })).toEqual({ ok: false, code: 'action_failed', message: 'index locked' })
  })
})

describe('unstage_file', () => {
  beforeEach(() => {
    git.state.bySession = snapshotWith('staged', 'a.txt')
  })

  it('signals started before it unstages, without awaiting the follow-up reload', async () => {
    const started = vi.fn(async () => {
      calls.push('started')
      return true
    })
    const outcome = await unstageFile(context(started), { path: 'a.txt' })
    expect(outcome).toEqual({ ok: true, value: { path: 'a.txt', staged: false } })
    expect(calls).toEqual(['load', 'started', 'open', 'unstage'])
    expect(git.state.unstage).toHaveBeenCalledWith('s1', ['a.txt'], { awaitRefresh: false })
  })

  it('changes nothing when Rust refuses started', async () => {
    expect(await unstageFile(context(async () => false), { path: 'a.txt' })).toMatchObject({ ok: false, code: 'action_failed' })
    expect(git.state.unstage).not.toHaveBeenCalled()
  })
})
